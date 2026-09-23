/**
 * Idempotent devnet seed for programs/flacon (briefing §6 DoD):
 *   init_registry (skip if exists) · add_server_key(key_id 1, open-ended)
 *   · add_partner(wallet) · add_site(1, "Parfümerie X, Düsseldorf") · add_site(2, "FlaconVault Vault, Wickede")
 *
 * Usage:
 *   npx tsx scripts/seed-devnet.ts [--server-pubkey <hex32>] [--server-pubkey-from-env]
 *
 * Env: ANCHOR_PROVIDER_URL (default https://api.devnet.solana.com)
 *      ANCHOR_WALLET       (default ~/.config/solana/id.json)
 *
 * --server-pubkey <hex>        ed25519 public key of the verifier (32 bytes hex).
 *                              Default: docs/vectors.json serverTestKey.pubkeyHex (TEST ONLY).
 * --server-pubkey-from-env     read FV_SERVER_ED25519_SEED from apps/verify/.env and derive the pubkey.
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import nacl from "tweetnacl";

const ROOT = path.resolve(__dirname, "..");
const DEVNET = "https://api.devnet.solana.com";

const SERVER_KEY_ID = 1;
const PARTNER_SITES: { siteId: number; label: string }[] = [
  { siteId: 1, label: "Parfümerie X, Düsseldorf" },
  { siteId: 2, label: "FlaconVault Vault, Wickede" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

function expandHome(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadIdl(): any {
  for (const rel of ["target/idl/flacon.json", "packages/proof/src/idl/flacon.json"]) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error("IDL not found — run `anchor build` first");
}

function serverPubkeyHex(): { hex: string; source: string } {
  if (flag("--server-pubkey-from-env")) {
    const envPath = path.join(ROOT, "apps/verify/.env");
    const env = fs.readFileSync(envPath, "utf8");
    const line = env.split(/\r?\n/).find((l) => l.trim().startsWith("FV_SERVER_ED25519_SEED="));
    const seedHex = line?.split("=")[1]?.split("#")[0]?.trim();
    if (!seedHex || seedHex.length !== 64) throw new Error(`FV_SERVER_ED25519_SEED missing/invalid in ${envPath}`);
    const kp = nacl.sign.keyPair.fromSeed(Buffer.from(seedHex, "hex"));
    return { hex: Buffer.from(kp.publicKey).toString("hex"), source: "apps/verify/.env (derived)" };
  }
  const cli = arg("--server-pubkey");
  if (cli) {
    if (!/^[0-9a-fA-F]{64}$/.test(cli)) throw new Error("--server-pubkey must be 32 bytes hex");
    return { hex: cli.toLowerCase(), source: "--server-pubkey" };
  }
  const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/vectors.json"), "utf8"));
  return { hex: vectors.serverTestKey.pubkeyHex, source: "docs/vectors.json serverTestKey (TEST ONLY)" };
}

function label32(s: string): number[] {
  const b = Buffer.alloc(32);
  const src = Buffer.from(s, "utf8");
  if (src.length > 32) throw new Error(`label too long (${src.length} > 32 bytes): ${s}`);
  src.copy(b);
  return Array.from(b);
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? DEVNET;
  const walletPath = expandHome(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new Program(idl, provider);
  const programId = program.programId;
  const wallet = keypair.publicKey;
  const cluster = url.includes("devnet") ? "devnet" : url.includes("127.0.0.1") || url.includes("localhost") ? "custom&customUrl=" + encodeURIComponent(url) : "mainnet-beta";
  const explorer = (kind: "address" | "tx", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=${cluster}`;

  const { hex: serverHex, source } = serverPubkeyHex();
  const serverPubkey = Array.from(Buffer.from(serverHex, "hex"));

  console.log(`rpc        ${url}`);
  console.log(`wallet     ${wallet.toBase58()}  (${(await connection.getBalance(wallet)) / 1e9} SOL)`);
  console.log(`program    ${programId.toBase58()}  ${explorer("address", programId.toBase58())}`);
  console.log(`server key id ${SERVER_KEY_ID} = ${serverHex}  [${source}]`);

  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("registry")], programId);
  console.log(`registry   ${registryPda.toBase58()}  ${explorer("address", registryPda.toBase58())}`);

  const registryAccount = (program.account as any).registry;
  let reg = await registryAccount.fetchNullable(registryPda);
  if (!reg) {
    const sig = await program.methods
      .initRegistry()
      .accountsStrict({ registry: registryPda, authority: wallet, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`init_registry        ${sig}`);
    reg = await registryAccount.fetch(registryPda);
  } else {
    console.log(`init_registry        skipped (exists, authority ${reg.authority.toBase58()})`);
  }
  if (!reg.authority.equals(wallet)) {
    throw new Error(`registry authority is ${reg.authority.toBase58()}, not this wallet — cannot seed`);
  }
  const admin = { registry: registryPda, authority: wallet };

  const hasKey = reg.serverKeys.some((k: any) => k.keyId === SERVER_KEY_ID);
  if (!hasKey) {
    const sig = await program.methods
      .addServerKey(SERVER_KEY_ID, serverPubkey, new BN(0), new BN(0))
      .accountsStrict(admin)
      .rpc();
    console.log(`add_server_key(${SERVER_KEY_ID}) ${sig}`);
  } else {
    const k = reg.serverKeys.find((k: any) => k.keyId === SERVER_KEY_ID);
    const onchain = Buffer.from(k.pubkey).toString("hex");
    console.log(
      `add_server_key(${SERVER_KEY_ID}) skipped (exists${onchain === serverHex ? "" : `, DIFFERENT pubkey on-chain: ${onchain}`})`
    );
  }

  if (!reg.partners.some((p: PublicKey) => p.equals(wallet))) {
    const sig = await program.methods.addPartner(wallet).accountsStrict(admin).rpc();
    console.log(`add_partner(wallet)  ${sig}`);
  } else {
    console.log(`add_partner(wallet)  skipped (exists)`);
  }

  for (const s of PARTNER_SITES) {
    if (reg.sites.some((x: any) => x.siteId === s.siteId)) {
      console.log(`add_site(${s.siteId})          skipped (exists)`);
      continue;
    }
    const sig = await program.methods.addSite(s.siteId, label32(s.label)).accountsStrict(admin).rpc();
    console.log(`add_site(${s.siteId}, "${s.label}") ${sig}`);
  }

  reg = await registryAccount.fetch(registryPda);
  console.log("\nregistry state:");
  console.log(`  authority   ${reg.authority.toBase58()}`);
  for (const k of reg.serverKeys)
    console.log(`  server_key  id=${k.keyId} ${Buffer.from(k.pubkey).toString("hex")} valid ${k.validFrom}..${k.validTo.toString() === "0" ? "open" : k.validTo}`);
  for (const p of reg.partners) console.log(`  partner     ${p.toBase58()}`);
  for (const s of reg.sites)
    console.log(`  site        ${s.siteId} "${Buffer.from(s.label).toString("utf8").replace(/\0+$/, "")}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
