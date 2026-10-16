/**
 * Escrow instruction builders (programs/escrow). No app imports (config, @flaconvault/proof), so the Anchor tests in
 * tests/escrow.ts can send exactly what the web app sends; lib/escrow.ts wraps them with the app's flacon registry.
 * PDAs are derived from the passed program's id.
 *
 * Every builder returns the Anchor method builder. In the browser: `.transaction()` → `sendAsV0` (v0; legacy `.rpc()`
 * fails with mobile wallets). Payout paths prepend createAssociatedTokenAccountIdempotent for the recipient, so a seller
 * (or buyer) who never held the USDC mint does not leave the funds stuck.
 */
import { BN, type Program } from "@anchor-lang/core";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** Metaplex Core (asset custody CPI). */
export const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const enc = (s: string) => new TextEncoder().encode(s);

export const configPdaOf = (programId: PublicKey) => PublicKey.findProgramAddressSync([enc("config")], programId)[0];
export const orderPdaOf = (programId: PublicKey, passport: PublicKey, seller: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("order"), passport.toBytes(), seller.toBytes()], programId)[0];
export const vaultPdaOf = (programId: PublicKey, order: PublicKey) => PublicKey.findProgramAddressSync([enc("vault"), order.toBytes()], programId)[0];
/** The flacon registry (seeds `["registry"]` under the flacon program). */
export const registryPdaOf = (flaconProgramId: PublicKey) => PublicKey.findProgramAddressSync([enc("registry")], flaconProgramId)[0];
export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
/** Creates `owner`'s USDC account if it is missing (no-op otherwise); `payer` pays the rent. */
export const ensureAtaIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);

/** The order fields the builders need (lib/escrow.ts OrderView has them all). */
export interface IxOrder {
  pubkey: PublicKey; passport: PublicKey; seller: PublicKey; buyer: PublicKey | null; asset: PublicKey;
  priceBase: bigint; sellerScan: PublicKey | null; assetDeposited: boolean;
}

/** Optional accounts are passed as null; the untyped Program's accountsStrict typing does not know that. */
const acc = (o: Record<string, PublicKey | null>) => o as never;
/** The Core asset accounts when the asset sits in the order's custody (else null: the program skips the transfer). */
const custody = (o: IxOrder) => (o.assetDeposited ? { asset: o.asset, mplCoreProgram: MPL_CORE_PROGRAM_ID } : { asset: null, mplCoreProgram: null });
const releaseAccounts = (p: Program, o: IxOrder, caller: PublicKey, usdcMint: PublicKey) => acc({
  config: configPdaOf(p.programId), order: o.pubkey, vault: vaultPdaOf(p.programId, o.pubkey), sellerToken: ata(o.seller, usdcMint), buyer: o.buyer!, caller,
  ...custody(o), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
});

/** Who receives the USDC of a payout path (its token account is created first). */
export function payoutRecipient(o: IxOrder, path: "release" | "releaseAfterTimeout" | "dispute" | "resolve", toSeller = false): PublicKey {
  if (path === "release" || path === "releaseAfterTimeout") return o.seller;
  if (path === "resolve" && toSeller) return o.seller;
  return o.buyer!;
}

export const escrowIx = {
  /**
   * `asset` = passport.asset: the program checks that the seller owns it (or, without a Core asset, is the issuer while
   * still a partner — hence the flacon `registry`).
   */
  list: (p: Program, passport: PublicKey, seller: PublicKey, priceBase: bigint, asset: PublicKey, registry: PublicKey) =>
    p.methods.list(new BN(priceBase.toString())).accountsStrict({
      config: configPdaOf(p.programId), passport, order: orderPdaOf(p.programId, passport, seller), seller, systemProgram: SystemProgram.programId, asset, registry,
    }),
  /** Moves the seller's Core asset into the order's custody (it goes to the buyer on release). */
  depositAsset: (p: Program, order: PublicKey, seller: PublicKey, asset: PublicKey) =>
    p.methods.depositAsset().accountsStrict({ order, seller, asset, mplCoreProgram: MPL_CORE_PROGRAM_ID, systemProgram: SystemProgram.programId }),
  cancel: (p: Program, o: IxOrder) =>
    p.methods.cancel().accountsStrict(acc({ order: o.pubkey, seller: o.seller, ...custody(o), systemProgram: SystemProgram.programId })),
  /** Seller reclaims a terminal order account (needed before the same seller can list the passport again). */
  closeOrder: (p: Program, o: IxOrder) => p.methods.closeOrder().accountsStrict({ order: o.pubkey, seller: o.seller }),
  /**
   * `expectedPrice` defaults to the price the page shows: a re-listing at another price makes the reservation fail.
   * The program checks again that the seller may still sell (asset owner, or active issuer), hence `asset` + `registry`.
   */
  reserve: (p: Program, o: IxOrder, buyer: PublicKey, usdcMint: PublicKey, registry: PublicKey, expectedPrice: bigint = o.priceBase) =>
    p.methods.reserve(new BN(expectedPrice.toString())).accountsStrict({
      config: configPdaOf(p.programId), order: o.pubkey, buyer, buyerToken: ata(buyer, usdcMint), usdcMint, vault: vaultPdaOf(p.programId, o.pubkey),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, passport: o.passport, asset: o.asset, registry,
    }),
  preShip: (p: Program, o: IxOrder, scanProof: PublicKey, seal: PublicKey) =>
    p.methods.recordPreShipScan().accountsStrict({ order: o.pubkey, seller: o.seller, scanProof, seal }),
  ship: (p: Program, o: IxOrder) => p.methods.ship().accountsStrict({ order: o.pubkey, seller: o.seller }),
  receipt: (p: Program, o: IxOrder, scanProof: PublicKey, seal: PublicKey) =>
    p.methods.recordReceiptScan().accountsStrict({ order: o.pubkey, buyer: o.buyer!, scanProof, seal, sellerScan: o.sellerScan! }),
  release: (p: Program, o: IxOrder, caller: PublicKey, usdcMint: PublicKey) =>
    p.methods.release().accountsStrict(releaseAccounts(p, o, caller, usdcMint)).preInstructions([ensureAtaIx(caller, payoutRecipient(o, "release"), usdcMint)]),
  /** SHIPPED and no receipt scan within the window: anyone pays the seller. */
  releaseAfterTimeout: (p: Program, o: IxOrder, caller: PublicKey, usdcMint: PublicKey) =>
    p.methods.releaseAfterTimeout().accountsStrict(releaseAccounts(p, o, caller, usdcMint)).preInstructions([ensureAtaIx(caller, payoutRecipient(o, "releaseAfterTimeout"), usdcMint)]),
  /** Refund to the buyer: admin, seller did not ship in time, or a dead `seal` of the passport before shipping. */
  dispute: (p: Program, o: IxOrder, signer: PublicKey, usdcMint: PublicKey, seal: PublicKey | null) =>
    p.methods.dispute().accountsStrict(acc({
      config: configPdaOf(p.programId), order: o.pubkey, vault: vaultPdaOf(p.programId, o.pubkey), buyerToken: ata(o.buyer!, usdcMint), buyer: o.buyer!, seller: o.seller, signer, seal,
      ...custody(o), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })).preInstructions([ensureAtaIx(signer, payoutRecipient(o, "dispute"), usdcMint)]),
  /** Escrow admin settles a MISMATCH: `toSeller` pays the seller, otherwise the buyer is refunded. */
  resolve: (p: Program, o: IxOrder, admin: PublicKey, usdcMint: PublicKey, toSeller: boolean) => {
    const recipient = payoutRecipient(o, "resolve", toSeller);
    return p.methods.resolve(toSeller).accountsStrict(acc({
      config: configPdaOf(p.programId), order: o.pubkey, vault: vaultPdaOf(p.programId, o.pubkey), recipientToken: ata(recipient, usdcMint), buyer: o.buyer!, seller: o.seller, admin,
      ...custody(o), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })).preInstructions([ensureAtaIx(admin, recipient, usdcMint)]);
  },
};
