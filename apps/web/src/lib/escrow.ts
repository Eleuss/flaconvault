import { AnchorProvider, BN, Program, type Idl } from "@anchor-lang/core";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import escrowIdl from "@flaconvault/proof/idl/escrow.json";

export const ESCROW_PROGRAM_ID = process.env.NEXT_PUBLIC_ESCROW_PROGRAM_ID ?? (escrowIdl as { address: string }).address;
const enc = (s: string) => new TextEncoder().encode(s);

/** Mirrors programs/escrow/src/constants.rs (ORDER_STATE_*). */
export const OrderState = { LISTED: 0, RESERVED: 1, PRESHIP_SCANNED: 2, SHIPPED: 3, RECEIPT_SCANNED: 4, RELEASED: 5, MISMATCH: 6, DISPUTE: 7, CANCELLED: 8 } as const;
export const orderStateLabel: Record<number, string> = {
  0: "Gelistet", 1: "Reserviert", 2: "Versand-Scan erfasst", 3: "Versendet", 4: "Empfangs-Scan erfasst",
  5: "Freigegeben", 6: "Abweichung", 7: "Dispute", 8: "Storniert",
};
export const orderStateTone = (s: number): "ok" | "warn" | "bad" | "none" =>
  s === OrderState.RELEASED ? "ok" : s === OrderState.MISMATCH || s === OrderState.DISPUTE ? "bad" : s === OrderState.CANCELLED ? "none" : "warn";
export const FILL_TOLERANCE = 5;

export const escrowProgramId = () => new PublicKey(ESCROW_PROGRAM_ID);
export const configPda = () => PublicKey.findProgramAddressSync([enc("config")], escrowProgramId())[0];
export const orderPda = (passport: PublicKey, seller: PublicKey) => PublicKey.findProgramAddressSync([enc("order"), passport.toBytes(), seller.toBytes()], escrowProgramId())[0];
export const vaultPda = (order: PublicKey) => PublicKey.findProgramAddressSync([enc("vault"), order.toBytes()], escrowProgramId())[0];
export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

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
  priceUsdc: number; state: number; listedAt: number; reservedAt: number; shippedAt: number;
  sellerScan: PublicKey | null; buyerScan: PublicKey | null; disputeAfterS: number; assetDeposited: boolean;
}
const nz = (k: PublicKey) => (k.equals(PublicKey.default) ? null : k);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (pubkey: PublicKey, a: any): OrderView => ({
  pubkey, passport: a.passport, seller: a.seller, buyer: nz(a.buyer), asset: a.asset,
  priceUsdc: Number(a.price.toString()) / 1e6, state: a.state, listedAt: Number(a.listedAt), reservedAt: Number(a.reservedAt),
  shippedAt: Number(a.shippedAt), sellerScan: nz(a.sellerScan), buyerScan: nz(a.buyerScan), disputeAfterS: Number(a.disputeAfterS), assetDeposited: !!a.assetDeposited,
});
export async function fetchConfig(program: Program): Promise<EscrowConfigView | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (program.account as any).escrowConfig.fetchNullable(configPda());
  return c ? { admin: c.admin.toBase58(), usdcMint: c.usdcMint, disputeAfterS: Number(c.disputeAfterS) } : null;
}
export async function fetchOrders(program: Program): Promise<OrderView[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: Array<{ publicKey: PublicKey; account: any }> = await (program.account as any).order.all();
  return all.map((o) => toView(o.publicKey, o.account)).sort((a, b) => b.listedAt - a.listedAt);
}

/** Optional accounts are passed as null; the untyped Program's accountsStrict typing does not know that. */
const acc = (o: Record<string, PublicKey | null>) => o as never;

/** Instruction builders — each returns the Anchor method builder (call .rpc() / .instruction()). */
export const escrowIx = {
  list: (p: Program, passport: PublicKey, seller: PublicKey, priceUsdc: number) =>
    p.methods.list(new BN(Math.round(priceUsdc * 1e6))).accountsStrict({ config: configPda(), passport, order: orderPda(passport, seller), seller, systemProgram: SystemProgram.programId }),
  cancel: (p: Program, o: OrderView) =>
    p.methods.cancel().accountsStrict(acc({ order: o.pubkey, seller: o.seller, asset: null, mplCoreProgram: null, systemProgram: SystemProgram.programId })),
  reserve: (p: Program, o: OrderView, buyer: PublicKey, usdcMint: PublicKey) =>
    p.methods.reserve().accountsStrict({ config: configPda(), order: o.pubkey, buyer, buyerToken: ata(buyer, usdcMint), usdcMint, vault: vaultPda(o.pubkey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }),
  preShip: (p: Program, o: OrderView, scanProof: PublicKey, seal: PublicKey) =>
    p.methods.recordPreShipScan().accountsStrict({ order: o.pubkey, seller: o.seller, scanProof, seal }),
  ship: (p: Program, o: OrderView) => p.methods.ship().accountsStrict({ order: o.pubkey, seller: o.seller }),
  receipt: (p: Program, o: OrderView, scanProof: PublicKey, seal: PublicKey) =>
    p.methods.recordReceiptScan().accountsStrict({ order: o.pubkey, buyer: o.buyer!, scanProof, seal, sellerScan: o.sellerScan! }),
  release: (p: Program, o: OrderView, caller: PublicKey, usdcMint: PublicKey) =>
    p.methods.release().accountsStrict(acc({ config: configPda(), order: o.pubkey, vault: vaultPda(o.pubkey), sellerToken: ata(o.seller, usdcMint), buyer: o.buyer!, caller, asset: null, mplCoreProgram: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })),
  dispute: (p: Program, o: OrderView, signer: PublicKey, usdcMint: PublicKey, seal: PublicKey | null) =>
    p.methods.dispute().accountsStrict(acc({ config: configPda(), order: o.pubkey, vault: vaultPda(o.pubkey), buyerToken: ata(o.buyer!, usdcMint), buyer: o.buyer!, seller: o.seller, signer, seal, asset: null, mplCoreProgram: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })),
};
