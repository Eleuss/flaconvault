/**
 * Bind a real chip to a new passport from the CLI partner wallet (no phone needed):
 * mint_passport + attach_seal on chain, then MINT/SEAL_ATTACH events on the verifier.
 * Usage: npx tsx scripts/bind-chip.ts <serial> <uid14hex> "<brand>" "<name>" "<batch>" [kind=1] [verifyUrl]
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const ROOT = path.resolve(__dirname, "..");
const sha = (b: Buffer) => createHash("sha256").update(b).digest();
async function main() {
  const [serial, uid, brand, name, batch, kindArg, verifyArg] = process.argv.slice(2);
  if (!serial || !/^[0-9A-Fa-f]{14}$/.test(uid ?? "")) throw new Error("usage: bind-chip <serial> <uid 14 hex> <brand> <name> <batch> [kind] [verifyUrl]");
  const kind = Number(kindArg ?? "1"); const verify = (verifyArg ?? process.env.FV_VERIFY_URL ?? "https://verify-production-00e9.up.railway.app").replace(/\/$/, "");
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(kp), { commitment: "confirmed" });
  const program = new Program(JSON.parse(fs.readFileSync(path.join(ROOT, "packages/proof/src/idl/flacon.json"), "utf8")), provider);
  const pid = program.programId, wallet = kp.publicKey;
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], pid);
  const serialHash = sha(Buffer.from(serial, "utf8")), uidHash = sha(Buffer.from(uid, "hex"));
  const [passport] = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], pid);
  const [seal] = PublicKey.findProgramAddressSync([Buffer.from("seal"), uidHash], pid);
  const bindingHash = sha(Buffer.concat([Buffer.from(serial, "utf8"), Buffer.from(batch ?? "", "utf8"), uidHash]));
  const asset = Keypair.generate().publicKey; // placeholder asset; a Core asset can be minted from /certify later
  const post = async (body: unknown) => { const r = await fetch(`${verify}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`events ${r.status} ${await r.text()}`); return r.json(); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct: any = program.account;
  if (!(await acct.passport.fetchNullable(passport))) {
    const sig = await program.methods.mintPassport(Array.from(serialHash), Array.from(bindingHash), asset).accountsStrict({ registry, passport, issuer: wallet, systemProgram: SystemProgram.programId }).rpc();
    console.log(`mint_passport ${serial} ${sig}`);
    await post({ serial, type: 0, txSig: sig, actor: wallet.toBase58(), payload: { brand, name, batch, asset: asset.toBase58(), issuerLabel: "Parfümerie X, Düsseldorf", siteId: 1, bindingHash: "0x" + bindingHash.toString("hex") } });
  } else console.log(`passport ${serial} exists`);
  if (!(await acct.seal.fetchNullable(seal))) {
    const sig = await program.methods.attachSeal(Array.from(uidHash), kind).accountsStrict({ registry, passport, seal, signer: wallet, systemProgram: SystemProgram.programId }).rpc();
    console.log(`attach_seal ${uid} kind ${kind} ${sig}`);
    await post({ serial, type: 1, txSig: sig, actor: wallet.toBase58(), payload: { uid: uid.toUpperCase(), kind, siteId: 1 } });
  } else console.log(`seal ${uid} exists`);
  console.log(`pass: https://flaconvault.vercel.app/p/${serial}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
