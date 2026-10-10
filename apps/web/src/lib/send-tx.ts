import { Connection, TransactionMessage, VersionedTransaction, type Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/**
 * Sends a legacy-built transaction as a v0 VersionedTransaction. The wallet only SIGNS; this page sends and confirms
 * through its own RPC — the same path umi takes for the Core mint, which is the one that worked with Solflare/Phantom
 * through the Mobile Wallet Adapter on Android. (MWA returned legacy transactions unsigned, and the wallet's own
 * "sign and send" reported "something went wrong" even when the transaction had landed.)
 */
export async function sendAsV0(wallet: WalletContextState, connection: Connection, tx: Transaction): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet nicht verbunden");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message();
  const vtx = new VersionedTransaction(message);
  let sig: string;
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(vtx);
    sig = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
  } else {
    sig = await wallet.sendTransaction(vtx, connection, { preflightCommitment: "confirmed" });
  }
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** Signature of the transaction that created an account (oldest signature touching it), or null. */
export async function creatingSignature(connection: Connection, account: import("@solana/web3.js").PublicKey): Promise<string | null> {
  const sigs = await connection.getSignaturesForAddress(account, { limit: 50 }, "confirmed");
  const ok = sigs.filter((s) => !s.err);
  return ok.length ? ok[ok.length - 1].signature : null;
}
