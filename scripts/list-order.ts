/** List a passport on the escrow market from the CLI wallet. Usage: npx tsx scripts/list-order.ts <serial> <priceUsdc> */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const ROOT = path.resolve(__dirname, "..");
async function main() {
  const [serial, price] = [process.argv[2], Number(process.argv[3] ?? "480")];
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(keypair), { commitment: "confirmed" });
  const escrowIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/proof/src/idl/escrow.json"), "utf8"));
  const flaconIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/proof/src/idl/flacon.json"), "utf8"));
  const escrow = new Program(escrowIdl, provider);
  const flaconId = new PublicKey(flaconIdl.address);
  const serialHash = createHash("sha256").update(serial).digest();
  const [passport] = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], flaconId);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], escrow.programId);
  const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), passport.toBuffer(), keypair.publicKey.toBuffer()], escrow.programId);
  const sig = await escrow.methods.list(new BN(Math.round(price * 1e6))).accountsStrict({ config, passport, order, seller: keypair.publicKey, systemProgram: SystemProgram.programId }).rpc();
  console.log(`list ${serial} ${price} USDC → order ${order.toBase58()} ${sig}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
