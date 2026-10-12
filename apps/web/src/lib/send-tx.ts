import { Connection, TransactionMessage, VersionedTransaction, type PublicKey, type SignatureStatus, type Transaction, type TransactionError } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
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

/** Signature of the transaction that created an account (oldest successful signature touching it, up to 1000 back), or null. */
export async function creatingSignature(connection: Connection, account: PublicKey): Promise<string | null> {
  const PAGE = 250, MAX = 1000;
  let before: string | undefined, oldest: string | null = null, seen = 0;
  while (seen < MAX) {
    const limit = Math.min(PAGE, MAX - seen);
    const sigs = await connection.getSignaturesForAddress(account, { limit, before }, "confirmed");
    for (const s of sigs) if (!s.err) oldest = s.signature;
    seen += sigs.length;
    if (sigs.length < limit) break;
    before = sigs[sigs.length - 1].signature;
  }
  return oldest;
}
