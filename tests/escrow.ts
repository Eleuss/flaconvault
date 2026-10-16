/**
 * Integration tests for programs/escrow (briefing §11, demo scene 6) against the local
 * validator with programs/flacon. Sets the flacon registry up idempotently (tests/lib/flacon.ts)
 * and uses fresh random passports (each with a real Metaplex Core asset) so it never collides
 * with tests/flacon.ts.
 *
 * Windows: the dispute window is bounded to 1 h ..= 60 days and this validator cannot move its clock, so
 * the branches that need the window to have passed (buyer refund when the seller never ships,
 * release_after_timeout) run in programs/escrow/tests/time_travel.rs (LiteSVM with a Clock override,
 * scripts/test-escrow-time-travel.sh); here only their "not yet" side runs on chain.
 *
 * The payout test for a seller without a USDC account sends the web app's own builders
 * (apps/web/src/lib/escrow-ix.ts), so dropping their create-ATA pre-instruction fails here.
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import type { Escrow } from "../target/types/escrow";
import type { Flacon } from "../target/types/flacon";
import { createAtaIdempotentIx, createMint, ensureAta, mintTo, TOKEN_PROGRAM_ID, tokenBalance, ataAddress } from "../scripts/lib/spl";
import { MPL_CORE_PROGRAM_ID as MPL_CORE, fetchCoreAsset } from "../scripts/lib/core";
import { escrowIx as webEscrowIx, type IxOrder } from "../apps/web/src/lib/escrow-ix";
import {
  airdrop,
  burnCoreAsset,
  chainTime,
  createCoreAsset,
  ensureRegistry,
  enums,
  expectAnchorError,
  mintPassportWithSeal,
  programDataOf,
  recordScan,
  transferCoreAsset,
  waitForChainTime,
  type PassportHandle,
  type RegistryHandle,
} from "./lib/flacon";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const HOUR = 3600;
const DAY = 86400;

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
  const payer = (provider.wallet as anchor.Wallet).payer; // seller + admin + registry partner + issuer
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

  /** passport PDA → its Core asset (reserve passes the order's asset) */
  const assetOf = new Map<string, PublicKey>();
  const track = (p: PassportHandle) => { assetOf.set(p.passportPda.toBase58(), p.asset); return p; };
  const newPassport = async (opts: Parameters<typeof mintPassportWithSeal>[3] = {}) => track(await mintPassportWithSeal(flacon, reg.registryPda, wallet, opts));

  const listBuilder = (p: PassportHandle, price = PRICE, seller: Keypair = payer, asset: PublicKey = p.asset) => {
    const b = escrow.methods.list(new BN(price.toString())).accountsStrict({
      config: configPda,
      passport: p.passportPda,
      order: orderPdaOf(p.passportPda, seller.publicKey),
      seller: seller.publicKey,
      systemProgram: SystemProgram.programId,
      asset,
      registry: reg.registryPda,
    });
    return seller === payer ? b : b.signers([seller]);
  };
  async function list(p: PassportHandle, price = PRICE): Promise<PublicKey> {
    await listBuilder(p, price).rpc();
    return orderPdaOf(p.passportPda, wallet);
  }
  const reserveBuilder = (order: PublicKey, passport: PublicKey, expectedPrice: bigint = PRICE, who: Keypair = buyer, asset?: PublicKey) =>
    escrow.methods
      .reserve(new BN(expectedPrice.toString()))
      .accountsStrict({
        config: configPda,
        order,
        buyer: who.publicKey,
        buyerToken: ataAddress(who.publicKey, mint),
        usdcMint: mint,
        vault: vaultPdaOf(order),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        passport,
        asset: asset ?? assetOf.get(passport.toBase58())!,
        registry: reg.registryPda,
      })
      .signers([who]);
  const preShipBuilder = (order: PublicKey, scanProof: PublicKey, seal: PublicKey, seller: Keypair = payer) =>
    escrow.methods.recordPreShipScan().accountsStrict({ order, seller: seller.publicKey, scanProof, seal }).signers(seller === payer ? [] : [seller]);
  const ship = (order: PublicKey, seller: Keypair = payer) =>
    escrow.methods.ship().accountsStrict({ order, seller: seller.publicKey }).signers(seller === payer ? [] : [seller]).rpc();
  const receipt = (order: PublicKey, scanProof: PublicKey, seal: PublicKey, sellerScan: PublicKey) =>
    escrow.methods
      .recordReceiptScan()
      .accountsStrict({ order, buyer: buyer.publicKey, scanProof, seal, sellerScan })
      .signers([buyer])
      .rpc();
  const releaseAccounts = (order: PublicKey, extra: { asset?: PublicKey; sellerToken?: PublicKey } = {}) => ({
    config: configPda,
    order,
    vault: vaultPdaOf(order),
    sellerToken: extra.sellerToken ?? sellerAta,
    buyer: buyer.publicKey,
    caller: wallet,
    asset: extra.asset ?? null,
    mplCoreProgram: extra.asset ? MPL_CORE : null,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
  const releaseBuilder = (order: PublicKey, extra: { asset?: PublicKey; sellerToken?: PublicKey } = {}) =>
    escrow.methods.release().accountsStrict(releaseAccounts(order, extra));
  const releaseAfterTimeoutBuilder = (order: PublicKey) => escrow.methods.releaseAfterTimeout().accountsStrict(releaseAccounts(order));
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
  const resolveBuilder = (order: PublicKey, toSeller: boolean, opts: { admin?: Keypair; recipientToken?: PublicKey } = {}) => {
    const admin = opts.admin ?? payer;
    const b = escrow.methods.resolve(toSeller).accountsStrict({
      config: configPda,
      order,
      vault: vaultPdaOf(order),
      recipientToken: opts.recipientToken ?? (toSeller ? sellerAta : buyerAta),
      buyer: buyer.publicKey,
      seller: wallet,
      admin: admin.publicKey,
      asset: null,
      mplCoreProgram: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });
    return admin === payer ? b : b.signers([admin]);
  };
  const markSealDead = (p: PassportHandle) =>
    flacon.methods.markSealDead().accountsStrict({ registry: reg.registryPda, passport: p.passportPda, seal: p.sealPda, signer: wallet }).rpc();
  const order = (pda: PublicKey) => escrow.account.order.fetch(pda);

  /** list → reserve → seller scan → pre-ship → ship; returns handles. */
  async function upToShipped(p: PassportHandle, sellerFill = 92) {
    const o = await list(p);
    await reserveBuilder(o, p.passportPda).rpc();
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: sellerFill });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    await ship(o);
    return { o, sellerScan };
  }
  /** upToShipped + a buyer receipt scan with the given fill → RECEIPT_SCANNED or MISMATCH. */
  async function upToReceipt(p: PassportHandle, sellerFill: number, buyerFill: number, extra: { heat?: number; heatLevels?: number } = {}) {
    const r = await upToShipped(p, sellerFill);
    const buyerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: buyerFill, role: enums.role.BUYER, attester: buyer, ...extra });
    await receipt(r.o, buyerScan, p.sealPda, r.sellerScan);
    return { ...r, buyerScan };
  }

  // ---- setup ---------------------------------------------------------------

  before(async () => {
    reg = await ensureRegistry(flacon, wallet);
    await airdrop(provider, buyer.publicKey, 2);

    const cfg = await escrow.account.escrowConfig.fetchNullable(configPda);
    if (!cfg) {
      mint = await createMint(connection, payer, wallet, 6);
      await escrow.methods
        .initConfig(new BN(HOUR))
        .accountsStrict({
          config: configPda,
          admin: wallet,
          usdcMint: mint,
          systemProgram: SystemProgram.programId,
          program: escrow.programId,
          programData: programDataOf(escrow.programId),
        })
        .rpc();
    } else {
      mint = cfg.usdcMint; // seeded validator: wallet must be the mint authority (scripts/seed-escrow.ts)
      previousWindow = cfg.disputeAfterS.toNumber();
      if (previousWindow !== HOUR) {
        await escrow.methods.setDisputeWindow(new BN(HOUR)).accountsStrict({ config: configPda, admin: wallet }).rpc();
      }
    }
    sellerAta = await ensureAta(connection, payer, wallet, mint);
    buyerAta = await ensureAta(connection, payer, buyer.publicKey, mint);
    await mintTo(connection, payer, mint, buyerAta, payer, USDC(20_000));
  });

  after(async () => {
    // leave a shared validator with the production default (7 days) or whatever it had before
    const restoreTo = previousWindow ?? 7 * DAY;
    if (restoreTo !== HOUR) {
      await escrow.methods.setDisputeWindow(new BN(restoreTo)).accountsStrict({ config: configPda, admin: wallet }).rpc();
    }
  });

  // ---- tests ---------------------------------------------------------------

  it("config: admin, mint, dispute window bounded to 1 h ..= 60 days; non-admin cannot change it", async () => {
    const cfg = await escrow.account.escrowConfig.fetch(configPda);
    expect(cfg.admin.equals(wallet)).to.be.true;
    expect(cfg.usdcMint.equals(mint)).to.be.true;
    expect(cfg.disputeAfterS.toNumber()).to.equal(HOUR);
    await expectAnchorError(
      escrow.methods.setDisputeWindow(new BN(2 * HOUR)).accountsStrict({ config: configPda, admin: buyer.publicKey }).signers([buyer]).rpc(),
      "Unauthorized",
      idlErrors
    );
    for (const bad of [0, 1, HOUR - 1, 60 * DAY + 1]) {
      await expectAnchorError(
        escrow.methods.setDisputeWindow(new BN(bad)).accountsStrict({ config: configPda, admin: wallet }).rpc(),
        "InvalidDisputeWindow",
        idlErrors
      );
    }
    await escrow.methods.setDisputeWindow(new BN(60 * DAY)).accountsStrict({ config: configPda, admin: wallet }).rpc();
    await escrow.methods.setDisputeWindow(new BN(HOUR)).accountsStrict({ config: configPda, admin: wallet }).rpc();
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
    expect(ord.disputeAfterS.toNumber()).to.equal(HOUR);
    expect(ord.listedAt.toNumber()).to.be.greaterThan(0);
    expect(ord.assetDeposited).to.be.false;

    await reserveBuilder(o, p.passportPda).rpc();
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

  it("list: only the owner of the Core asset may list; wrong asset account and void passports are refused", async () => {
    const p = await newPassport(); // asset owned by the wallet (= issuer)
    // a stranger (the buyer key) lists someone else's bottle
    await expectAnchorError(listBuilder(p, PRICE, buyer).rpc(), "NotPassportOwner", idlErrors);
    // the asset account must be the passport's asset
    const other = await createCoreAsset(connection, payer);
    await expectAnchorError(listBuilder(p, PRICE, payer, other).rpc(), "AssetMismatch", idlErrors);
    await expectAnchorError(listBuilder(p, 0n).rpc(), "InvalidPrice", idlErrors);

    // passport whose Core asset the issuer (wallet) gave to the buyer: the issuer may not list any more, the owner may
    const q = await newPassport();
    await transferCoreAsset(connection, payer, q.asset, payer, buyer.publicKey);
    await expectAnchorError(listBuilder(q).rpc(), "NotPassportOwner", idlErrors);
    await listBuilder(q, PRICE, buyer).rpc();
    const oq = await order(orderPdaOf(q.passportPda, buyer.publicKey));
    expect(oq.seller.equals(buyer.publicKey)).to.be.true;

    // void passport
    await markSealDead(p);
    await expectAnchorError(listBuilder(p).rpc(), "PassportVoid", idlErrors);
  });

  it("reserve: expected price must match; a passport voided after listing cannot be bought", async () => {
    const p = await newPassport();
    const o = await list(p);
    await expectAnchorError(reserveBuilder(o, p.passportPda, PRICE - 1n).rpc(), "PriceChanged", idlErrors);
    await expectAnchorError(reserveBuilder(o, p.passportPda, PRICE + 1n).rpc(), "PriceChanged", idlErrors);
    // the passport account must be the order's passport
    const other = await newPassport();
    await expectAnchorError(reserveBuilder(o, other.passportPda).rpc(), "SealPassportMismatch", idlErrors);
    // the seller cannot buy
    await expectAnchorError(reserveBuilder(o, p.passportPda, PRICE, payer).rpc(), "SellerCannotBuy", idlErrors);

    await markSealDead(p);
    await expectAnchorError(reserveBuilder(o, p.passportPda).rpc(), "PassportVoid", idlErrors);
    expect((await order(o)).state).to.equal(S.LISTED);
  });

  it("guards: release before receipt, reserve twice, pre-ship by non-seller / wrong attester, cancel when funded", async () => {
    const p = await newPassport();
    const o = await list(p);
    await reserveBuilder(o, p.passportPda).rpc();

    await expectAnchorError(releaseBuilder(o).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(reserveBuilder(o, p.passportPda).rpc(), "InvalidState", idlErrors);
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
    // wrong seller_scan account
    await expectAnchorError(receipt(o, buyerScanEarly, p.sealPda, buyerScanEarly), "SellerScanMismatch", idlErrors);
    await receipt(o, buyerScanEarly, p.sealPda, sellerScan);
    expect((await order(o)).state).to.equal(S.RECEIPT_SCANNED);
    // a matched receipt can only be released (not timed out, not refunded)
    await expectAnchorError(releaseAfterTimeoutBuilder(o).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(disputeBuilder(o, buyer).rpc(), "ReceiptMatched", idlErrors);
    await expectAnchorError(disputeBuilder(o, payer).rpc(), "InvalidState", idlErrors);
    await releaseBuilder(o).rpc();
    expect((await order(o)).state).to.equal(S.RELEASED);
  });

  it("release creates nothing by itself: a seller token account of another owner is refused", async () => {
    const p = await newPassport();
    const { o } = await upToReceipt(p, 92, 92);
    await expectAnchorError(releaseBuilder(o, { sellerToken: buyerAta }).rpc(), "ConstraintTokenOwner", idlErrors);
    // the web prepends createAssociatedTokenAccountIdempotent for the seller; doing so here is a no-op
    const tx = new Transaction().add(createAtaIdempotentIx(wallet, wallet, mint), await releaseBuilder(o).instruction());
    await provider.sendAndConfirm(tx); // provider commitment: the receipt above may not be "confirmed" yet
    expect((await order(o)).state).to.equal(S.RELEASED);
  });

  it("mismatch: buyer fill 80 vs seller 92 → MISMATCH; no buyer refund, only the admin resolves (to the buyer)", async () => {
    const p = await newPassport();
    const buyerBefore = await tokenBalance(connection, buyerAta);
    const { o } = await upToReceipt(p, 92, 80);
    expect((await order(o)).state).to.equal(S.MISMATCH);
    await expectAnchorError(releaseBuilder(o).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(releaseAfterTimeoutBuilder(o).rpc(), "InvalidState", idlErrors);
    // the buyer can no longer refund a mismatch by themselves, the admin cannot dispute it either
    await expectAnchorError(disputeBuilder(o, buyer).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(disputeBuilder(o, payer).rpc(), "InvalidState", idlErrors);
    // resolve: admin only, recipient token must belong to the chosen party
    await expectAnchorError(resolveBuilder(o, false, { admin: buyer }).rpc(), "Unauthorized", idlErrors);
    await expectAnchorError(resolveBuilder(o, false, { recipientToken: sellerAta }).rpc(), "WrongTokenOwner", idlErrors);
    await expectAnchorError(resolveBuilder(o, true, { recipientToken: buyerAta }).rpc(), "WrongTokenOwner", idlErrors);

    await resolveBuilder(o, false).rpc();
    const ord = await order(o);
    expect(ord.state).to.equal(S.DISPUTE);
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal(buyerBefore.toString());
    expect(await connection.getAccountInfo(vaultPdaOf(o))).to.be.null;
    await expectAnchorError(resolveBuilder(o, true).rpc(), "AccountNotInitialized", idlErrors);
  });

  it("mismatch: the admin may also resolve to the seller (heat differs → MISMATCH → RELEASED)", async () => {
    const p = await newPassport();
    const sellerBefore = await tokenBalance(connection, sellerAta);
    const { o } = await upToReceipt(p, 92, 92, { heat: enums.indicator.TRIGGERED, heatLevels: 0b011111 });
    expect((await order(o)).state).to.equal(S.MISMATCH);
    await resolveBuilder(o, true).rpc();
    expect((await order(o)).state).to.equal(S.RELEASED);
    expect((await tokenBalance(connection, sellerAta)).toString()).to.equal((sellerBefore + PRICE).toString());
  });

  it("fill tolerance: 87 vs 92 (Δ5) matches, 86 (Δ6) does not", async () => {
    const a = await newPassport();
    const ra = await upToReceipt(a, 92, 87);
    expect((await order(ra.o)).state).to.equal(S.RECEIPT_SCANNED);
    await releaseBuilder(ra.o).rpc();

    const b = await newPassport();
    const rb = await upToReceipt(b, 92, 86);
    expect((await order(rb.o)).state).to.equal(S.MISMATCH);
    await resolveBuilder(rb.o, false).rpc();
  });

  it("windows: no buyer refund before reserved_at + window, none after shipping; no seller payout before shipped_at + window", async () => {
    const p = await newPassport();
    const o = await list(p);
    await reserveBuilder(o, p.passportPda).rpc();
    // seller has not shipped, but the 1 h window after the reservation is still open
    await expectAnchorError(disputeBuilder(o, buyer).rpc(), "DisputeWindowNotElapsed", idlErrors);
    await expectAnchorError(releaseAfterTimeoutBuilder(o).rpc(), "InvalidState", idlErrors);
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 92 });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    await expectAnchorError(disputeBuilder(o, buyer).rpc(), "DisputeWindowNotElapsed", idlErrors);
    await ship(o);
    // after shipping the buyer has the window to scan; a timeout then pays the seller, never the buyer
    await expectAnchorError(disputeBuilder(o, buyer).rpc(), "InvalidState", idlErrors);
    await expectAnchorError(releaseAfterTimeoutBuilder(o).rpc(), "DisputeWindowNotElapsed", idlErrors);
    // a stranger can never dispute
    const stranger = Keypair.generate();
    await airdrop(provider, stranger.publicKey, 1);
    await expectAnchorError(disputeBuilder(o, stranger).rpc(), "Unauthorized", idlErrors);
    // the admin can still refund a shipped order
    await disputeBuilder(o, payer).rpc();
    expect((await order(o)).state).to.equal(S.DISPUTE);
  });

  it("dead seal: buyer refund before shipping, but not once the receipt scan matched", async () => {
    const p = await newPassport();
    const o = await list(p);
    await reserveBuilder(o, p.passportPda).rpc();
    await expectAnchorError(disputeBuilder(o, buyer, { seal: p.sealPda }).rpc(), "SealNotDead", idlErrors);
    // a seal of another passport does not count
    const other = await newPassport();
    await markSealDead(other);
    await expectAnchorError(disputeBuilder(o, buyer, { seal: other.sealPda }).rpc(), "SealPassportMismatch", idlErrors);

    await markSealDead(p);
    await disputeBuilder(o, buyer, { seal: p.sealPda }).rpc();
    expect((await order(o)).state).to.equal(S.DISPUTE);
    // a void passport can no longer be listed
    await escrow.methods.closeOrder().accountsStrict({ order: o, seller: wallet }).rpc();
    await expectAnchorError(list(p), "PassportVoid", idlErrors);

    // matched receipt, then the seal dies: release, no refund
    const q = await newPassport();
    const rq = await upToReceipt(q, 92, 92);
    await markSealDead(q);
    await expectAnchorError(disputeBuilder(rq.o, buyer, { seal: q.sealPda }).rpc(), "ReceiptMatched", idlErrors);
    await releaseBuilder(rq.o).rpc();
    expect((await order(rq.o)).state).to.equal(S.RELEASED);
  });

  it("cancel → CANCELLED, close_order, re-list at a new price, a stale expected price fails, admin dispute from RESERVED", async () => {
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
    await expectAnchorError(reserveBuilder(o, p.passportPda).rpc(), "InvalidState", idlErrors);
    await escrow.methods.closeOrder().accountsStrict({ order: o, seller: wallet }).rpc();
    expect(await connection.getAccountInfo(o)).to.be.null;

    // re-list the same passport (same PDA) at a higher price: a buyer who saw the old price is protected
    const o2 = await list(p, USDC(500));
    expect(o2.equals(o)).to.be.true;
    expect((await order(o2)).state).to.equal(S.LISTED);
    await expectAnchorError(reserveBuilder(o2, p.passportPda, PRICE).rpc(), "PriceChanged", idlErrors);
    await reserveBuilder(o2, p.passportPda, USDC(500)).rpc();
    const buyerAfterReserve = await tokenBalance(connection, buyerAta);
    await disputeBuilder(o2, payer).rpc(); // admin
    expect((await order(o2)).state).to.equal(S.DISPUTE);
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal((buyerAfterReserve + USDC(500)).toString());
    await escrow.methods.closeOrder().accountsStrict({ order: o2, seller: wallet }).rpc();
  });

  it("IDL constants: order states, dispute reasons, tolerance, windows, seeds", () => {
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
    expect(v("DEFAULT_DISPUTE_AFTER_S")).to.equal(String(7 * DAY));
    expect(v("MIN_DISPUTE_AFTER_S")).to.equal(String(HOUR));
    expect(v("MAX_DISPUTE_AFTER_S")).to.equal(String(60 * DAY));
    expect(Buffer.from(JSON.parse(v("ORDER_SEED"))).toString()).to.equal("order");
    expect(Buffer.from(JSON.parse(v("VAULT_SEED"))).toString()).to.equal("vault");
    expect(Buffer.from(JSON.parse(v("CONFIG_SEED"))).toString()).to.equal("config");
    expect(v("MPL_CORE_PROGRAM_ID")).to.equal(MPL_CORE.toBase58());
    const idl = escrow.rawIdl as any;
    expect(idl.accounts.map((a: any) => a.name).sort()).to.deep.equal(["EscrowConfig", "Order"]);
    // new accounts are appended, so existing account indices stay stable for the verifier
    const ix = (name: string) => idl.instructions.find((i: any) => i.name === name).accounts.map((a: any) => a.name);
    expect(ix("list")).to.deep.equal(["config", "passport", "order", "seller", "system_program", "asset", "registry"]);
    expect(ix("reserve")).to.deep.equal(["config", "order", "buyer", "buyer_token", "usdc_mint", "vault", "token_program", "system_program", "passport", "asset", "registry"]);
    expect(ix("release_after_timeout")).to.deep.equal(ix("release"));
  });

  it("Core custody: deposit_asset → release transfers the asset to the buyer, who may then list it; the old owner may not", async () => {
    const p = await newPassport();
    const asset = p.asset;
    const o = await list(p);
    await escrow.methods
      .depositAsset()
      .accountsStrict({ order: o, seller: wallet, asset, mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId })
      .rpc();
    expect((await order(o)).assetDeposited).to.be.true;
    expect((await fetchCoreAsset(connection, asset))!.owner.equals(o)).to.be.true;
    await expectAnchorError(
      escrow.methods.depositAsset().accountsStrict({ order: o, seller: wallet, asset, mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).rpc(),
      "AssetAlreadyDeposited",
      idlErrors
    );

    await reserveBuilder(o, p.passportPda).rpc();
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 95 });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();
    await ship(o);
    const buyerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 95, role: enums.role.BUYER, attester: buyer });
    await receipt(o, buyerScan, p.sealPda, sellerScan);
    // release without the asset accounts must fail, with them the buyer becomes the owner
    await expectAnchorError(releaseBuilder(o).rpc(), "MissingAssetAccounts", idlErrors);
    await releaseBuilder(o, { asset }).rpc();
    expect((await order(o)).state).to.equal(S.RELEASED);
    expect((await order(o)).assetDeposited).to.be.false;
    expect((await fetchCoreAsset(connection, asset))!.owner.equals(buyer.publicKey)).to.be.true;

    // the buyer now owns the bottle's asset: they can list it, the issuer/old seller cannot any more
    await escrow.methods.closeOrder().accountsStrict({ order: o, seller: wallet }).rpc();
    await expectAnchorError(list(p), "NotPassportOwner", idlErrors);
    await listBuilder(p, USDC(520), buyer).rpc();
    expect((await order(orderPdaOf(p.passportPda, buyer.publicKey))).price.toString()).to.equal(USDC(520).toString());
  });

  it("dead seal after shipping: the buyer cannot refund it (the bottle may be delivered), the admin can", async () => {
    const p = await newPassport();
    const buyerBefore = await tokenBalance(connection, buyerAta);
    const { o } = await upToShipped(p);
    await markSealDead(p);
    // e.g. a buyer who is also the issuer (or works with it) keeps the delivered bottle, kills its seal and disputes
    await expectAnchorError(disputeBuilder(o, buyer, { seal: p.sealPda }).rpc(), "DeadSealAfterShipping", idlErrors);
    await expectAnchorError(releaseAfterTimeoutBuilder(o).rpc(), "DisputeWindowNotElapsed", idlErrors);
    expect((await order(o)).state).to.equal(S.SHIPPED);
    await disputeBuilder(o, payer, { seal: p.sealPda }).rpc(); // admin
    expect((await order(o)).state).to.equal(S.DISPUTE);
    expect((await tokenBalance(connection, buyerAta)).toString()).to.equal(buyerBefore.toString());
  });

  it("stale scans: a scan from before the reservation is no shipping scan, one from before shipping no receipt scan", async () => {
    const p = await newPassport();
    const o = await list(p);
    // the seller's scan from earlier (for example from when they bought the bottle), dated just inside flacon's window
    const t0 = await chainTime(connection);
    const oldSellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 92, ts: t0 - 595 });
    await waitForChainTime(connection, t0 - 595 + 602);
    await reserveBuilder(o, p.passportPda).rpc();
    expect((await order(o)).reservedAt.toNumber()).to.be.greaterThan(t0 - 595 + 600);
    await expectAnchorError(preShipBuilder(o, oldSellerScan, p.sealPda).rpc(), "ScanBeforeOrderStep", idlErrors);
    expect((await order(o)).state).to.equal(S.RESERVED);
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 92 });
    await preShipBuilder(o, sellerScan, p.sealPda).rpc();

    // a buyer scan anchored before the parcel was shipped
    const t1 = await chainTime(connection);
    const early = await recordScan(flacon, provider, reg, p, { counter: 3, fill: 92, role: enums.role.BUYER, attester: buyer, ts: t1 - 595 });
    await waitForChainTime(connection, t1 - 595 + 602);
    await ship(o);
    await expectAnchorError(receipt(o, early, p.sealPda, sellerScan), "ScanBeforeOrderStep", idlErrors);
    expect((await order(o)).state).to.equal(S.SHIPPED);
    const fresh = await recordScan(flacon, provider, reg, p, { counter: 4, fill: 92, role: enums.role.BUYER, attester: buyer });
    await receipt(o, fresh, p.sealPda, sellerScan);
    expect((await order(o)).state).to.equal(S.RECEIPT_SCANNED);
    await releaseBuilder(o).rpc();
  });

  it("reserve checks the seller again: an order whose seller gave the Core asset away cannot be bought", async () => {
    const p = await newPassport();
    const o = await list(p); // listed without custody (asset stays with the seller)
    const newOwner = Keypair.generate().publicKey;
    await transferCoreAsset(connection, payer, p.asset, payer, newOwner);
    await expectAnchorError(reserveBuilder(o, p.passportPda).rpc(), "NotPassportOwner", idlErrors);
    // the asset account must be the order's asset
    const other = await createCoreAsset(connection, payer);
    await expectAnchorError(reserveBuilder(o, p.passportPda, PRICE, buyer, other).rpc(), "AssetMismatch", idlErrors);
    expect((await order(o)).state).to.equal(S.LISTED);
    expect(await connection.getAccountInfo(vaultPdaOf(o))).to.be.null;
  });

  it("without a Core asset only the issuer sells, and only while it is a partner: removing it stops listing and reserving", async () => {
    const issuer = Keypair.generate();
    await airdrop(provider, issuer.publicKey, 2);
    const admin = { registry: reg.registryPda, authority: wallet };
    await flacon.methods.addPartner(issuer.publicKey).accountsStrict(admin).rpc();
    const p = await newPassport({ issuer });
    // the asset is burned: the passport points at an account that is no longer a Core asset (like passports minted
    // before mint_passport checked the asset)
    await burnCoreAsset(connection, payer, p.asset, issuer);
    expect(await fetchCoreAsset(connection, p.asset)).to.equal(null);
    await expectAnchorError(listBuilder(p, PRICE, payer).rpc(), "NotPassportOwner", idlErrors); // the authority is not the issuer
    await listBuilder(p, PRICE, issuer).rpc();
    const o = orderPdaOf(p.passportPda, issuer.publicKey);

    await flacon.methods.removePartner(issuer.publicKey).accountsStrict(admin).rpc();
    await expectAnchorError(reserveBuilder(o, p.passportPda).rpc(), "NotPassportOwner", idlErrors);
    await escrow.methods
      .cancel()
      .accountsStrict({ order: o, seller: issuer.publicKey, asset: null, mplCoreProgram: null, systemProgram: SystemProgram.programId })
      .signers([issuer])
      .rpc();
    await escrow.methods.closeOrder().accountsStrict({ order: o, seller: issuer.publicKey }).signers([issuer]).rpc();
    await expectAnchorError(listBuilder(p, PRICE, issuer).rpc(), "NotPassportOwner", idlErrors);
  });

  it("a seller who never held USDC is paid: the web app's release builder creates the seller's token account first (M15)", async () => {
    const seller = Keypair.generate();
    await airdrop(provider, seller.publicKey, 2);
    const p = await newPassport();
    await transferCoreAsset(connection, payer, p.asset, payer, seller.publicKey);
    await listBuilder(p, PRICE, seller).rpc();
    const o = orderPdaOf(p.passportPda, seller.publicKey);
    await reserveBuilder(o, p.passportPda).rpc();
    const sellerScan = await recordScan(flacon, provider, reg, p, { counter: 1, fill: 92, attester: seller });
    await preShipBuilder(o, sellerScan, p.sealPda, seller).rpc();
    await ship(o, seller);
    const buyerScan = await recordScan(flacon, provider, reg, p, { counter: 2, fill: 92, role: enums.role.BUYER, attester: buyer });
    await receipt(o, buyerScan, p.sealPda, sellerScan);
    const sellerUsdc = ataAddress(seller.publicKey, mint);
    expect(await connection.getAccountInfo(sellerUsdc), "the seller has no USDC account").to.be.null;

    const a = await order(o);
    const view: IxOrder = {
      pubkey: o, passport: a.passport, seller: a.seller, buyer: a.buyer, asset: a.asset, priceBase: BigInt(a.price.toString()),
      sellerScan: a.sellerScan, assetDeposited: a.assetDeposited,
    };
    const tx = await webEscrowIx.release(escrow as unknown as Program, view, wallet, mint).transaction();
    await provider.sendAndConfirm(tx);
    expect((await order(o)).state).to.equal(S.RELEASED);
    expect((await tokenBalance(connection, sellerUsdc)).toString()).to.equal(PRICE.toString());
  });
});
