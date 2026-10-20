/**
 * Integration tests for programs/market_escrow (marketplace blueprint §7.2, §7.3) on the local validator.
 *
 * Every path runs here:
 * - live orders (opened in the test) cover the signed offer, the happy path, disputes, rulings, settlements,
 *   fee collection, closing, and the "not yet" side of every deadline;
 * - the validator cannot move its clock, so the branches that open days after a step (refund after the ship
 *   deadline, release after the review window, execution after the timelock, refund after T_max) run on
 *   aged fixture orders loaded at genesis (tests/fixtures/market-escrow, scripts/market-escrow-fixtures.ts),
 *   whose steps happened on 2026-01-01. The live orders check that the program stores those timestamps.
 *
 * All keys of the config (offer key, arbiter, fee recipient) and the two mints are TEST ONLY keys derived
 * from public labels (tests/lib/market-escrow.ts).
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { randomBytes } from "crypto";
import type { MarketEscrow } from "../target/types/market_escrow";
import { ataAddress, createAtaIdempotentIx, createMint, mintToIx, tokenBalance } from "../scripts/lib/spl";
import { airdrop, chainTime, expectAnchorError, programDataOf, waitForChainTime } from "./lib/flacon";
import {
  DAY,
  FIXTURE_AMOUNT,
  FIXTURE_BUYER_FEE,
  FIXTURE_DEPOSIT,
  FIXTURE_REASON_HASH,
  FIXTURE_SELLER_FEE,
  HOUR,
  KEYS,
  LANE,
  MARKET_ORDER_LEN,
  PARTY,
  RESOLUTION,
  REVIEW_WINDOW_S,
  RULING,
  STATE,
  TOKEN_PROGRAM_ID,
  configPda,
  feeVaultPda,
  fixtureOrders,
  offerArgs,
  offerMessage,
  offerSignatureIx,
  orderPda,
  rentExempt,
  vaultPda,
  type FixtureLabel,
  type OfferTerms,
} from "./lib/market-escrow";

/** A funded order, live or fixture. */
interface H {
  order: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  buyer: Keypair;
  seller: Keypair;
  rentPayer: PublicKey;
  amount: bigint;
  buyerFee: bigint;
  sellerFee: bigint;
  terms?: OfferTerms;
}
const deposit = (h: H) => h.amount + h.buyerFee;

describe("market_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.marketEscrow as Program<MarketEscrow>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const pid = program.programId;
  const idlErrors = (program.rawIdl.errors ?? []) as { code: number; name: string }[];
  const fail = (p: Promise<unknown>, code: string) => expectAnchorError(p, code, idlErrors);
  const [config] = configPda(pid);
  const USDC = KEYS.usdc.publicKey;
  const EURC = KEYS.eurc.publicKey;
  const feeVault = (mint: PublicKey) => feeVaultPda(mint, pid)[0];
  const ata = (owner: PublicKey, mint: PublicKey) => ataAddress(owner, mint);
  const sponsor = Keypair.generate(); // Kora-style rent payer
  const seller = Keypair.generate();
  const stranger = Keypair.generate();
  const fx = Object.fromEntries(fixtureOrders(pid).map((f) => [f.label, f])) as Record<FixtureLabel, ReturnType<typeof fixtureOrders>[number]>;
  const fixture = (label: FixtureLabel): H => ({
    order: fx[label].order,
    vault: fx[label].vault,
    mint: fx[label].fields.mint,
    buyer: KEYS.fixtureBuyer,
    seller: KEYS.fixtureSeller,
    rentPayer: KEYS.fixtureSponsor.publicKey,
    amount: FIXTURE_AMOUNT,
    buyerFee: FIXTURE_BUYER_FEE,
    sellerFee: FIXTURE_SELLER_FEE,
  });

  // ---- token helpers ------------------------------------------------------------------

  async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
    await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer, ...signers], { commitment: "confirmed" });
  }
  /** Creates the associated token accounts (idempotent), paid by the provider wallet. */
  async function ensureAtas(pairs: [PublicKey, PublicKey][]) {
    for (let i = 0; i < pairs.length; i += 6) {
      await send(pairs.slice(i, i + 6).map(([owner, mint]) => createAtaIdempotentIx(payer.publicKey, owner, mint)));
    }
  }
  async function fund(owner: PublicKey, mint: PublicKey, amount: bigint) {
    await ensureAtas([[owner, mint]]);
    await send([mintToIx(mint, ata(owner, mint), KEYS.mintAuthority.publicKey, amount)], [KEYS.mintAuthority]);
  }
  const bal = (account: PublicKey) => tokenBalance(connection, account);
  // read at the provider's commitment, which `.rpc()` confirms at
  const lamports = (k: PublicKey) => connection.getBalance(k);
  const orderOf = (h: H) => program.account.marketOrder.fetch(h.order);
  const expectGone = async (k: PublicKey) => expect(await connection.getAccountInfo(k), k.toBase58()).to.be.null;
  async function expectRejected(p: Promise<unknown>) {
    let failed = false;
    try {
      await p;
    } catch {
      failed = true;
    }
    expect(failed, "transaction should have failed").to.be.true;
  }

  // ---- order helpers ------------------------------------------------------------------

  async function terms(over: Partial<OfferTerms> = {}): Promise<OfferTerms> {
    const now = await chainTime(connection);
    return {
      orderId: randomBytes(16),
      seller: seller.publicKey,
      amount: 300_000_000n,
      buyerFee: 15_000_000n,
      sellerFee: 9_000_000n,
      lane: LANE.S,
      shipDeadline: now + 5 * DAY,
      rulingWindowS: 21 * DAY,
      timelockS: 48 * HOUR,
      expiry: now + 600,
      ...over,
    };
  }

  interface OpenOpts {
    mint?: PublicKey;
    /** the Ed25519 instruction; `null` sends none */
    sig?: TransactionInstruction | null;
    /** sign this message instead of the one matching the args */
    signedMessage?: Buffer;
    rentPayer?: Keypair;
    /** instructions between the Ed25519 instruction and open_and_deposit */
    between?: TransactionInstruction[];
  }
  function openBuilder(buyer: Keypair, t: OfferTerms, o: OpenOpts = {}) {
    const mint = o.mint ?? USDC;
    const [order] = orderPda(buyer.publicKey, t.orderId, pid);
    const [vault] = vaultPda(order, pid);
    const message = o.signedMessage ?? offerMessage(pid, buyer.publicKey, mint, t);
    const sig = o.sig === undefined ? offerSignatureIx(KEYS.offer, message) : o.sig;
    const rentPayer = o.rentPayer ?? sponsor;
    return program.methods
      .openAndDeposit(offerArgs(t))
      .accountsStrict({
        config,
        order,
        vault,
        mint,
        buyer: buyer.publicKey,
        buyerToken: ata(buyer.publicKey, mint),
        rentPayer: rentPayer.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([...(sig ? [sig] : []), ...(o.between ?? [])])
      .signers(rentPayer === buyer ? [buyer] : [buyer, rentPayer]);
  }
  async function newBuyer(mint = USDC, amount = 1_000_000_000n) {
    const b = Keypair.generate();
    await fund(b.publicKey, mint, amount);
    return b;
  }
  async function open(over: Partial<OfferTerms> = {}, mint = USDC, o: OpenOpts = {}): Promise<H> {
    const buyer = await newBuyer(mint);
    const t = await terms(over);
    await openBuilder(buyer, t, { mint, ...o }).rpc();
    const [order] = orderPda(buyer.publicKey, t.orderId, pid);
    return {
      order,
      vault: vaultPda(order, pid)[0],
      mint,
      buyer,
      seller,
      rentPayer: (o.rentPayer ?? sponsor).publicKey,
      amount: t.amount,
      buyerFee: t.buyerFee,
      sellerFee: t.sellerFee,
      terms: t,
    };
  }

  const markShipped = (h: H, who: Keypair = h.seller) =>
    program.methods.markShipped().accountsStrict({ order: h.order, seller: who.publicKey }).signers([who]).rpc();
  const releaseAccounts = (h: H, o: { sellerToken?: PublicKey; feeVault?: PublicKey } = {}) => ({
    order: h.order,
    vault: h.vault,
    sellerToken: o.sellerToken ?? ata(h.seller.publicKey, h.mint),
    feeVault: o.feeVault ?? feeVault(h.mint),
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const confirm = (h: H, who: Keypair = h.buyer, o: { sellerToken?: PublicKey; feeVault?: PublicKey } = {}) =>
    program.methods.confirm().accountsStrict({ ...releaseAccounts(h, o), buyer: who.publicKey }).signers([who]).rpc();
  const releaseAfterWindow = (h: H) => program.methods.releaseAfterWindow().accountsStrict(releaseAccounts(h)).rpc();
  const refundAccounts = (h: H, buyerToken?: PublicKey) => ({
    order: h.order,
    vault: h.vault,
    buyerToken: buyerToken ?? ata(h.buyer.publicKey, h.mint),
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const refundUnshipped = (h: H, buyerToken?: PublicKey) => program.methods.refundUnshipped().accountsStrict(refundAccounts(h, buyerToken)).rpc();
  const refundAfterTmax = (h: H) => program.methods.refundAfterTmax().accountsStrict(refundAccounts(h)).rpc();
  const dispute = (h: H, who: Keypair) =>
    program.methods.dispute().accountsStrict({ config, order: h.order, signer: who.publicKey }).signers([who]).rpc();
  const rule = (h: H, ruling: number, hash: Buffer = FIXTURE_REASON_HASH, who: Keypair = KEYS.arbiter) =>
    program.methods.rule(ruling, Array.from(hash)).accountsStrict({ config, order: h.order, arbiter: who.publicKey }).signers([who]).rpc();
  const executeRuling = (h: H, o: { buyer?: boolean; seller?: boolean } = { buyer: true, seller: true }) =>
    program.methods
      .executeRuling()
      .accountsStrict({
        order: h.order,
        vault: h.vault,
        buyerToken: o.buyer ? ata(h.buyer.publicKey, h.mint) : null,
        sellerToken: o.seller ? ata(h.seller.publicKey, h.mint) : null,
        feeVault: feeVault(h.mint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  const propose = (h: H, who: Keypair, toBuyer: bigint) =>
    program.methods.proposeSettlement(new BN(toBuyer.toString())).accountsStrict({ order: h.order, signer: who.publicKey }).signers([who]).rpc();
  const accept = (h: H, who: Keypair, expected: bigint) =>
    program.methods
      .acceptSettlement(new BN(expected.toString()))
      .accountsStrict({
        order: h.order,
        vault: h.vault,
        buyerToken: ata(h.buyer.publicKey, h.mint),
        sellerToken: ata(h.seller.publicKey, h.mint),
        signer: who.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();
  const closeOrder = (h: H, o: { buyerToken?: boolean; rentPayer?: PublicKey } = {}) =>
    program.methods
      .closeOrder()
      .accountsStrict({
        order: h.order,
        vault: h.vault,
        rentPayer: o.rentPayer ?? h.rentPayer,
        buyerToken: o.buyerToken ? ata(h.buyer.publicKey, h.mint) : null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

  /** Token balances of everyone an order can pay, before and after `f`. */
  async function deltas(h: H, f: () => Promise<unknown>) {
    const accounts = { buyer: ata(h.buyer.publicKey, h.mint), seller: ata(h.seller.publicKey, h.mint), fees: feeVault(h.mint), vault: h.vault };
    const before = Object.fromEntries(await Promise.all(Object.entries(accounts).map(async ([k, v]) => [k, await bal(v)])));
    await f();
    const out: Record<string, bigint> = {};
    for (const [k, v] of Object.entries(accounts)) out[k] = (await bal(v)) - before[k];
    return out as { buyer: bigint; seller: bigint; fees: bigint; vault: bigint };
  }

  before(async () => {
    for (const mint of [USDC, EURC]) {
      expect(await connection.getAccountInfo(mint), `fixture mint ${mint.toBase58()} (Anchor.toml [[test.validator.account_dir]])`).to.not.be.null;
    }
    for (const k of [sponsor.publicKey, stranger.publicKey]) await airdrop(provider, k, 2);
    const owners = [seller.publicKey, KEYS.fixtureBuyer.publicKey, KEYS.fixtureSeller.publicKey, KEYS.feeRecipient.publicKey, stranger.publicKey];
    await ensureAtas(owners.flatMap((o) => [[o, USDC] as [PublicKey, PublicKey], [o, EURC] as [PublicKey, PublicKey]]));
  });

  // ---------------------------------------------------------------------------------------------
  describe("config", () => {
    const initAccounts = (authority: PublicKey, usdc = USDC, eurc = EURC) => ({
      config,
      authority,
      usdcMint: usdc,
      eurcMint: eurc,
      usdcFeeVault: feeVault(usdc),
      eurcFeeVault: feeVault(eurc),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      program: pid,
      programData: programDataOf(pid),
    });
    const init = (offer: PublicKey, arbiter: PublicKey, fee: PublicKey) => program.methods.initConfig(offer, arbiter, fee);

    it("constants in the IDL match the TypeScript mirror", () => {
      const c = Object.fromEntries((program.rawIdl.constants ?? []).map((x: any) => [x.name, x.value]));
      for (const [k, v] of Object.entries(STATE)) expect(Number(c[`STATE_${k}`]), k).to.equal(v);
      for (const [k, v] of Object.entries(RESOLUTION)) expect(Number(c[`RESOLUTION_${k}`]), k).to.equal(v);
      for (const [k, v] of Object.entries(LANE)) expect(Number(c[`LANE_${k}`]), k).to.equal(v);
      for (const [k, v] of Object.entries(RULING)) expect(Number(c[`RULING_${k}`]), k).to.equal(v);
      for (const [k, v] of Object.entries(PARTY)) expect(Number(c[`PARTY_${k}`]), k).to.equal(v);
      expect(Number(c.REVIEW_WINDOW_S_LANE_S)).to.equal(REVIEW_WINDOW_S[LANE.S]);
      expect(Number(c.REVIEW_WINDOW_S_LANE_A)).to.equal(REVIEW_WINDOW_S[LANE.A]);
      expect(Number(c.OFFER_MSG_LEN)).to.equal(201);
    });

    it("offer message: the TypeScript builder produces the Rust golden vector", () => {
      const msg = offerMessage(new PublicKey(Buffer.alloc(32, 1)), new PublicKey(Buffer.alloc(32, 2)), new PublicKey(Buffer.alloc(32, 4)), {
        orderId: Buffer.alloc(16, 0xa5),
        seller: new PublicKey(Buffer.alloc(32, 3)),
        amount: 300_000_000n,
        buyerFee: 15_000_000n,
        sellerFee: 9_000_000n,
        lane: LANE.S,
        shipDeadline: 1_790_000_000,
        rulingWindowS: 21 * DAY,
        timelockS: 48 * HOUR,
        expiry: 1_789_000_600,
      });
      // programs/market_escrow/src/offer.rs GOLDEN_HEX
      const golden =
        "46564d4b544f4631" + "01".repeat(32) + "a5".repeat(16) + "02".repeat(32) + "03".repeat(32) + "04".repeat(32) +
        "00a3e11100000000" + "c0e1e40000000000" + "4054890000000000" + "01" + "803bb16a00000000" + "80af1b00" + "00a30200" + "98fba16a00000000";
      expect(msg.toString("hex")).to.equal(golden);
    });

    it("init_config: only the upgrade authority, sane keys and two different 6-decimal mints", async function () {
      if (await connection.getAccountInfo(config)) {
        console.log("      (skipped: config already exists on this validator)");
        return this.skip();
      }
      const [o, a, f] = [KEYS.offer.publicKey, KEYS.arbiter.publicKey, KEYS.feeRecipient.publicKey];
      await fail(init(o, a, f).accountsStrict(initAccounts(stranger.publicKey)).signers([stranger]).rpc(), "NotUpgradeAuthority");
      await fail(init(o, o, f).accountsStrict(initAccounts(payer.publicKey)).rpc(), "OfferKeyIsArbiter");
      await fail(init(o, PublicKey.default, f).accountsStrict(initAccounts(payer.publicKey)).rpc(), "InvalidKey");
      const nineDecimals = await createMint(connection, payer, payer.publicKey, 9);
      await fail(init(o, a, f).accountsStrict(initAccounts(payer.publicKey, USDC, nineDecimals)).rpc(), "InvalidMint");
      // the same mint twice: both fee vaults would be one account
      await fail(init(o, a, f).accountsStrict(initAccounts(payer.publicKey, USDC, USDC)).rpc(), "ConstraintDuplicateMutableAccount");
      await init(o, a, f).accountsStrict(initAccounts(payer.publicKey)).rpc();
      // a singleton: a second config cannot be created
      await expectRejected(init(o, a, f).accountsStrict(initAccounts(payer.publicKey)).rpc());
    });

    it("config holds the test keys and both fee vaults belong to the config PDA", async () => {
      const cfg = await program.account.marketConfig.fetch(config);
      expect(cfg.offerKey.equals(KEYS.offer.publicKey)).to.be.true;
      expect(cfg.arbiter.equals(KEYS.arbiter.publicKey)).to.be.true;
      expect(cfg.feeRecipient.equals(KEYS.feeRecipient.publicKey)).to.be.true;
      expect(cfg.mints.map((m: PublicKey) => m.toBase58())).to.deep.equal([USDC.toBase58(), EURC.toBase58()]);
      for (const mint of [USDC, EURC]) {
        const info = await connection.getAccountInfo(feeVault(mint));
        expect(info!.owner.equals(TOKEN_PROGRAM_ID)).to.be.true;
        expect(new PublicKey(info!.data.subarray(0, 32)).equals(mint)).to.be.true;
        expect(new PublicKey(info!.data.subarray(32, 64)).equals(config)).to.be.true;
      }
      // the program has no instruction that changes the config, pauses or sweeps
      expect(program.rawIdl.instructions.map((i) => i.name).sort()).to.deep.equal([
        "accept_settlement", "close_order", "collect_fees", "confirm", "dispute", "execute_ruling", "init_config",
        "mark_shipped", "open_and_deposit", "propose_settlement", "refund_after_tmax", "refund_unshipped", "release_after_window", "rule",
      ]);
    });

    it("fixture orders decode with the program's own layout", async () => {
      for (const f of Object.values(fx)) {
        const info = await connection.getAccountInfo(f.order);
        expect(info, f.label).to.not.be.null;
        expect(info!.data.length).to.equal(MARKET_ORDER_LEN);
        const o = await program.account.marketOrder.fetch(f.order);
        expect(o.state, f.label).to.equal(f.fields.state);
        expect(o.lane).to.equal(f.fields.lane);
        expect(o.reviewWindowS).to.equal(f.fields.reviewWindowS);
        expect(o.amount.toString()).to.equal(f.fields.amount.toString());
        expect(o.sellerFee.toString()).to.equal(f.fields.sellerFee.toString());
        expect(o.shipDeadline.toNumber()).to.equal(f.fields.shipDeadline);
        expect(o.ruledAt.toNumber()).to.equal(f.fields.ruledAt);
        expect(o.ruling).to.equal(f.fields.ruling);
        expect(o.endedAt.toNumber()).to.equal(f.fields.endedAt);
        expect(o.bump).to.equal(f.fields.bump);
        expect(o.vaultBump).to.equal(f.fields.vaultBump);
        expect(o.mint.equals(f.fields.mint)).to.be.true;
        expect(o.rentPayer.equals(f.fields.rentPayer)).to.be.true;
        expect(Buffer.from(o.orderId).equals(f.fields.orderId)).to.be.true;
        expect(await bal(f.vault)).to.equal(f.vaultAmount);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("open_and_deposit: the signed offer", () => {
    it("opens and funds the order; the sponsor pays the rent", async () => {
      const buyer = await newBuyer();
      const t = await terms();
      const sponsorBefore = await lamports(sponsor.publicKey);
      const buyerBefore = await bal(ata(buyer.publicKey, USDC));
      await openBuilder(buyer, t).rpc();
      const [order] = orderPda(buyer.publicKey, t.orderId, pid);
      const [vault] = vaultPda(order, pid);
      const o = await program.account.marketOrder.fetch(order);
      const now = await chainTime(connection);
      expect(o.state).to.equal(STATE.PAID);
      expect(o.buyer.equals(buyer.publicKey) && o.seller.equals(seller.publicKey) && o.mint.equals(USDC)).to.be.true;
      expect(o.rentPayer.equals(sponsor.publicKey)).to.be.true;
      expect(o.amount.toString()).to.equal("300000000");
      expect(o.buyerFee.toString()).to.equal("15000000");
      expect(o.sellerFee.toString()).to.equal("9000000");
      expect(o.reviewWindowS).to.equal(10 * DAY);
      expect(o.rulingWindowS).to.equal(21 * DAY);
      expect(o.timelockS).to.equal(48 * HOUR);
      expect(o.shipDeadline.toNumber()).to.equal(t.shipDeadline);
      expect(o.offerExpiry.toNumber()).to.equal(t.expiry);
      expect(Math.abs(o.openedAt.toNumber() - now)).to.be.lessThan(30);
      expect(Buffer.from(o.orderId).equals(t.orderId)).to.be.true;
      expect(await bal(vault)).to.equal(315_000_000n);
      expect(buyerBefore - (await bal(ata(buyer.publicKey, USDC)))).to.equal(315_000_000n);
      expect(sponsorBefore - (await lamports(sponsor.publicKey))).to.equal(rentExempt(MARKET_ORDER_LEN) + rentExempt(165));
      // the same signed offer cannot open a second order (and the deposit is not taken twice)
      await fail(openBuilder(buyer, t).rpc(), "OrderAlreadyExists");
      expect(await bal(vault)).to.equal(315_000_000n);
    });

    it("lane A stores a 14-day review window; EURC works like USDC; the buyer may pay the rent itself", async () => {
      const a = await open({ lane: LANE.A });
      expect((await orderOf(a)).reviewWindowS).to.equal(14 * DAY);
      const buyer = await newBuyer(EURC);
      await airdrop(provider, buyer.publicKey, 1);
      const t = await terms();
      await openBuilder(buyer, t, { mint: EURC, rentPayer: buyer }).rpc();
      const [order] = orderPda(buyer.publicKey, t.orderId, pid);
      const o = await program.account.marketOrder.fetch(order);
      expect(o.mint.equals(EURC) && o.rentPayer.equals(buyer.publicKey)).to.be.true;
    });

    it("rejects a missing, misplaced, foreign or forged signature", async () => {
      const buyer = await newBuyer();
      const t = await terms();
      await fail(openBuilder(buyer, t, { sig: null }).rpc(), "MissingOfferSignature");
      // the Ed25519 instruction must come directly before open_and_deposit
      await fail(openBuilder(buyer, t, { between: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })] }).rpc(), "MissingOfferSignature");
      // a valid signature by another key
      const other = Keypair.generate();
      await fail(openBuilder(buyer, t, { sig: offerSignatureIx(other, offerMessage(pid, buyer.publicKey, USDC, t)) }).rpc(), "OfferKeyMismatch");
      // the arbiter's key is not the offer key either
      await fail(openBuilder(buyer, t, { sig: offerSignatureIx(KEYS.arbiter, offerMessage(pid, buyer.publicKey, USDC, t)) }).rpc(), "OfferKeyMismatch");
      // claims the offer key but is signed by another one: the precompile rejects the transaction
      await expectRejected(openBuilder(buyer, t, { sig: offerSignatureIx(other, offerMessage(pid, buyer.publicKey, USDC, t), KEYS.offer.publicKey) }).rpc());
      expect(await connection.getAccountInfo(orderPda(buyer.publicKey, t.orderId, pid)[0])).to.be.null;
    });

    it("rejects terms that differ from the signed ones", async () => {
      const buyer = await newBuyer();
      const t = await terms();
      const signedFor = (x: Partial<OfferTerms>, b = buyer.publicKey, mint = USDC, programId = pid) => offerMessage(programId, b, mint, { ...t, ...x });
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ amount: t.amount - 1n }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ buyerFee: 0n }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ sellerFee: 0n }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ seller: stranger.publicKey }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ lane: LANE.A }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ shipDeadline: t.shipDeadline + DAY }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ timelockS: 72 * HOUR }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ expiry: t.expiry + 1 }) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({ orderId: randomBytes(16) }) }).rpc(), "OfferMismatch");
      // an offer made out to another buyer, another mint or another deployment
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({}, stranger.publicKey) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({}, buyer.publicKey, EURC) }).rpc(), "OfferMismatch");
      await fail(openBuilder(buyer, t, { signedMessage: signedFor({}, buyer.publicKey, USDC, Keypair.generate().publicKey) }).rpc(), "OfferMismatch");
    });

    it("rejects properly signed terms outside the program's bounds", async () => {
      const buyer = await newBuyer();
      const now = await chainTime(connection);
      const bad = async (over: Partial<OfferTerms>, code: string) => fail(openBuilder(buyer, await terms(over)).rpc(), code);
      await bad({ expiry: now - 5 }, "OfferExpired");
      await bad({ expiry: now + HOUR + 120 }, "OfferExpiryTooFar");
      await bad({ amount: 0n, buyerFee: 0n, sellerFee: 0n }, "InvalidAmount");
      await bad({ buyerFee: 60_000_001n }, "FeeTooHigh");
      await bad({ sellerFee: 60_000_001n }, "FeeTooHigh");
      await bad({ lane: LANE.G }, "LaneNotSupported");
      await bad({ lane: 0 }, "InvalidLane");
      await bad({ shipDeadline: now + DAY - 120 }, "InvalidShipDeadline");
      await bad({ shipDeadline: now + 30 * DAY + 120 }, "InvalidShipDeadline");
      await bad({ rulingWindowS: 7 * DAY - 1 }, "InvalidRulingWindow");
      await bad({ rulingWindowS: 60 * DAY + 1 }, "InvalidRulingWindow");
      await bad({ timelockS: 48 * HOUR - 1 }, "InvalidTimelock");
      await bad({ timelockS: 72 * HOUR + 1 }, "InvalidTimelock");
      await bad({ seller: buyer.publicKey }, "InvalidSeller");
      await bad({ seller: KEYS.arbiter.publicKey }, "InvalidSeller");
      // the arbiter cannot buy
      const arbiterAsBuyer = KEYS.arbiter;
      await fund(arbiterAsBuyer.publicKey, USDC, 400_000_000n);
      await fail(openBuilder(arbiterAsBuyer, await terms()).rpc(), "BuyerIsArbiter");
    });

    it("rejects a mint the config does not allow", async () => {
      const other = await createMint(connection, payer, payer.publicKey, 6);
      const buyer = Keypair.generate();
      await ensureAtas([[buyer.publicKey, other]]);
      await send([mintToIx(other, ata(buyer.publicKey, other), payer.publicKey, 1_000_000_000n)]);
      await fail(openBuilder(buyer, await terms(), { mint: other }).rpc(), "MintNotAllowed");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("happy path: ship, confirm, collect fees, close", () => {
    let h: H;
    it("only the seller marks shipped, before the ship deadline", async () => {
      h = await open({ expiry: (await chainTime(connection)) + 8 });
      await fail(markShipped(h, h.buyer), "NotSeller");
      await fail(markShipped(h, stranger), "NotSeller");
      await markShipped(h);
      const o = await orderOf(h);
      expect(o.state).to.equal(STATE.SHIPPED);
      expect(Math.abs(o.shippedAt.toNumber() - (await chainTime(connection)))).to.be.lessThan(30);
      await fail(markShipped(h), "InvalidState");
    });

    it("only the buyer confirms; the payout goes to the seller's and the fee vault's accounts only", async () => {
      await fail(confirm(h, h.seller), "NotBuyer");
      await fail(confirm(h, stranger), "NotBuyer");
      // the payout accounts are fixed by the order
      await fail(confirm(h, h.buyer, { sellerToken: ata(stranger.publicKey, h.mint) }), "ConstraintTokenOwner");
      await fail(confirm(h, h.buyer, { feeVault: feeVault(EURC) }), "ConstraintSeeds");
      const d = await deltas(h, () => confirm(h));
      expect(d).to.deep.equal({ buyer: 0n, seller: 291_000_000n, fees: 24_000_000n, vault: -315_000_000n });
      const o = await orderOf(h);
      expect(o.state).to.equal(STATE.RELEASED);
      expect(o.resolution).to.equal(RESOLUTION.CONFIRMED);
      expect(o.endedAt.toNumber()).to.be.greaterThan(0);
    });

    it("a released order cannot be executed again", async () => {
      await fail(confirm(h), "InvalidState");
      await fail(releaseAfterWindow(h), "InvalidState");
      await fail(refundUnshipped(h), "InvalidState");
      await fail(dispute(h, h.buyer), "InvalidState");
      await fail(propose(h, h.buyer, 1n), "InvalidState");
      await fail(executeRuling(h), "InvalidState");
    });

    it("collect_fees forwards the fee vault to the fee recipient only", async () => {
      const accounts = (mint: PublicKey, dest = ata(KEYS.feeRecipient.publicKey, mint)) => ({ config, mint, feeVault: feeVault(mint), feeDestination: dest, tokenProgram: TOKEN_PROGRAM_ID });
      await fail(program.methods.collectFees().accountsStrict(accounts(USDC, ata(stranger.publicKey, USDC))).rpc(), "ConstraintTokenOwner");
      const before = await bal(ata(KEYS.feeRecipient.publicKey, USDC));
      const inVault = await bal(feeVault(USDC));
      expect(inVault >= 24_000_000n).to.be.true;
      await program.methods.collectFees().accountsStrict(accounts(USDC)).rpc(); // no signer: anyone may send it
      expect(await bal(feeVault(USDC))).to.equal(0n);
      expect((await bal(ata(KEYS.feeRecipient.publicKey, USDC))) - before).to.equal(inVault);
      // an empty vault is a no-op
      await program.methods.collectFees().accountsStrict(accounts(USDC)).rpc();
    });

    it("close_order waits for the offer to expire, then returns all rent to the rent payer", async () => {
      await fail(closeOrder(h), "OfferNotExpired");
      await waitForChainTime(connection, h.terms!.expiry + 2);
      await fail(closeOrder(h, { rentPayer: stranger.publicKey }), "RentPayerMismatch");
      const before = await lamports(sponsor.publicKey);
      await closeOrder(h);
      expect((await lamports(sponsor.publicKey)) - before).to.equal(rentExempt(MARKET_ORDER_LEN) + rentExempt(165));
      await expectGone(h.order);
      await expectGone(h.vault);
      // the same offer cannot be replayed now: it has expired
      await fail(openBuilder(h.buyer, h.terms!).rpc(), "OfferExpired");
      await expectRejected(closeOrder(h));
    });

    it("a live order cannot be closed", async () => {
      const x = await open();
      await fail(closeOrder(x), "InvalidState");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("not shipped: refund after the ship deadline", () => {
    it("live order: no refund before the deadline, no dispute before shipping", async () => {
      const h = await open();
      await fail(refundUnshipped(h), "ShipDeadlineNotPassed");
      await fail(dispute(h, h.buyer), "InvalidState");
      await fail(confirm(h), "InvalidState");
      await fail(propose(h, h.buyer, 0n), "InvalidState");
    });

    it("fixture past its deadline: the seller can no longer ship, anyone refunds the buyer in full", async () => {
      const h = fixture("unshipped");
      await fail(markShipped(h), "ShipDeadlinePassed");
      await fail(refundUnshipped(h, ata(stranger.publicKey, h.mint)), "ConstraintTokenOwner");
      const d = await deltas(h, () => refundUnshipped(h)); // sent by the provider wallet, not the buyer
      expect(d).to.deep.equal({ buyer: FIXTURE_DEPOSIT, seller: 0n, fees: 0n, vault: -FIXTURE_DEPOSIT });
      const o = await orderOf(h);
      expect([o.state, o.resolution]).to.deep.equal([STATE.REFUNDED, RESOLUTION.UNSHIPPED]);
      await fail(refundUnshipped(h), "InvalidState");
      await fail(markShipped(h), "InvalidState");
    });

    it("fixture: the refunded order is closed and the sponsor gets its rent back", async () => {
      const h = fixture("unshipped");
      const before = await lamports(h.rentPayer);
      await closeOrder(h);
      expect((await lamports(h.rentPayer)) - before).to.equal(rentExempt(MARKET_ORDER_LEN) + rentExempt(165));
      await expectGone(h.order);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("review window: dispute inside it, release after it", () => {
    it("live order: no release while the window is open; only the buyer or the arbiter may dispute", async () => {
      const h = await open();
      await markShipped(h);
      await fail(releaseAfterWindow(h), "ReviewWindowOpen");
      await fail(dispute(h, h.seller), "NotParty");
      await fail(dispute(h, stranger), "NotParty");
    });

    it("fixture past its window: no dispute any more, anyone releases to the seller", async () => {
      const h = fixture("window");
      await fail(dispute(h, h.buyer), "ReviewWindowClosed");
      await fail(dispute(h, KEYS.arbiter), "ReviewWindowClosed");
      const d = await deltas(h, () => releaseAfterWindow(h));
      expect(d).to.deep.equal({ buyer: 0n, seller: FIXTURE_AMOUNT - FIXTURE_SELLER_FEE, fees: FIXTURE_BUYER_FEE + FIXTURE_SELLER_FEE, vault: -FIXTURE_DEPOSIT });
      const o = await orderOf(h);
      expect([o.state, o.resolution]).to.deep.equal([STATE.RELEASED, RESOLUTION.WINDOW]);
      await fail(releaseAfterWindow(h), "InvalidState");
      await fail(confirm(h), "InvalidState");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("dispute, ruling and timelock", () => {
    let h: H;
    it("the buyer disputes: the order halts, nothing moves", async () => {
      h = await open();
      await markShipped(h);
      const d = await deltas(h, () => dispute(h, h.buyer));
      expect(d).to.deep.equal({ buyer: 0n, seller: 0n, fees: 0n, vault: 0n });
      const o = await orderOf(h);
      expect([o.state, o.disputedBy]).to.deep.equal([STATE.DISPUTED, PARTY.BUYER]);
      expect(Math.abs(o.disputedAt.toNumber() - (await chainTime(connection)))).to.be.lessThan(30);
      await fail(dispute(h, h.buyer), "InvalidState");
      await fail(releaseAfterWindow(h), "InvalidState");
      await fail(refundAfterTmax(h), "RulingDeadlineNotPassed");
    });

    it("only the arbiter rules, only RELEASE or REFUND, only with a reason hash", async () => {
      await fail(rule(h, RULING.REFUND, FIXTURE_REASON_HASH, h.buyer), "NotArbiter");
      await fail(rule(h, RULING.REFUND, FIXTURE_REASON_HASH, h.seller), "NotArbiter");
      await fail(rule(h, RULING.REFUND, FIXTURE_REASON_HASH, KEYS.offer), "NotArbiter");
      await fail(rule(h, RULING.NONE), "InvalidRuling");
      await fail(rule(h, 3), "InvalidRuling");
      await fail(rule(h, RULING.RELEASE, Buffer.alloc(32)), "MissingReasonHash");
      const d = await deltas(h, () => rule(h, RULING.RELEASE));
      expect(d).to.deep.equal({ buyer: 0n, seller: 0n, fees: 0n, vault: 0n });
      const o = await orderOf(h);
      expect([o.state, o.ruling]).to.deep.equal([STATE.RULED, RULING.RELEASE]);
      expect(Buffer.from(o.reasonHash).equals(FIXTURE_REASON_HASH)).to.be.true;
      expect(Math.abs(o.ruledAt.toNumber() - (await chainTime(connection)))).to.be.lessThan(30);
      await fail(rule(h, RULING.REFUND), "InvalidState");
    });

    it("during the timelock nothing but a settlement is possible", async () => {
      await fail(executeRuling(h), "TimelockActive");
      await fail(confirm(h), "InvalidState");
      await fail(dispute(h, h.buyer), "InvalidState");
      await fail(refundAfterTmax(h), "InvalidState");
      await fail(releaseAfterWindow(h), "InvalidState");
      await propose(h, h.seller, 100_000_000n);
      const d = await deltas(h, () => accept(h, h.buyer, 100_000_000n));
      expect(d).to.deep.equal({ buyer: 100_000_000n, seller: 215_000_000n, fees: 0n, vault: -315_000_000n });
      const o = await orderOf(h);
      expect([o.state, o.resolution]).to.deep.equal([STATE.SETTLED, RESOLUTION.SETTLEMENT]);
      await fail(executeRuling(h), "InvalidState");
      await fail(accept(h, h.buyer, 100_000_000n), "InvalidState");
    });

    it("the arbiter may open a dispute too; the buyer may withdraw it by confirming", async () => {
      const x = await open();
      await markShipped(x);
      await dispute(x, KEYS.arbiter);
      expect((await orderOf(x)).disputedBy).to.equal(PARTY.ARBITER);
      await fail(confirm(x, x.seller), "NotBuyer");
      const d = await deltas(x, () => confirm(x));
      expect(d).to.deep.equal({ buyer: 0n, seller: 291_000_000n, fees: 24_000_000n, vault: -315_000_000n });
      expect((await orderOf(x)).resolution).to.equal(RESOLUTION.CONFIRMED);
    });

    it("fixture after the timelock: anyone executes a RELEASE ruling (seller + fees, here in EURC)", async () => {
      const r = fixture("ruled-release");
      await fail(refundAfterTmax(r), "InvalidState");
      await fail(executeRuling(r, { buyer: true }), "MissingTokenAccount");
      const d = await deltas(r, () => executeRuling(r, { seller: true }));
      expect(d).to.deep.equal({ buyer: 0n, seller: FIXTURE_AMOUNT - FIXTURE_SELLER_FEE, fees: FIXTURE_BUYER_FEE + FIXTURE_SELLER_FEE, vault: -FIXTURE_DEPOSIT });
      const o = await orderOf(r);
      expect([o.state, o.resolution]).to.deep.equal([STATE.RELEASED, RESOLUTION.RULING_RELEASE]);
      await fail(executeRuling(r), "InvalidState");
      await fail(propose(r, r.buyer, 0n), "InvalidState");
    });

    it("fixture after the timelock: anyone executes a REFUND ruling (everything to the buyer, no fees)", async () => {
      const r = fixture("ruled-refund");
      await fail(executeRuling(r, { seller: true }), "MissingTokenAccount");
      const d = await deltas(r, () => executeRuling(r, { buyer: true }));
      expect(d).to.deep.equal({ buyer: FIXTURE_DEPOSIT, seller: 0n, fees: 0n, vault: -FIXTURE_DEPOSIT });
      const o = await orderOf(r);
      expect([o.state, o.resolution]).to.deep.equal([STATE.REFUNDED, RESOLUTION.RULING_REFUND]);
      await fail(executeRuling(r), "InvalidState");
    });

    it("fixture past T_max without a ruling: the arbiter is too late, anyone refunds the buyer", async () => {
      const t = fixture("tmax");
      await fail(rule(t, RULING.RELEASE), "RulingDeadlinePassed");
      const d = await deltas(t, () => refundAfterTmax(t));
      expect(d).to.deep.equal({ buyer: FIXTURE_DEPOSIT, seller: 0n, fees: 0n, vault: -FIXTURE_DEPOSIT });
      const o = await orderOf(t);
      expect([o.state, o.resolution]).to.deep.equal([STATE.REFUNDED, RESOLUTION.TMAX]);
      await fail(refundAfterTmax(t), "InvalidState");
      await fail(rule(t, RULING.RELEASE), "InvalidState");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("settlement between buyer and seller", () => {
    let h: H;
    it("needs a dispute first; only buyer and seller propose, at most the deposit", async () => {
      h = await open();
      await markShipped(h);
      await fail(propose(h, h.buyer, 10n), "InvalidState");
      await dispute(h, h.buyer);
      await fail(propose(h, KEYS.arbiter, 10n), "NotParty");
      await fail(propose(h, stranger, 10n), "NotParty");
      await fail(propose(h, h.buyer, 315_000_001n), "SettlementTooLarge");
      await fail(accept(h, h.seller, 0n), "NoProposal");
    });

    it("a party cannot accept its own proposal; a counter-offer replaces it; the accepted amount must match", async () => {
      await propose(h, h.buyer, 200_000_000n);
      let o = await orderOf(h);
      expect([o.proposalBy, o.proposalToBuyer.toString()]).to.deep.equal([PARTY.BUYER, "200000000"]);
      await fail(accept(h, h.buyer, 200_000_000n), "OwnProposal");
      await propose(h, h.seller, 120_000_000n);
      o = await orderOf(h);
      expect([o.proposalBy, o.proposalToBuyer.toString()]).to.deep.equal([PARTY.SELLER, "120000000"]);
      await fail(accept(h, h.buyer, 200_000_000n), "ProposalMismatch");
      await fail(accept(h, KEYS.arbiter, 120_000_000n), "NotParty");
      await fail(accept(h, stranger, 120_000_000n), "NotParty");
    });

    it("the accepted split pays buyer and seller, no fees", async () => {
      const d = await deltas(h, () => accept(h, h.buyer, 120_000_000n));
      expect(d).to.deep.equal({ buyer: 120_000_000n, seller: 195_000_000n, fees: 0n, vault: -315_000_000n });
      const o = await orderOf(h);
      expect([o.state, o.resolution]).to.deep.equal([STATE.SETTLED, RESOLUTION.SETTLEMENT]);
      await fail(accept(h, h.buyer, 120_000_000n), "InvalidState");
      await fail(confirm(h), "InvalidState");
      await fail(rule(h, RULING.REFUND), "InvalidState");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("close_order", () => {
    it("tokens sent to an emptied vault go to the buyer; the rent goes to the rent payer", async () => {
      const h = fixture("dust");
      await fail(closeOrder(h), "MissingTokenAccount");
      await fail(closeOrder(h, { buyerToken: true, rentPayer: stranger.publicKey }), "RentPayerMismatch");
      const buyerBefore = await bal(ata(h.buyer.publicKey, h.mint));
      const rentBefore = await lamports(h.rentPayer);
      await closeOrder(h, { buyerToken: true });
      expect((await bal(ata(h.buyer.publicKey, h.mint))) - buyerBefore).to.equal(1n);
      expect((await lamports(h.rentPayer)) - rentBefore).to.equal(rentExempt(MARKET_ORDER_LEN) + rentExempt(165));
      await expectGone(h.order);
      await expectGone(h.vault);
    });

    it("terminal fixtures close too (refund, ruling, T_max)", async () => {
      for (const label of ["window", "ruled-release", "ruled-refund", "tmax"] as FixtureLabel[]) {
        await closeOrder(fixture(label));
        await expectGone(fx[label].order);
      }
    });

    it("the EURC fees of the executed ruling reach the fee recipient", async () => {
      const before = await bal(ata(KEYS.feeRecipient.publicKey, EURC));
      await program.methods
        .collectFees()
        .accountsStrict({ config, mint: EURC, feeVault: feeVault(EURC), feeDestination: ata(KEYS.feeRecipient.publicKey, EURC), tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();
      expect((await bal(ata(KEYS.feeRecipient.publicKey, EURC))) - before).to.equal(FIXTURE_BUYER_FEE + FIXTURE_SELLER_FEE);
      expect(await bal(feeVault(EURC))).to.equal(0n);
    });
  });
});
