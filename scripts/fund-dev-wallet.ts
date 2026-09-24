/**
 * Fund a dev wallet for demos: SOL from the CLI wallet + test USDC from the mint the CLI wallet controls.
 * Usage: npx tsx scripts/fund-dev-wallet.ts <pubkey> [solAmount=0.05] [usdcAmount=500]
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET, FV_USDC_MINT (default: read from the escrow config on chain)
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureAta, mintTo, tokenBalance } from "./lib/spl";

const ROOT = path.resolve(__dirname, "..");
async function main() {
  const target = new PublicKey(process.argv[2]);
  const sol = Number(process.argv[3] ?? "0.05"), usdc = Number(process.argv[4] ?? "500");
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, "confirmed");
  let mint: PublicKey;
  if (process.env.FV_USDC_MINT) mint = new PublicKey(process.env.FV_USDC_MINT);
  else {
    const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/proof/src/idl/escrow.json"), "utf8"));
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(idl.address));
    const info = await connection.getAccountInfo(config);
    if (!info) throw new Error("escrow config not found — run scripts/seed-escrow.ts");
    mint = new PublicKey(info.data.subarray(40, 72));
  }
  if (sol > 0) {
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: target, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [payer]);
    console.log(`SOL  ${sol} → ${target.toBase58()}  ${sig}`);
  }
  if (usdc > 0) {
    const ata = await ensureAta(connection, payer, target, mint);
    await mintTo(connection, payer, mint, ata, payer, BigInt(Math.round(usdc * 1e6)));
    console.log(`USDC ${usdc} → ${ata.toBase58()}  (balance ${await tokenBalance(connection, ata)})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
