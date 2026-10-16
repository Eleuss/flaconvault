import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type SignatureStatus, type Transaction, type TransactionError, type VersionedTransactionResponse } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { PROGRAM_ID } from "./config";
import { TxFailedError } from "./errors";

/** The blockhash expired while the wallet app was open (mobile wallets can take longer than its ~60–90 s lifetime). */
const BLOCKHASH_GONE = /blockhash not found|BlockhashNotFound|block ?height exceeded|blockhash.{0,20}(expired|invalid)/i;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const errText = (e: unknown) => {
  const x = e as { message?: string; error?: { message?: string }; logs?: string[] } | null;
  return [x?.message, x?.error?.message, ...(x?.logs ?? [])].filter(Boolean).join(" ") || String(e);
};

/**
 * Sends a legacy-built transaction as a v0 VersionedTransaction. The wallet only SIGNS; this page sends and confirms
 * through its own RPC — the same path umi takes for the Core mint, which is the one that worked with Solflare/Phantom
 * through the Mobile Wallet Adapter on Android. (MWA returned legacy transactions unsigned, and the wallet's own
 * "sign and send" reported "something went wrong" even when the transaction had landed.)
 *
 * Throws `TxFailedError` when the transaction landed but failed. If confirmation itself throws or times out, the
 * signature status is looked up and the signature is returned when it landed without error. An expired blockhash at
 * send time gets one retry with a fresh blockhash (the wallet is asked to sign once more).
 */
export async function sendAsV0(wallet: WalletContextState, connection: Connection, tx: Transaction): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const payer = wallet.publicKey;
  const signAndSend = async () => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message();
    const vtx = new VersionedTransaction(message);
    let signature: string;
    if (wallet.signTransaction) {
      const signed = await wallet.signTransaction(vtx);
      signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
    } else {
      signature = await wallet.sendTransaction(vtx, connection, { preflightCommitment: "confirmed" });
    }
    return { signature, blockhash, lastValidBlockHeight };
  };
  let sent: Awaited<ReturnType<typeof signAndSend>>;
  try {
    sent = await signAndSend();
  } catch (e) {
    if (!BLOCKHASH_GONE.test(errText(e))) throw e;
    sent = await signAndSend(); // one retry: fresh blockhash, the wallet signs once more
  }
  return confirmLanded(connection, sent.signature, sent.blockhash, sent.lastValidBlockHeight);
}

async function confirmLanded(connection: Connection, signature: string, blockhash: string, lastValidBlockHeight: number): Promise<string> {
  let confirmError: unknown;
  try {
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (!res.value.err) return signature;
    throw new TxFailedError(signature, await failureReason(connection, signature, res.value.err));
  } catch (e) {
    if (e instanceof TxFailedError) throw e;
    confirmError = e;
  }
  // Confirmation threw or timed out (block height exceeded, websocket dropped …): ask for the signature's status directly.
  const st = await lookupStatus(connection, signature);
  if (st?.err) throw new TxFailedError(signature, await failureReason(connection, signature, st.err));
  if (st) return signature;
  throw new Error(`Transaction ${signature.slice(0, 12)}… was not confirmed: ${errText(confirmError)}`);
}

/** Status of a signature, polled briefly; resolves on confirmed/finalized or error, else the last status seen (or null). */
async function lookupStatus(connection: Connection, signature: string): Promise<SignatureStatus | null> {
  let last: SignatureStatus | null = null;
  for (let i = 0; i < 5; i++) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = value[0];
      if (st) {
        last = st;
        if (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return st;
      }
    } catch { /* RPC hiccup: ask again */ }
    if (i < 4) await sleep(2000);
  }
  return last;
}

/** Short text for a TransactionError: "instruction 2 returned error 6003 (0x1773)". */
export function describeTxError(err: TransactionError | object | string): string {
  const ie = typeof err === "object" && err ? (err as { InstructionError?: [number, unknown] }).InstructionError : undefined;
  if (!ie) return typeof err === "string" ? err : JSON.stringify(err);
  const [idx, inner] = ie;
  const custom = inner && typeof inner === "object" && "Custom" in inner ? Number((inner as { Custom: number }).Custom) : null;
  return custom != null ? `instruction ${idx + 1} returned error ${custom} (0x${custom.toString(16)})` : `instruction ${idx + 1} failed (${typeof inner === "string" ? inner : JSON.stringify(inner)})`;
}

/** describeTxError, prefixed with the program's own message from the logs when there is one. */
async function failureReason(connection: Connection, signature: string, err: TransactionError): Promise<string> {
  let reason = describeTxError(err);
  try {
    const t = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = t?.meta?.logMessages ?? [];
    const msg = logs.map((l) => /Error Message: (.+?)\.?$/.exec(l)?.[1] ?? (/insufficient lamports/i.test(l) ? "insufficient SOL" : undefined)).find(Boolean);
    if (msg) reason = `${msg} — ${reason}`;
  } catch { /* logs are optional */ }
  return reason;
}

// ---- recovery: the transaction landed but its answer never reached this page ----------------------------------

/** What the transaction that created an account must look like. */
export interface CreatingTxExpectation {
  /** program whose instruction must reference the account (default: the flacon program, NEXT_PUBLIC_PROGRAM_ID) */
  programId?: PublicKey;
  /** Anchor instruction name(s) as in the IDL (snake_case, e.g. "record_scan"); any instruction of the program when omitted */
  instruction?: string | string[];
  /** the transaction must carry this key's signature (e.g. the connected wallet) */
  signer?: PublicKey;
}

/** Anchor's instruction discriminator: sha256("global:<name>")[0..8]. */
export async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(d).slice(0, 8);
}
const startsWith = (data: Uint8Array, prefix: Uint8Array) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

/** true when `tx` carries an instruction of `programId` (with one of `discriminators`, if any) that references `account`. */
export function txCreates(tx: VersionedTransactionResponse, account: PublicKey, programId: PublicKey, discriminators: Uint8Array[], signer?: PublicKey): boolean {
  if (tx.meta?.err) return false;
  const msg = tx.transaction.message;
  const keys = msg.version === 0 ? msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }) : msg.getAccountKeys();
  if (signer) {
    let signed = false;
    for (let i = 0; i < msg.header.numRequiredSignatures; i++) if (keys.get(i)?.equals(signer)) signed = true;
    if (!signed) return false;
  }
  return msg.compiledInstructions.some((ix) =>
    !!keys.get(ix.programIdIndex)?.equals(programId)
    && (discriminators.length === 0 || discriminators.some((d) => startsWith(ix.data, d)))
    && ix.accountKeyIndexes.some((i) => !!keys.get(i)?.equals(account)));
}

const SIG_PAGE = 250, SIG_WINDOW = 1000, TX_BATCH = 10;
const TX_OPTS = { commitment: "confirmed", maxSupportedTransactionVersion: 0 } as const;

/** getTransaction for several signatures: one JSON-RPC batch, or one call each when the RPC refuses batches. */
async function fetchTransactions(connection: Connection, sigs: string[]): Promise<Array<VersionedTransactionResponse | null>> {
  if (sigs.length > 1 && typeof connection.getTransactions === "function") {
    try { return await connection.getTransactions(sigs, TX_OPTS); } catch { /* batch refused or one entry failed: one by one */ }
  }
  const out: Array<VersionedTransactionResponse | null> = [];
  for (const sig of sigs) out.push(await connection.getTransaction(sig, TX_OPTS));
  return out;
}

/**
 * Signature of the transaction that created `account`: the oldest successful transaction that carries the expected
 * instruction on that account (and the expected signer's signature). Anything else that touched the address is
 * skipped — a SOL transfer that pre-funded it, a memo or dust sent before or after. Every successful signature in the
 * window is a candidate, checked oldest first in batches: the PDAs are predictable from public data, so a fixed
 * number of candidates would let anyone hide the creating transaction behind that many cheap transactions sent first.
 * Returns null when the account has more than 1000 signatures (the creating one is out of reach) or none matches.
 */
export async function creatingSignature(connection: Connection, account: PublicKey, expect: CreatingTxExpectation = {}): Promise<string | null> {
  const programId = expect.programId ?? (PROGRAM_ID ? new PublicKey(PROGRAM_ID) : null);
  if (!programId) return null;
  const names = expect.instruction == null ? [] : Array.isArray(expect.instruction) ? expect.instruction : [expect.instruction];
  const discriminators = await Promise.all(names.map(anchorDiscriminator));
  let before: string | undefined, seen = 0, complete = false;
  const ok: string[] = []; // newest first
  while (seen < SIG_WINDOW) {
    const limit = Math.min(SIG_PAGE, SIG_WINDOW - seen);
    const sigs = await connection.getSignaturesForAddress(account, { limit, before }, "confirmed");
    for (const s of sigs) if (!s.err) ok.push(s.signature);
    seen += sigs.length;
    if (sigs.length < limit) { complete = true; break; }
    before = sigs[sigs.length - 1].signature;
  }
  if (!complete) return null; // the window ended before the account's first transaction
  const oldestFirst = ok.reverse();
  for (let i = 0; i < oldestFirst.length; i += TX_BATCH) {
    const chunk = oldestFirst.slice(i, i + TX_BATCH);
    const txs = await fetchTransactions(connection, chunk);
    const hit = chunk.findIndex((_, j) => { const tx = txs[j]; return !!tx && txCreates(tx, account, programId, discriminators, expect.signer); });
    if (hit >= 0) return chunk[hit];
  }
  return null;
}

/** Anchor account discriminator of flacon's ScanProof (sha256("account:ScanProof")[0..8], as in the IDL). */
export const SCAN_PROOF_DISCRIMINATOR = Uint8Array.from([208, 136, 45, 119, 131, 191, 85, 170]);
/** ScanProof layout: disc 8 · seal 32 · counter 4 · tier…fill 8 · site_id 2 · media_hash 32 · bundle_hash 32 · attester 32 … */
const SCAN_PROOF_ATTESTER_OFFSET = 8 + 32 + 4 + 8 + 2 + 32 + 32;

/**
 * Attester of an existing ScanProof account, or null when the address holds no real ScanProof: no account, an
 * account the flacon program does not own (e.g. someone pre-funded the address with a SOL transfer), or data
 * without the ScanProof discriminator.
 */
export function scanProofAttester(info: { owner: PublicKey; data: Uint8Array } | null, programId: PublicKey): PublicKey | null {
  if (!info || !info.owner.equals(programId)) return null;
  if (info.data.length < SCAN_PROOF_ATTESTER_OFFSET + 32 || !startsWith(info.data, SCAN_PROOF_DISCRIMINATOR)) return null;
  return new PublicKey(info.data.subarray(SCAN_PROOF_ATTESTER_OFFSET, SCAN_PROOF_ATTESTER_OFFSET + 32));
}
