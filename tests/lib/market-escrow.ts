/**
 * TEST ONLY helpers for programs/market_escrow, shared by tests/market-escrow.ts and the fixture
 * generator scripts/market-escrow-fixtures.ts. Every key here is derived from a public label: they are
 * known to everybody and must never hold value or be configured outside a local validator.
 *
 * The offer message builder is the TypeScript reference for the server (layout in
 * programs/market_escrow/src/offer.rs and docs/market-escrow.md).
 */
import { BN } from "@anchor-lang/core";
import { Ed25519Program, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "crypto";
import nacl from "tweetnacl";

export const MARKET_ESCROW_PROGRAM_ID = new PublicKey("CeyUTXX5CbgUNPM1msfnp6UfLdNh8PGLm8DpvdYJsEXW");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** Deterministic TEST ONLY keypair. */
export const testKey = (label: string) => Keypair.fromSeed(sha256(`flaconvault/market_escrow/test/${label}`));

export const KEYS = {
  offer: testKey("offer-key"),
  arbiter: testKey("arbiter"),
  feeRecipient: testKey("fee-recipient"),
  mintAuthority: testKey("mint-authority"),
  usdc: testKey("mint-usdc"),
  eurc: testKey("mint-eurc"),
  fixtureBuyer: testKey("fixture-buyer"),
  fixtureSeller: testKey("fixture-seller"),
  fixtureSponsor: testKey("fixture-sponsor"),
};

// mirrors programs/market_escrow/src/constants.rs (asserted against the IDL in tests/market-escrow.ts)
export const STATE = { PAID: 1, SHIPPED: 2, DISPUTED: 3, RULED: 4, RELEASED: 5, REFUNDED: 6, SETTLED: 7 };
export const RESOLUTION = { NONE: 0, CONFIRMED: 1, WINDOW: 2, RULING_RELEASE: 3, UNSHIPPED: 4, RULING_REFUND: 5, TMAX: 6, SETTLEMENT: 7 };
export const LANE = { S: 1, A: 2, G: 3 };
export const RULING = { NONE: 0, RELEASE: 1, REFUND: 2 };
export const PARTY = { NONE: 0, BUYER: 1, SELLER: 2, ARBITER: 3 };
export const HOUR = 3600;
export const DAY = 86400;
export const REVIEW_WINDOW_S = { [LANE.S]: 10 * DAY, [LANE.A]: 14 * DAY } as Record<number, number>;
export const OFFER_PREFIX = "FVMKTOF1";
export const OFFER_LEN = 201;

// ---- PDAs ----------------------------------------------------------------------------

export const configPda = (programId = MARKET_ESCROW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
export const orderPda = (buyer: PublicKey, orderId: Buffer, programId = MARKET_ESCROW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("morder"), buyer.toBuffer(), orderId], programId);
export const vaultPda = (order: PublicKey, programId = MARKET_ESCROW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), order.toBuffer()], programId);
export const feeVaultPda = (mint: PublicKey, programId = MARKET_ESCROW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("fees"), mint.toBuffer()], programId);

// ---- signed offer ------------------------------------------------------------------------

export interface OfferTerms {
  orderId: Buffer; // 16 random bytes
  seller: PublicKey;
  amount: bigint;
  buyerFee: bigint;
  sellerFee: bigint;
  lane: number;
  shipDeadline: number;
  rulingWindowS: number;
  timelockS: number;
  expiry: number;
}

/** The 201 bytes the offer key signs (programs/market_escrow/src/offer.rs). */
export function offerMessage(programId: PublicKey, buyer: PublicKey, mint: PublicKey, t: OfferTerms): Buffer {
  if (t.orderId.length !== 16) throw new Error("orderId must be 16 bytes");
  const b = Buffer.alloc(OFFER_LEN);
  let o = b.write(OFFER_PREFIX, 0, "ascii");
  for (const k of [programId, null, buyer, t.seller, mint]) {
    if (k === null) o += t.orderId.copy(b, o);
    else o += k.toBuffer().copy(b, o);
  }
  o = b.writeBigUInt64LE(t.amount, o);
  o = b.writeBigUInt64LE(t.buyerFee, o);
  o = b.writeBigUInt64LE(t.sellerFee, o);
  o = b.writeUInt8(t.lane, o);
  o = b.writeBigInt64LE(BigInt(t.shipDeadline), o);
  o = b.writeUInt32LE(t.rulingWindowS, o);
  o = b.writeUInt32LE(t.timelockS, o);
  o = b.writeBigInt64LE(BigInt(t.expiry), o);
  if (o !== OFFER_LEN) throw new Error(`offer message is ${o} bytes`);
  return b;
}

/** `OfferArgs` as the Anchor client expects it. */
export const offerArgs = (t: OfferTerms) => ({
  orderId: Array.from(t.orderId),
  seller: t.seller,
  amount: new BN(t.amount.toString()),
  buyerFee: new BN(t.buyerFee.toString()),
  sellerFee: new BN(t.sellerFee.toString()),
  lane: t.lane,
  shipDeadline: new BN(t.shipDeadline),
  rulingWindowS: t.rulingWindowS,
  timelockS: t.timelockS,
  expiry: new BN(t.expiry),
});

/** Ed25519 precompile instruction carrying `signer`'s signature over `message` (pubkey defaults to the signer's). */
export function offerSignatureIx(signer: Keypair, message: Buffer, claimedPubkey: PublicKey = signer.publicKey): TransactionInstruction {
  const signature = nacl.sign.detached(message, signer.secretKey);
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: claimedPubkey.toBytes(), message, signature });
}

// ---- raw account layouts (fixtures) -------------------------------------------------------

export const rentExempt = (len: number) => (128 + len) * 3480 * 2;

/** SPL Token `Mint` (82 bytes): mint authority, supply, decimals, no freeze authority. */
export function mintData(authority: PublicKey, supply: bigint, decimals = 6): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(1, 0);
  authority.toBuffer().copy(b, 4);
  b.writeBigUInt64LE(supply, 36);
  b[44] = decimals;
  b[45] = 1; // is_initialized
  return b;
}

/** SPL Token `Account` (165 bytes), initialized, no delegate or close authority. */
export function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b[108] = 1; // AccountState::Initialized
  return b;
}

export interface OrderFields {
  orderId: Buffer;
  buyer: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  rentPayer: PublicKey;
  amount: bigint;
  buyerFee: bigint;
  sellerFee: bigint;
  lane: number;
  state: number;
  resolution: number;
  reviewWindowS: number;
  rulingWindowS: number;
  timelockS: number;
  shipDeadline: number;
  offerExpiry: number;
  openedAt: number;
  shippedAt: number;
  disputedAt: number;
  disputedBy: number;
  ruledAt: number;
  ruling: number;
  reasonHash: Buffer;
  proposalBy: number;
  proposalToBuyer: bigint;
  endedAt: number;
  bump: number;
  vaultBump: number;
}

export const MARKET_ORDER_LEN = 292;

/**
 * `MarketOrder` written by hand at the offsets documented in programs/market_escrow/src/state.rs;
 * tests/market-escrow.ts reads every fixture back through the Anchor coder, which checks the layout.
 */
export function marketOrderData(f: OrderFields): Buffer {
  const b = Buffer.alloc(MARKET_ORDER_LEN);
  sha256("account:MarketOrder").subarray(0, 8).copy(b, 0);
  f.orderId.copy(b, 8);
  f.buyer.toBuffer().copy(b, 24);
  f.seller.toBuffer().copy(b, 56);
  f.mint.toBuffer().copy(b, 88);
  f.rentPayer.toBuffer().copy(b, 120);
  b.writeBigUInt64LE(f.amount, 152);
  b.writeBigUInt64LE(f.buyerFee, 160);
  b.writeBigUInt64LE(f.sellerFee, 168);
  b[176] = f.lane;
  b[177] = f.state;
  b[178] = f.resolution;
  b.writeUInt32LE(f.reviewWindowS, 179);
  b.writeUInt32LE(f.rulingWindowS, 183);
  b.writeUInt32LE(f.timelockS, 187);
  b.writeBigInt64LE(BigInt(f.shipDeadline), 191);
  b.writeBigInt64LE(BigInt(f.offerExpiry), 199);
  b.writeBigInt64LE(BigInt(f.openedAt), 207);
  b.writeBigInt64LE(BigInt(f.shippedAt), 215);
  b.writeBigInt64LE(BigInt(f.disputedAt), 223);
  b[231] = f.disputedBy;
  b.writeBigInt64LE(BigInt(f.ruledAt), 232);
  b[240] = f.ruling;
  f.reasonHash.copy(b, 241);
  b[273] = f.proposalBy;
  b.writeBigUInt64LE(f.proposalToBuyer, 274);
  b.writeBigInt64LE(BigInt(f.endedAt), 282);
  b[290] = f.bump;
  b[291] = f.vaultBump;
  return b;
}

// ---- aged fixture orders (loaded at genesis, Anchor.toml [[test.validator.account_dir]]) ---------
//
// The local validator cannot move its clock, so the branches that only open days after a step run on
// orders that reached that step on 2026-01-01: their deadlines have passed whenever the tests run.
// tests/market-escrow.ts covers the "not yet" side of each branch on live orders.

export const FIXTURE_T0 = 1_767_225_600; // 2026-01-01T00:00:00Z
export const FIXTURE_AMOUNT = 100_000_000n; // 100.00
export const FIXTURE_BUYER_FEE = 5_000_000n;
export const FIXTURE_SELLER_FEE = 3_000_000n;
export const FIXTURE_DEPOSIT = FIXTURE_AMOUNT + FIXTURE_BUYER_FEE;
export const FIXTURE_REASON_HASH = sha256("fixture ruling: published reasons");

export type FixtureLabel = "unshipped" | "window" | "ruled-release" | "ruled-refund" | "tmax" | "dust";

export interface Fixture {
  label: FixtureLabel;
  order: PublicKey;
  vault: PublicKey;
  fields: OrderFields;
  vaultAmount: bigint;
}

export function fixtureOrders(programId = MARKET_ESCROW_PROGRAM_ID): Fixture[] {
  const T0 = FIXTURE_T0;
  const specs: { label: FixtureLabel; mint: PublicKey; f: Partial<OrderFields>; vaultAmount?: bigint }[] = [
    { label: "unshipped", mint: KEYS.usdc.publicKey, f: { state: STATE.PAID } },
    { label: "window", mint: KEYS.usdc.publicKey, f: { state: STATE.SHIPPED, lane: LANE.A, shippedAt: T0 + DAY } },
    {
      label: "ruled-release",
      mint: KEYS.eurc.publicKey,
      f: { state: STATE.RULED, shippedAt: T0 + DAY, disputedAt: T0 + 2 * DAY, disputedBy: PARTY.BUYER, ruledAt: T0 + 3 * DAY, ruling: RULING.RELEASE, reasonHash: FIXTURE_REASON_HASH },
    },
    {
      label: "ruled-refund",
      mint: KEYS.usdc.publicKey,
      f: { state: STATE.RULED, shippedAt: T0 + DAY, disputedAt: T0 + 2 * DAY, disputedBy: PARTY.ARBITER, ruledAt: T0 + 3 * DAY, ruling: RULING.REFUND, reasonHash: FIXTURE_REASON_HASH },
    },
    { label: "tmax", mint: KEYS.usdc.publicKey, f: { state: STATE.DISPUTED, shippedAt: T0 + DAY, disputedAt: T0 + 2 * DAY, disputedBy: PARTY.BUYER } },
    {
      label: "dust",
      mint: KEYS.usdc.publicKey,
      f: { state: STATE.RELEASED, resolution: RESOLUTION.CONFIRMED, shippedAt: T0 + DAY, endedAt: T0 + 3 * DAY },
      vaultAmount: 1n, // someone sent tokens to the vault after the payout
    },
  ];
  return specs.map(({ label, mint, f, vaultAmount }) => {
    const orderId = sha256(`fixture order ${label}`).subarray(0, 16);
    const buyer = KEYS.fixtureBuyer.publicKey;
    const [order, bump] = orderPda(buyer, orderId, programId);
    const [vault, vaultBump] = vaultPda(order, programId);
    const lane = f.lane ?? LANE.S;
    const fields: OrderFields = {
      orderId,
      buyer,
      seller: KEYS.fixtureSeller.publicKey,
      mint,
      rentPayer: KEYS.fixtureSponsor.publicKey,
      amount: FIXTURE_AMOUNT,
      buyerFee: FIXTURE_BUYER_FEE,
      sellerFee: FIXTURE_SELLER_FEE,
      lane,
      state: STATE.PAID,
      resolution: RESOLUTION.NONE,
      reviewWindowS: REVIEW_WINDOW_S[lane],
      rulingWindowS: 7 * DAY,
      timelockS: 48 * HOUR,
      shipDeadline: T0 + 5 * DAY,
      offerExpiry: T0 + 600,
      openedAt: T0,
      shippedAt: 0,
      disputedAt: 0,
      disputedBy: PARTY.NONE,
      ruledAt: 0,
      ruling: RULING.NONE,
      reasonHash: Buffer.alloc(32),
      proposalBy: PARTY.NONE,
      proposalToBuyer: 0n,
      endedAt: 0,
      bump,
      vaultBump,
      ...f,
    };
    return { label, order, vault, fields, vaultAmount: vaultAmount ?? FIXTURE_DEPOSIT };
  });
}

export interface AccountJson {
  pubkey: string;
  account: { lamports: number; data: [string, "base64"]; owner: string; executable: false; rentEpoch: 0; space: number };
}

const accountJson = (pubkey: PublicKey, owner: PublicKey, data: Buffer): AccountJson => ({
  pubkey: pubkey.toBase58(),
  account: { lamports: rentExempt(data.length), data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
});

/** Every genesis account of the market escrow tests: the two test mints, the fixture orders and their vaults. */
export function fixtureAccounts(programId = MARKET_ESCROW_PROGRAM_ID): Record<string, AccountJson> {
  const fixtures = fixtureOrders(programId);
  const supply = (mint: PublicKey) => fixtures.filter((x) => x.fields.mint.equals(mint)).reduce((s, x) => s + x.vaultAmount, 0n);
  const out: Record<string, AccountJson> = {
    "mint-usdc": accountJson(KEYS.usdc.publicKey, TOKEN_PROGRAM_ID, mintData(KEYS.mintAuthority.publicKey, supply(KEYS.usdc.publicKey))),
    "mint-eurc": accountJson(KEYS.eurc.publicKey, TOKEN_PROGRAM_ID, mintData(KEYS.mintAuthority.publicKey, supply(KEYS.eurc.publicKey))),
  };
  for (const x of fixtures) {
    out[`order-${x.label}`] = accountJson(x.order, programId, marketOrderData(x.fields));
    out[`vault-${x.label}`] = accountJson(x.vault, TOKEN_PROGRAM_ID, tokenAccountData(x.fields.mint, x.order, x.vaultAmount));
  }
  return out;
}
