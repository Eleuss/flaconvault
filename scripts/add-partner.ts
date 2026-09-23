/** Add a wallet to the registry partner list (authority only). Usage: npx tsx scripts/add-partner.ts <pubkey> */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const ROOT = path.resolve(__dirname, "..");
async function main() {
  const target = new PublicKey(process.argv[2]);
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(keypair), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/proof/src/idl/flacon.json"), "utf8"));
  const program = new Program(idl, provider);
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], program.programId);
  const reg: any = await (program.account as any).registry.fetch(registry);
  if (reg.partners.some((p: PublicKey) => p.equals(target))) { console.log("already a partner"); return; }
  const sig = await program.methods.addPartner(target).accountsStrict({ registry, authority: keypair.publicKey }).rpc();
  console.log(`add_partner ${target.toBase58()} ${sig}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
