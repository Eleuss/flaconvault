import { AnchorProvider, BN, Program, type Idl } from "@anchor-lang/core";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import escrowIdl from "@flaconvault/proof/idl/escrow.json";
import { MPL_CORE_PROGRAM_ID } from "./flacon";
import { OrderState, formatUsdc } from "./escrow-rules";

export { OrderState } from "./escrow-rules";
export const ESCROW_PROGRAM_ID = process.env.NEXT_PUBLIC_ESCROW_PROGRAM_ID ?? (escrowIdl as { address: string }).address;
const enc = (s: string) => new TextEncoder().encode(s);

export const orderStateLabel: Record<number, string> = {
  0: "Listed", 1: "Reserved", 2: "Shipping scan recorded", 3: "Shipped", 4: "Receipt scan recorded",
  5: "Released", 6: "Mismatch", 7: "Dispute", 8: "Cancelled",
};
export const orderStateTone = (s: number): "ok" | "warn" | "bad" | "none" =>
  s === OrderState.RELEASED ? "ok" : s === OrderState.MISMATCH || s === OrderState.DISPUTE ? "bad" : s === OrderState.CANCELLED ? "none" : "warn";
export const FILL_TOLERANCE = 5;

export const escrowProgramId = () => new PublicKey(ESCROW_PROGRAM_ID);
export const configPda = () => PublicKey.findProgramAddressSync([enc("config")], escrowProgramId())[0];
export const orderPda = (passport: PublicKey, seller: PublicKey) => PublicKey.findProgramAddressSync([enc("order"), passport.toBytes(), seller.toBytes()], escrowProgramId())[0];
export const vaultPda = (order: PublicKey) => PublicKey.findProgramAddressSync([enc("vault"), order.toBytes()], escrowProgramId())[0];
export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
/** Creates `owner`'s USDC account if it is missing (no-op otherwise); `payer` pays the rent. */
export const ensureAtaIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);

/** Read-only wallet for public listings and the Blink endpoint. */
const readOnlyWallet = (): AnchorWallet => {
  const pk = Keypair.generate().publicKey;
  return { publicKey: pk, signTransaction: async <T extends Transaction | VersionedTransaction>(t: T) => t, signAllTransactions: async <T extends Transaction | VersionedTransaction>(t: T[]) => t };
};
export function escrowProgram(connection: Connection, wallet?: AnchorWallet): Program {
  const provider = new AnchorProvider(connection, wallet ?? readOnlyWallet(), { commitment: "confirmed" });
  return new Program(escrowIdl as Idl, provider);
}

export interface EscrowConfigView { admin: string; usdcMint: PublicKey; disputeAfterS: number }
export interface OrderView {
  pubkey: PublicKey; passport: PublicKey; seller: PublicKey; buyer: PublicKey | null; asset: PublicKey;
  /** USDC for display; `priceBase` (6 dp base units) is what goes on chain. */
  priceUsdc: number; priceBase: bigint; state: number; listedAt: number; reservedAt: number; shippedAt: number;
  sellerScan: PublicKey | null; buyerScan: PublicKey | null; disputeAfterS: number; assetDeposited: boolean;
}
const nz = (k: PublicKey) => (k.equals(PublicKey.default) ? null : k);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (pubkey: PublicKey, a: any): OrderView => {
  const priceBase = BigInt(a.price.toString());
  return {
    pubkey, passport: a.passport, seller: a.seller, buyer: nz(a.buyer), asset: a.asset,
    priceUsdc: Number(formatUsdc(priceBase)), priceBase, state: a.state, listedAt: Number(a.listedAt), reservedAt: Number(a.reservedAt),
    shippedAt: Number(a.shippedAt), sellerScan: nz(a.sellerScan), buyerScan: nz(a.buyerScan), disputeAfterS: Number(a.disputeAfterS), assetDeposited: !!a.assetDeposited,
  };
};
export async function fetchConfig(program: Program): Promise<EscrowConfigView | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (program.account as any).escrowConfig.fetchNullable(configPda());
  return c ? { admin: c.admin.toBase58(), usdcMint: c.usdcMint, disputeAfterS: Number(c.disputeAfterS) } : null;
}
/** One order by its PDA (null when it does not exist / was closed). */
export async function fetchOrder(program: Program, pubkey: PublicKey): Promise<OrderView | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a: any = await (program.account as any).order.fetchNullable(pubkey);
  return a ? toView(pubkey, a) : null;
}
/** All orders (newest first); with `passport`, only that passport's orders (memcmp on Order.passport @ 8). */
export async function fetchOrders(program: Program, filter: { passport?: PublicKey } = {}): Promise<OrderView[]> {
  const filters = filter.passport ? [{ memcmp: { offset: 8, bytes: filter.passport.toBase58() } }] : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: Array<{ publicKey: PublicKey; account: any }> = await (program.account as any).order.all(filters);
  return all.map((o) => toView(o.publicKey, o.account)).sort((a, b) => b.listedAt - a.listedAt);
}

/** Optional accounts are passed as null; the untyped Program's accountsStrict typing does not know that. */
const acc = (o: Record<string, PublicKey | null>) => o as never;
/** The Core asset accounts when the asset sits in the order's custody (else null: the program skips the transfer). */
const custody = (o: OrderView) => (o.assetDeposited ? { asset: o.asset, mplCoreProgram: MPL_CORE_PROGRAM_ID } : { asset: null, mplCoreProgram: null });
const releaseAccounts = (o: OrderView, caller: PublicKey, usdcMint: PublicKey) => acc({
  config: configPda(), order: o.pubkey, vault: vaultPda(o.pubkey), sellerToken: ata(o.seller, usdcMint), buyer: o.buyer!, caller,
  ...custody(o), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
});

/**
 * Instruction builders — each returns the Anchor method builder. In the browser: `.transaction()` → `sendAsV0` (v0; legacy
 * `.rpc()` fails with mobile wallets). Payout paths prepend createAssociatedTokenAccountIdempotent for the recipient, so a
 * seller (or buyer) who never held the USDC mint does not leave the funds stuck.
 */
export const escrowIx = {
  /** `asset` = passport.asset: the program checks that the seller owns it (or is the issuer when no Core asset exists). */
  list: (p: Program, passport: PublicKey, seller: PublicKey, priceBase: bigint, asset: PublicKey) =>
    p.methods.list(new BN(priceBase.toString())).accountsStrict({ config: configPda(), passport, order: orderPda(passport, seller), seller, systemProgram: SystemProgram.programId, asset }),
  /** Moves the seller's Core asset into the order's custody (it goes to the buyer on release). */
  depositAsset: (p: Program, order: PublicKey, seller: PublicKey, asset: PublicKey) =>
    p.methods.depositAsset().accountsStrict({ order, seller, asset, mplCoreProgram: MPL_CORE_PROGRAM_ID, systemProgram: SystemProgram.programId }),
  cancel: (p: Program, o: OrderView) =>
    p.methods.cancel().accountsStrict(acc({ order: o.pubkey, seller: o.seller, ...custody(o), systemProgram: SystemProgram.programId })),
  /** Seller reclaims a terminal order account (needed before the same seller can list the passport again). */
  closeOrder: (p: Program, o: OrderView) => p.methods.closeOrder().accountsStrict({ order: o.pubkey, seller: o.seller }),
  /** `expectedPrice` defaults to the price the page shows: a re-listing at another price makes the reservation fail. */
  reserve: (p: Program, o: OrderView, buyer: PublicKey, usdcMint: PublicKey, expectedPrice: bigint = o.priceBase) =>
    p.methods.reserve(new BN(expectedPrice.toString())).accountsStrict({
      config: configPda(), order: o.pubkey, buyer, buyerToken: ata(buyer, usdcMint), usdcMint, vault: vaultPda(o.pubkey),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, passport: o.passport,
    }),
  preShip: (p: Program, o: OrderView, scanProof: PublicKey, seal: PublicKey) =>
    p.methods.recordPreShipScan().accountsStrict({ order: o.pubkey, seller: o.seller, scanProof, seal }),
  ship: (p: Program, o: OrderView) => p.methods.ship().accountsStrict({ order: o.pubkey, seller: o.seller }),
  receipt: (p: Program, o: OrderView, scanProof: PublicKey, seal: PublicKey) =>
    p.methods.recordReceiptScan().accountsStrict({ order: o.pubkey, buyer: o.buyer!, scanProof, seal, sellerScan: o.sellerScan! }),
  release: (p: Program, o: OrderView, caller: PublicKey, usdcMint: PublicKey) =>
    p.methods.release().accountsStrict(releaseAccounts(o, caller, usdcMint)).preInstructions([ensureAtaIx(caller, o.seller, usdcMint)]),
  /** SHIPPED and no receipt scan within the window: anyone pays the seller. */
  releaseAfterTimeout: (p: Program, o: OrderView, caller: PublicKey, usdcMint: PublicKey) =>
    p.methods.releaseAfterTimeout().accountsStrict(releaseAccounts(o, caller, usdcMint)).preInstructions([ensureAtaIx(caller, o.seller, usdcMint)]),
  /** Refund to the buyer: admin, seller did not ship in time, or a dead `seal` of the passport. */
  dispute: (p: Program, o: OrderView, signer: PublicKey, usdcMint: PublicKey, seal: PublicKey | null) =>
    p.methods.dispute().accountsStrict(acc({
      config: configPda(), order: o.pubkey, vault: vaultPda(o.pubkey), buyerToken: ata(o.buyer!, usdcMint), buyer: o.buyer!, seller: o.seller, signer, seal,
      ...custody(o), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })).preInstructions([ensureAtaIx(signer, o.buyer!, usdcMint)]),
  /** Escrow admin settles a MISMATCH: `toSeller` pays the seller, otherwise the buyer is refunded. */
  resolve: (p: Program, o: OrderView, admin: PublicKey, usdcMint: PublicKey, toSeller: boolean) => {
    const recipient = toSeller ? o.seller : o.buyer!;
    return p.methods.resolve(toSeller).accountsStrict(acc({
      config: configPda(), order: o.pubkey, vault: vaultPda(o.pubkey), recipientToken: ata(recipient, usdcMint), buyer: o.buyer!, seller: o.seller, admin,
      ...custody(o), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })).preInstructions([ensureAtaIx(admin, recipient, usdcMint)]);
  },
};
