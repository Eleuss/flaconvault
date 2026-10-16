/**
 * Minimal Metaplex Core helpers without the umi stack: hand-built `CreateV1`, `TransferV1` and `BurnV1`
 * instructions and an `AssetV1` reader. Used by the ops scripts and by tests/ (mint_passport only accepts a
 * Core asset owned by the issuer).
 *
 * CreateV1 layout (mpl-core 0.12 IDL):
 *   data:     [0 (CreateV1), 0 (DataState::AccountState), name (u32 len + utf8), uri (u32 len + utf8), 0 (plugins: None)]
 *   accounts: asset (signer, writable) · collection? · authority? (signer) · payer (signer, writable)
 *             · owner? · update_authority? · system_program · log_wrapper?
 * Absent optional accounts are passed as the Core program id (Metaplex convention); authority, owner and
 * update authority then default to the payer.
 *
 * TransferV1 (14) / BurnV1 (12) layout (as in programs/escrow/src/mpl_core.rs):
 *   data:     [discriminator, 0 (compression_proof: None)]
 *   TransferV1 accounts: asset (w) · collection? · payer (s, w) · authority? (s) · new_owner · system_program? · log_wrapper?
 *   BurnV1 accounts:     asset (w) · collection? · payer (s, w) · authority? (s) · system_program? · log_wrapper?
 *
 * AssetV1 account: key u8 (1) · owner (32) · update_authority (enum u8 + 32 for Address/Collection) · …
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const KEY_ASSET_V1 = 1;
const UPDATE_AUTHORITY_COLLECTION = 2;

const borshString = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

export function createCoreAssetIx(o: { asset: PublicKey; payer: PublicKey; owner?: PublicKey; name: string; uri: string }): TransactionInstruction {
  const C = MPL_CORE_PROGRAM_ID;
  const none = { pubkey: C, isSigner: false, isWritable: false };
  return new TransactionInstruction({
    programId: C,
    keys: [
      { pubkey: o.asset, isSigner: true, isWritable: true },
      none, // collection
      none, // authority (= payer)
      { pubkey: o.payer, isSigner: true, isWritable: true },
      o.owner ? { pubkey: o.owner, isSigner: false, isWritable: false } : none,
      none, // update authority (= authority)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      none, // log wrapper
    ],
    data: Buffer.concat([Buffer.from([0, 0]), borshString(o.name), borshString(o.uri), Buffer.from([0])]),
  });
}

/** Moves an asset (no collection) from `owner` (signer) to `newOwner`; `payer` pays the fee. */
export function transferCoreAssetIx(o: { asset: PublicKey; payer: PublicKey; owner: PublicKey; newOwner: PublicKey }): TransactionInstruction {
  const C = MPL_CORE_PROGRAM_ID;
  const none = { pubkey: C, isSigner: false, isWritable: false };
  return new TransactionInstruction({
    programId: C,
    keys: [
      { pubkey: o.asset, isSigner: false, isWritable: true },
      none, // collection
      { pubkey: o.payer, isSigner: true, isWritable: true },
      { pubkey: o.owner, isSigner: true, isWritable: false },
      { pubkey: o.newOwner, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      none, // log wrapper
    ],
    data: Buffer.from([14, 0]),
  });
}

/** Burns an asset (no collection) owned by `owner` (signer); the account stays, but is no longer an AssetV1. */
export function burnCoreAssetIx(o: { asset: PublicKey; payer: PublicKey; owner: PublicKey }): TransactionInstruction {
  const C = MPL_CORE_PROGRAM_ID;
  const none = { pubkey: C, isSigner: false, isWritable: false };
  return new TransactionInstruction({
    programId: C,
    keys: [
      { pubkey: o.asset, isSigner: false, isWritable: true },
      none, // collection
      { pubkey: o.payer, isSigner: true, isWritable: true },
      { pubkey: o.owner, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      none, // log wrapper
    ],
    data: Buffer.from([12, 0]),
  });
}

export interface CoreAssetInfo {
  owner: PublicKey;
  /** true when the asset belongs to a collection (the escrow custody CPI does not pass a collection) */
  inCollection: boolean;
}

/** Parses an account as a Core `AssetV1`; null when it is none (missing, placeholder, collection, other program). */
export function parseCoreAsset(info: { owner: PublicKey; data: Buffer | Uint8Array } | null): CoreAssetInfo | null {
  if (!info || !info.owner.equals(MPL_CORE_PROGRAM_ID) || info.data.length < 34 || info.data[0] !== KEY_ASSET_V1) return null;
  return { owner: new PublicKey(info.data.subarray(1, 33)), inCollection: info.data[33] === UPDATE_AUTHORITY_COLLECTION };
}

export async function fetchCoreAsset(connection: Connection, asset: PublicKey): Promise<CoreAssetInfo | null> {
  return parseCoreAsset(await connection.getAccountInfo(asset));
}
