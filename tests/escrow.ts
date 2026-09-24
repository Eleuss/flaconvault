/**
 * Integration tests for programs/escrow (briefing §11, demo scene 6) against the local
 * validator with programs/flacon. Runs first alphabetically; sets the flacon registry up
 * idempotently (tests/lib/flacon.ts) and uses fresh random passports so it never collides
 * with tests/flacon.ts.
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import type { Escrow } from "../target/types/escrow";
import type { Flacon } from "../target/types/flacon";
import {
  createMint,
  ensureAta,
  mintTo,
  TOKEN_PROGRAM_ID,
  tokenBalance,
} from "../scripts/lib/spl";
import {
  ROOT,
  airdrop,
  ensureRegistry,
  enums,
  expectAnchorError,
  mintPassportWithSeal,
  recordScan,
  type PassportHandle,
  type RegistryHandle,
} from "./lib/flacon";

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// mirrors programs/escrow/src/constants.rs (asserted against the IDL below)
const S = {
  LISTED: 0,
  RESERVED: 1,
  PRESHIP_SCANNED: 2,
  SHIPPED: 3,
  RECEIPT_SCANNED: 4,
  RELEASED: 5,
  MISMATCH: 6,
  DISPUTE: 7,
  CANCELLED: 8,
};

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const flacon = anchor.workspace.flacon as Program<Flacon>;
  const escrow = anchor.workspace.escrow as Program<Escrow>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // seller + admin + registry partner
  const wallet = payer.publicKey;
  const buyer = Keypair.generate();
  const idlErrors = (escrow.idl.errors ?? []) as { code: number; name: string }[];

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], escrow.programId);
  const orderPdaOf = (passport: PublicKey, seller: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("order"), passport.toBuffer(), seller.toBuffer()], escrow.programId)[0];
  const vaultPdaOf = (order: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), order.toBuffer()], escrow.programId)[0];

  let reg: RegistryHandle;
  let mint: PublicKey;
  let sellerAta: PublicKey;
  let buyerAta: PublicKey;
  let previousWindow: number | null = null;
  const PRICE = USDC(480);

  // ---- flow helpers --------------------------------------------------------

  const newPassport = () => mintPassportWithSeal(flacon, reg.registryPda, wallet);

  async function list(p: PassportHandle, price = PRICE): Promise<PublicKey> {
    const order = orderPdaOf(p.passportPda, wallet);
    await escrow.methods
      .list(new BN(price.toString()))
      .accountsStrict({ config: configPda, passport: p.passportPda, order, seller: wallet, systemProgram: SystemProgram.programId })
      .rpc();
    return order;
  }
  const reserveBuilder = (order: PublicKey) =>
    escrow.methods
      .reserve()
      .accountsStrict({
        config: configPda,
        order,
        buyer: buyer.publicKey,
        buyerToken: buyerAta,
        usdcMint: mint,
        vault: vaultPdaOf(order),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer]);
  const preShipBuilder = (order: PublicKey, scanProof: PublicKey, seal: PublicKey, seller: Keypair = payer) =>
    escrow.methods.recordPreShipScan().accountsStrict({ order, seller: seller.publicKey, scanProof, seal }).signers(seller === payer ? [] : [seller]);
  const ship = (order: PublicKey) => escrow.methods.ship().accountsStrict({ order, seller: wallet }).rpc();
  const receipt = (order: PublicKey, scanProof: PublicKey, seal: PublicKey, sellerScan: PublicKey) =>
    escrow.methods
      .recordReceiptScan()
      .accountsStrict({ order, buyer: buyer.publicKey, scanProof, seal, sellerScan })
      .signers([buyer])
      .rpc();
  const releaseBuilder = (order: PublicKey, extra: { asset?: PublicKey } = {}) =>
    escrow.methods.release().accountsStrict({
      config: configPda,
      order,
      vault: vaultPdaOf(order),
      sellerToken: sellerAta,
      buyer: buyer.publicKey,
      caller: wallet,
      asset: extra.asset ?? null,
      mplCoreProgram: extra.asset ? MPL_CORE : null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });
  const disputeBuilder = (order: PublicKey, signer: Keypair, opts: { seal?: PublicKey; asset?: PublicKey } = {}) =>
    escrow.methods
      .dispute()
      .accountsStrict({
        config: configPda,
        order,
        vault: vaultPdaOf(order),
        buyerToken: buyerAta,
        buyer: buyer.publicKey,
        seller: wallet,
        signer: signer.publicKey,
        seal: opts.seal ?? null,
        asset: opts.asset ?? null,
        mplCoreProgram: opts.asset ? MPL_CORE : null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(signer === payer ? [] : [signer]);
  const order = (pda: PublicKey) => escrow.account.order.fetch(pda);

  /** list → reserve → seller scan → pre-ship → ship; returns handles. */
  async function upToShipped(p: PassportHandle, sellerFill = 92) {
    const o = await list(p);
    await reserveBuilder(o).rpc();
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: sellerFill });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    await ship(o);
    return { o, sellerScan };
  }

  // ---- setup ---------------------------------------------------------------

  before(async () => {
    reg = await ensureRegistry(flacon, wallet);
    await airdrop(provider, buyer.publicKey, 2);

    const cfg = await escrow.account.escrowConfig.fetchNullable(configPda);
    if (!cfg) {
      mint = await createMint(connection, payer, wallet, 6);
      await escrow.methods
        .initConfig(new BN(1))
        .accountsStrict({ config: configPda, admin: wallet, usdcMint: mint, systemProgram: SystemProgram.programId })
        .rpc();
    } else {
      mint = cfg.usdcMint; // seeded validator: wallet must be the mint authority (scripts/seed-escrow.ts)
      previousWindow = cfg.disputeAfterS.toNumber();
      if (previousWindow !== 1) {
        await escrow.methods.setDisputeWindow(new BN(1)).accountsStrict({ config: configPda, admin: wallet }).rpc();
      }
    }
    sellerAta = await ensureAta(connection, payer, wallet, mint);
    buyerAta = await ensureAta(connection, payer, buyer.publicKey, mint);
    await mintTo(connection, payer, mint, buyerAta, payer, USDC(10_000));
  });

  after(async () => {
    // leave a shared validator with the production default (7 days) or whatever it had before
    const restoreTo = previousWindow ?? 7 * 86400;
    if (restoreTo !== 1) {
      await escrow.methods.setDisputeWindow(new BN(restoreTo)).accountsStrict({ config: configPda, admin: wallet }).rpc();
    }
  });

  // ---- tests ---------------------------------------------------------------

  it("config: admin, mint, dispute window; non-admin cannot change it", async () => {
    const cfg = await escrow.account.escrowConfig.fetch(configPda);
    expect(cfg.admin.equals(wallet)).to.be.true;
    expect(cfg.usdcMint.equals(mint)).to.be.true;
    expect(cfg.disputeAfterS.toNumber()).to.equal(1);
    await expectAnchorError(
      escrow.methods.setDisputeWindow(new BN(5)).accountsStrict({ config: configPda, admin: buyer.publicKey }).signers([buyer]).rpc(),
      "Unauthorized",
      idlErrors
    );
    await expectAnchorError(
      escrow.methods.setDisputeWindow(new BN(0)).accountsStrict({ config: configPda, admin: wallet }).rpc(),
      "InvalidDisputeWindow",
      idlErrors
    );
  });

  it("happy path: list → reserve → pre-ship scan → ship → receipt scan (match) → release", async () => {
    const p = await newPassport();
    const buyerBefore = await tokenBalance(connection, buyerAta);
    const sellerBefore = await tokenBalance(connection, sellerAta);

    const o = await list(p);
    let ord = await order(o);
    expect(ord.passport.equals(p.passportPda)).to.be.true;
    expect(ord.seller.equals(wallet)).to.be.true;
    expect(ord.buyer.equals(PublicKey.default)).to.be.true;
    expect(ord.asset.equals(p.asset)).to.be.true;
    expect(ord.price.toString()).to.equal(PRICE.toString());
    expect(ord.state).to.equal(S.LISTED);
    expect(ord.disputeAfterS.toNumber()).to.equal(1);
    expect(ord.listedAt.toNumber()).to.be.greaterThan(0);
    expect(ord.assetDeposited).to.be.false;

    await reserveBuilder(o).rpc();
    ord = await order(o);
    expect(ord.state).to.equal(S.RESERVED);
    expect(ord.buyer.equals(buyer.publicKey)).to.be.true;
    expect(ord.reservedAt.toNumber()).to.be.greaterThan(0);
    expect((await tokenBalance(connection, vaultPdaOf(o))).toString()).to.equal(PRICE.toString());
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal((buyerBefore - PRICE).toString());

    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 92, role: enums.role.SELLER });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    ord = await order(o);
    expect(ord.state).to.equal(S.PRESHIP_SCANNED);
    expect(ord.sellerScan.equals(sellerScan)).to.be.true;

    await ship(o);
    ord = await order(o);
    expect(ord.state).to.equal(S.SHIPPED);
    expect(ord.shippedAt.toNumber()).to.be.greaterThan(0);

    const buyerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 90, role: enums.role.BUYER, attester: buyer });
    await receipt(o, buyerScan, p.sealPda, sellerScan);
    ord = await order(o);
    expect(ord.state).to.equal(S.RECEIPT_SCANNED);
    expect(ord.buyerScan.equals(buyerScan)).to.be.true;

    await releaseBuilder(o).rpc();
    ord = await order(o);
    expect(ord.state).to.equal(S.RELEASED);
    expect((await tokenBalance(connection, sellerAta)).toString()).to.equal((sellerBefore + PRICE).toString());
    expect(await connection.getAccountInfo(vaultPdaOf(o)), "vault closed").to.be.null;
  });

  it("guards: release before receipt, reserve twice, pre-ship by non-seller / wrong attester, cancel when funded", async () => {
    const p = await newPassport();
    const o = await list(p);
    await reserveBuilder(o).rpc();

    await expectAnchorError(releaseBuilder(o).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(reserveBuilder(o).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(
      escrow.methods.cancel().accountsStrict({ order: o, seller: wallet, asset: null, mplCoreProgram: null, systemProgram: SystemProgram.programId }).rpc(),
      "InvalidState",
      idlErrors
    );

    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 92 });
    const buyerScanEarly = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 92, role: enums.role.BUYER, attester: buyer });
    // buyer pretending to be the seller
    await expectAnchorError(preShipBuilder(o, buyerScanEarly, p.sealPda, buyer).rpc(), "NotSeller", idlErrors);
    // seller submitting a scan attested by someone else
    await expectAnchorError(preShipBuilder(o, buyerScanEarly, p.sealPda).rpc(), "ScanAttesterMismatch", idlErrors);
    // scan from another passport's seal
    const other = await newPassport();
    const otherScan = await recordScan(flacon, provider, reg, other, { counter: 1, fill: 92 });
    await expectAnchorError(preShipBuilder(o, otherScan, other.sealPda).rpc(), "SealPassportMismatch", idlErrors);
    await expectAnchorError(preShipBuilder(o, otherScan, p.sealPda).rpc(), "ScanSealMismatch", idlErrors);

    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    // receipt before ship
    await expectAnchorError(receipt(o, buyerScanEarly, p.sealPda, sellerScan), "InvalidState", idlErrors);
    await ship(o);
    // receipt scan on the same seal must be newer than the pre-ship scan (counter 2 > 1 ok, but wrong seller_scan account)
    await expectAnchorError(receipt(o, buyerScanEarly, p.sealPda, buyerScanEarly), "SellerScanMismatch", idlErrors);
    await receipt(o, buyerScanEarly, p.sealPda, sellerScan);
    expect((await order(o)).state).to.equal(S.RECEIPT_SCANNED);
    await releaseBuilder(o).rpc();
    expect((await order(o)).state).to.equal(S.RELEASED);
  });

  it("mismatch path: buyer fill 80 vs seller 92 → MISMATCH → buyer dispute (refund)", async () => {
    const p = await newPassport();
    const buyerBefore = await tokenBalance(connection, buyerAta);
    const { o, sellerScan } = await upToShipped(p, 92);
    const buyerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 80, role: enums.role.BUYER, attester: buyer });
    await receipt(o, buyerScan, p.sealPda, sellerScan);
    expect((await order(o)).state).to.equal(S.MISMATCH);
    await expectAnchorError(releaseBuilder(o).rpc(), "InvalidState", idlErrors);

    await disputeBuilder(o, buyer).rpc();
    const ord = await order(o);
    expect(ord.state).to.equal(S.DISPUTE);
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal(buyerBefore.toString());
    expect(await connection.getAccountInfo(vaultPdaOf(o))).to.be.null;
  });

  it("fill tolerance: 87 vs 92 (Δ5) matches, 86 (Δ6) does not; heat mismatch does not match", async () => {
    const a = await newPassport();
    const ra = await upToShipped(a, 92);
    const sa = await recordScan(flacon, provider, reg, a, { counter: 2, fill: 87, role: enums.role.BUYER, attester: buyer });
    await receipt(ra.o, sa, a.sealPda, ra.sellerScan);
    expect((await order(ra.o)).state).to.equal(S.RECEIPT_SCANNED);
    await releaseBuilder(ra.o).rpc();

    const b = await newPassport();
    const rb = await upToShipped(b, 92);
    const sb = await recordScan(flacon, provider, reg, b, { counter: 2, fill: 86, role: enums.role.BUYER, attester: buyer });
    await receipt(rb.o, sb, b.sealPda, rb.sellerScan);
    expect((await order(rb.o)).state).to.equal(S.MISMATCH);
    await disputeBuilder(rb.o, buyer).rpc();

    const c = await newPassport();
    const rc = await upToShipped(c, 92);
    const sc = await recordScan(flacon, provider, reg, c, {
      counter: 2,
      fill: 92,
      role: enums.role.BUYER,
      attester: buyer,
      heat: enums.indicator.TRIGGERED,
      heatLevels: 0b011111,
    });
    await receipt(rc.o, sc, c.sealPda, rc.sellerScan);
    expect((await order(rc.o)).state).to.equal(S.MISMATCH);
    await disputeBuilder(rc.o, payer).rpc(); // admin refund from MISMATCH
    expect((await order(rc.o)).state).to.equal(S.DISPUTE);
  });

  it("timeout path: buyer may dispute only after shipped_at + dispute_after_s (1 s)", async () => {
    const p = await newPassport();
    const buyerBefore = await tokenBalance(connection, buyerAta);
    const { o } = await upToShipped(p);
    await expectAnchorError(disputeBuilder(o, buyer).rpc(), "DisputeWindowNotElapsed", idlErrors);
    await sleep(2500);
    await disputeBuilder(o, buyer).rpc();
    expect((await order(o)).state).to.equal(S.DISPUTE);
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal(buyerBefore.toString());
  });

  it("dead seal: buyer may dispute a funded order once flacon marks the seal dead", async () => {
    const p = await newPassport();
    const o = await list(p);
    await reserveBuilder(o).rpc();
    await expectAnchorError(disputeBuilder(o, buyer, { seal: p.sealPda }).rpc(), "SealNotDead", idlErrors);
    // a stranger can never dispute
    const stranger = Keypair.generate();
    await airdrop(provider, stranger.publicKey, 1);
    await expectAnchorError(disputeBuilder(o, stranger).rpc(), "Unauthorized", idlErrors);

    await flacon.methods
      .markSealDead()
      .accountsStrict({ registry: reg.registryPda, passport: p.passportPda, seal: p.sealPda, signer: wallet })
      .rpc();
    await disputeBuilder(o, buyer, { seal: p.sealPda }).rpc();
    expect((await order(o)).state).to.equal(S.DISPUTE);
    // a void passport can no longer be listed
    const o2 = orderPdaOf(p.passportPda, wallet);
    await escrow.methods.closeOrder().accountsStrict({ order: o2, seller: wallet }).rpc();
    await expectAnchorError(list(p), "PassportVoid", idlErrors);
  });

  it("cancel → CANCELLED, close_order, re-list, admin dispute from RESERVED", async () => {
    const p = await newPassport();
    const o = await list(p);
    await expectAnchorError(
      escrow.methods.closeOrder().accountsStrict({ order: o, seller: wallet }).rpc(),
      "InvalidState",
      idlErrors
    );
    await escrow.methods
      .cancel()
      .accountsStrict({ order: o, seller: wallet, asset: null, mplCoreProgram: null, systemProgram: SystemProgram.programId })
      .rpc();
    expect((await order(o)).state).to.equal(S.CANCELLED);
    await expectAnchorError(reserveBuilder(o).rpc(), "InvalidState", idlErrors);
    await escrow.methods.closeOrder().accountsStrict({ order: o, seller: wallet }).rpc();
    expect(await connection.getAccountInfo(o)).to.be.null;

    // re-list the same passport
    const o2 = await list(p, USDC(500));
    expect(o2.equals(o)).to.be.true;
    expect((await order(o2)).state).to.equal(S.LISTED);
    await reserveBuilder(o2).rpc();
    const buyerAfterReserve = await tokenBalance(connection, buyerAta);
    await disputeBuilder(o2, payer).rpc(); // admin
    expect((await order(o2)).state).to.equal(S.DISPUTE);
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal((buyerAfterReserve + USDC(500)).toString());
    await escrow.methods.closeOrder().accountsStrict({ order: o2, seller: wallet }).rpc();
  });

  it("IDL constants: order states, dispute reasons, tolerance, default window, seeds", () => {
    const consts = (escrow.rawIdl.constants ?? []) as { name: string; value: string }[];
    const v = (name: string) => {
      const c = consts.find((x) => x.name === name);
      expect(c, `constant ${name}`).to.not.be.undefined;
      return c!.value;
    };
    for (const [k, val] of Object.entries(S)) expect(v(`ORDER_STATE_${k}`), k).to.equal(String(val));
    expect(v("DISPUTE_REASON_ADMIN")).to.equal("0");
    expect(v("DISPUTE_REASON_TIMEOUT")).to.equal("1");
    expect(v("DISPUTE_REASON_SEAL_DEAD")).to.equal("2");
    expect(v("DISPUTE_REASON_MISMATCH")).to.equal("3");
    expect(v("FILL_TOLERANCE")).to.equal("5");
    expect(v("DEFAULT_DISPUTE_AFTER_S")).to.equal(String(7 * 86400));
    expect(Buffer.from(JSON.parse(v("ORDER_SEED"))).toString()).to.equal("order");
    expect(Buffer.from(JSON.parse(v("VAULT_SEED"))).toString()).to.equal("vault");
    expect(Buffer.from(JSON.parse(v("CONFIG_SEED"))).toString()).to.equal("config");
    expect(v("MPL_CORE_PROGRAM_ID")).to.equal(MPL_CORE.toBase58());
    // account sizes documented for the web app
    const idl = escrow.rawIdl as any;
    expect(idl.accounts.map((a: any) => a.name).sort()).to.deep.equal(["EscrowConfig", "Order"]);
  });

  it("Core custody (only when Metaplex Core is on the validator): deposit_asset → release transfers the asset to the buyer", async function () {
    if (!(await connection.getAccountInfo(MPL_CORE))) {
      console.log("      (skipped: Metaplex Core program not present on this validator)");
      this.skip();
    }
    let umi: any, create: any, fetchAsset: any, generateSigner: any, keypairIdentity: any, umiPublicKey: any;
    try {
      const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
      const core = await import("@metaplex-foundation/mpl-core");
      const umiLib = await import("@metaplex-foundation/umi");
      // "processed" like the Anchor env provider, otherwise owner reads lag one confirmation behind
      umi = createUmi(connection.rpcEndpoint, "processed").use(core.mplCore());
      umi.use(umiLib.keypairIdentity(umi.eddsa.createKeypairFromSecretKey(payer.secretKey)));
      ({ create, fetchAsset } = core);
      ({ generateSigner, keypairIdentity, publicKey: umiPublicKey } = umiLib);
    } catch (e) {
      console.log(`      (skipped: mpl-core JS not loadable: ${(e as Error).message})`);
      this.skip();
    }
    const assetSigner = generateSigner(umi);
    await create(umi, { asset: assetSigner, name: "FlaconVault test bottle", uri: "https://flaconvault.test/asset.json" }).sendAndConfirm(umi);
    const asset = new PublicKey(assetSigner.publicKey.toString());
    expect((await fetchAsset(umi, assetSigner.publicKey)).owner.toString()).to.equal(wallet.toBase58());

    const p = await mintPassportWithSeal(flacon, reg.registryPda, wallet, { asset });
    const o = await list(p);
    const depositSig = await escrow.methods
      .depositAsset()
      .accountsStrict({ order: o, seller: wallet, asset, mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId })
      .rpc();
    await connection.confirmTransaction(depositSig, "confirmed");
    expect((await order(o)).assetDeposited).to.be.true;
    expect((await fetchAsset(umi, assetSigner.publicKey)).owner.toString()).to.equal(o.toBase58());
    await expectAnchorError(
      escrow.methods.depositAsset().accountsStrict({ order: o, seller: wallet, asset, mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).rpc(),
      "AssetAlreadyDeposited",
      idlErrors
    );

    await reserveBuilder(o).rpc();
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 95 });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    await ship(o);
    const buyerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 95, role: enums.role.BUYER, attester: buyer });
    await receipt(o, buyerScan, p.sealPda, sellerScan);
    // release without the asset accounts must fail, with them the buyer becomes the owner
    await expectAnchorError(releaseBuilder(o).rpc(), "MissingAssetAccounts", idlErrors);
    const releaseSig = await releaseBuilder(o, { asset }).rpc();
    await connection.confirmTransaction(releaseSig, "confirmed");
    expect((await order(o)).state).to.equal(S.RELEASED);
    expect((await order(o)).assetDeposited).to.be.false;
    expect((await fetchAsset(umi, assetSigner.publicKey)).owner.toString()).to.equal(buyer.publicKey.toBase58());
  });
});
