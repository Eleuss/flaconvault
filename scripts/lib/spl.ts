/**
 * Minimal SPL Token helpers (no @solana/spl-token dependency): create mint, ATA, mint_to,
 * transfer, balance. Used by scripts/seed-escrow.ts and tests/escrow.ts.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MINT_SIZE = 82;
export const USDC_DECIMALS = 6;

const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

export function ataAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

/** Creates a new mint with `mintAuthority` (no freeze authority). */
export async function createMint(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  decimals = USDC_DECIMALS
): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  // InitializeMint2: [20, decimals, mint_authority(32), freeze_authority COption (0 = none)]
  const data = Buffer.alloc(1 + 1 + 32 + 1);
  data[0] = 20;
  data[1] = decimals;
  mintAuthority.toBuffer().copy(data, 2);
  data[34] = 0;
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
      data,
    })
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mint], { commitment: "confirmed" });
  return mint.publicKey;
}

/** Associated token account `CreateIdempotent` instruction. */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export async function ensureAta(connection: Connection, payer: Keypair, owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const ata = ataAddress(owner, mint);
  if (!(await connection.getAccountInfo(ata))) {
    const tx = new Transaction().add(createAtaIdempotentIx(payer.publicKey, owner, mint));
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  }
  return ata;
}

export function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  });
}

export async function mintTo(connection: Connection, payer: Keypair, mint: PublicKey, dest: PublicKey, authority: Keypair, amount: bigint) {
  const tx = new Transaction().add(mintToIx(mint, dest, authority.publicKey, amount));
  const signers = authority.publicKey.equals(payer.publicKey) ? [payer] : [payer, authority];
  await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

export function transferIx(source: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), u64le(amount)]),
  });
}

/** Token balance in base units (at the connection's commitment); 0n when the account does not exist. */
export async function tokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  try {
    const r = await connection.getTokenAccountBalance(account, connection.commitment ?? "confirmed");
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/** Mint authority of an SPL mint (null if none / account missing). */
export async function mintAuthority(connection: Connection, mint: PublicKey): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(mint);
  if (!info || info.data.length < 36) return null;
  const tag = info.data.readUInt32LE(0);
  return tag === 1 ? new PublicKey(info.data.subarray(4, 36)) : null;
}
