import { AnchorProvider, Program, type Idl } from "@anchor-lang/core";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import escrowIdl from "@flaconvault/proof/idl/escrow.json";
import { registryPda } from "./flacon";
import { OrderState, formatUsdc } from "./escrow-rules";
import { configPdaOf, escrowIx as ix, orderPdaOf, vaultPdaOf, type IxOrder } from "./escrow-ix";

export { OrderState } from "./escrow-rules";
export { ata, ensureAtaIx, payoutRecipient } from "./escrow-ix";
export const ESCROW_PROGRAM_ID = process.env.NEXT_PUBLIC_ESCROW_PROGRAM_ID ?? (escrowIdl as { address: string }).address;

export const orderStateLabel: Record<number, string> = {
  0: "Listed", 1: "Reserved", 2: "Shipping scan recorded", 3: "Shipped", 4: "Receipt scan recorded",
  5: "Released", 6: "Mismatch", 7: "Dispute", 8: "Cancelled",
};
export const orderStateTone = (s: number): "ok" | "warn" | "bad" | "none" =>
  s === OrderState.RELEASED ? "ok" : s === OrderState.MISMATCH || s === OrderState.DISPUTE ? "bad" : s === OrderState.CANCELLED ? "none" : "warn";
export const FILL_TOLERANCE = 5;

export const escrowProgramId = () => new PublicKey(ESCROW_PROGRAM_ID);
export const configPda = () => configPdaOf(escrowProgramId());
export const orderPda = (passport: PublicKey, seller: PublicKey) => orderPdaOf(escrowProgramId(), passport, seller);
export const vaultPda = (order: PublicKey) => vaultPdaOf(escrowProgramId(), order);

/** Read-only wallet for public listings and the Blink endpoint. */
const readOnlyWallet = (): AnchorWallet => {
  const pk = Keypair.generate().publicKey;
  return { publicKey: pk, signTransaction: async <T extends Transaction | VersionedTransaction>(t: T) => t, signAllTransactions: async <T extends Transaction | VersionedTransaction>(t: T[]) => t };
};
export function escrowProgram(connection: Connection, wallet?: AnchorWallet): Program {
  const provider = new AnchorProvider(connection, wallet ?? readOnlyWallet(), { commitment: "confirmed" });
  // the program id the PDAs above use (NEXT_PUBLIC_ESCROW_PROGRAM_ID may point at another deployment than the IDL)
  return new Program({ ...(escrowIdl as Idl), address: ESCROW_PROGRAM_ID }, provider);
}

export interface EscrowConfigView { admin: string; usdcMint: PublicKey; disputeAfterS: number }
export interface OrderView extends IxOrder {
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

/**
 * Instruction builders (lib/escrow-ix.ts) with this app's flacon registry filled in for `list` and `reserve`, which
 * check the seller's right to sell.
 */
export const escrowIx = {
  ...ix,
  list: (p: Program, passport: PublicKey, seller: PublicKey, priceBase: bigint, asset: PublicKey) => ix.list(p, passport, seller, priceBase, asset, registryPda()),
  reserve: (p: Program, o: OrderView, buyer: PublicKey, usdcMint: PublicKey, expectedPrice: bigint = o.priceBase) => ix.reserve(p, o, buyer, usdcMint, registryPda(), expectedPrice),
};
