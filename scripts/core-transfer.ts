/**
 * Move a Metaplex Core asset (no collection) from the CLI wallet to another owner. The escrow lets the owner of a
 * passport's Core asset sell the bottle, so an asset held by a key that is not private any more (the browser demo
 * Dev wallet A) must be moved to a wallet the operator controls.
 *
 * Usage: ANCHOR_WALLET=<keypair of the current owner> npx tsx scripts/core-transfer.ts <asset> <newOwner>
 * Env: ANCHOR_PROVIDER_URL (default devnet). The current owner signs and pays the fee.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { fetchCoreAsset, transferCoreAssetIx } from "./lib/core";
import { loadWallet, providerFor } from "./lib/cli";

async function main() {
  const [assetArg, ownerArg] = process.argv.slice(2);
  const usage = "usage: core-transfer <assetPubkey> <newOwnerPubkey>";
  let asset: PublicKey, newOwner: PublicKey;
  try { asset = new PublicKey(assetArg ?? ""); newOwner = new PublicKey(ownerArg ?? ""); } catch { throw new Error(usage); }
  const kp = loadWallet();
  const connection = providerFor(kp).connection;
  const core = await fetchCoreAsset(connection, asset);
  if (!core) throw new Error(`${asset.toBase58()} is not a Metaplex Core asset`);
  if (core.inCollection) throw new Error(`${asset.toBase58()} belongs to a collection; this script only moves assets without one`);
  if (!core.owner.equals(kp.publicKey)) throw new Error(`the asset belongs to ${core.owner.toBase58()}, not to this wallet (${kp.publicKey.toBase58()})`);
  if (core.owner.equals(newOwner)) { console.log("already owned by the new owner"); return; }
  const ix = transferCoreAssetIx({ asset, payer: kp.publicKey, owner: kp.publicKey, newOwner });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [kp], { commitment: "confirmed" });
  console.log(`core asset ${asset.toBase58()} → ${newOwner.toBase58()} ${sig}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
