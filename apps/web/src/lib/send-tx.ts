import { Connection, TransactionMessage, VersionedTransaction, type Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/**
 * Sends a legacy-built transaction as a v0 VersionedTransaction via the wallet's own sendTransaction
 * (sign and send in one step). Mobile wallets through the Mobile Wallet Adapter (Solflare/Phantom on Android)
 * returned legacy transactions unsigned ("Missing signature for public key …") while v0 transactions, as umi
 * sends them for the Core mint, were signed fine. Desktop extensions and the dev wallets accept both.
 */
export async function sendAsV0(wallet: WalletContextState, connection: Connection, tx: Transaction): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet nicht verbunden");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message();
  const vtx = new VersionedTransaction(message);
  const sig = await wallet.sendTransaction(vtx, connection, { preflightCommitment: "confirmed" });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
