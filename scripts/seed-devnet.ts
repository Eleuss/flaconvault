/**
 * Idempotent registry seed for programs/flacon (briefing §6 DoD):
 *   init_registry (skip if exists; only the program's upgrade authority may create it)
 *   · add_server_key(key_id 1 or --key-id, open-ended) · add_partner(wallet)
 *   · add_site(1, "Parfümerie X, Düsseldorf") · add_site(2, "FlaconVault Vault, Wickede")
 *
 * Usage (the verifier key must be chosen explicitly — there is no default):
 *   npx tsx scripts/seed-devnet.ts --server-pubkey <hex32>
 *   npx tsx scripts/seed-devnet.ts --server-pubkey-from-env          # derive from FV_SERVER_ED25519_SEED in apps/verify/.env
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx scripts/seed-devnet.ts --test-key   # public vectors key, local only
 *
 *   add --key-id <0-255> to ask for another key_id than 1
 *
 * Env: ANCHOR_PROVIDER_URL (default https://api.devnet.solana.com), ANCHOR_WALLET (default ~/.config/solana/id.json)
 *
 * Server key (scripts/lib/cli.ts planServerKey): a key that is already registered and valid under any key_id is kept
 * (so the script can be re-run after a rotation: key 1 revoked, the new key added as 2). A new key goes to the asked
 * key_id, or to the next free one when that id holds a revoked or expired key. When the asked key_id holds a DIFFERENT
 * key that is still valid, the script fails (exit 1) and prints the rotation steps instead of silently keeping it.
 */
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import nacl from "tweetnacl";
import { ROOT, chooseServerKey, keyStatus, loadWallet, parseKeyIdFlag, planServerKey, programDataOf, programFor, providerFor, rpcUrl, type RegistryKey } from "./lib/cli";

const PARTNER_SITES: { siteId: number; label: string }[] = [
  { siteId: 1, label: "Parfümerie X, Düsseldorf" },
  { siteId: 2, label: "FlaconVault Vault, Wickede" },
];

function envSeed(): string | null {
  const envPath = path.join(ROOT, "apps/verify/.env");
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.trim().startsWith("FV_SERVER_ED25519_SEED="));
  return line?.split("=")[1]?.split("#")[0]?.trim() ?? null;
}

const toRegistryKey = (k: any): RegistryKey => ({
  keyId: k.keyId, pubkeyHex: Buffer.from(k.pubkey).toString("hex"), validFrom: Number(k.validFrom), validTo: Number(k.validTo),
});

function label32(s: string): number[] {
  const b = Buffer.alloc(32);
  const src = Buffer.from(s, "utf8");
  if (src.length > 32) throw new Error(`label too long (${src.length} > 32 bytes): ${s}`);
  src.copy(b);
  return Array.from(b);
}

async function main() {
  const url = rpcUrl();
  const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/vectors.json"), "utf8"));
  // validate before touching the chain
  const { hex: serverHex, source } = chooseServerKey({
    argv: process.argv.slice(2),
    url,
    envSeedHex: process.argv.includes("--server-pubkey-from-env") ? envSeed() : null,
    vectorsPubkeyHex: vectors.serverTestKey.pubkeyHex,
    derive: (seedHex) => Buffer.from(nacl.sign.keyPair.fromSeed(Buffer.from(seedHex, "hex")).publicKey).toString("hex"),
  });
  const serverPubkey = Array.from(Buffer.from(serverHex, "hex"));
  const wantedKeyId = parseKeyIdFlag(process.argv.slice(2));

  const keypair = loadWallet();
  const provider = providerFor(keypair, url);
  const connection = provider.connection;
  const program = programFor("flacon", provider);
  const programId = program.programId;
  const wallet = keypair.publicKey;
  const cluster = url.includes("devnet") ? "devnet" : url.includes("127.0.0.1") || url.includes("localhost") ? "custom&customUrl=" + encodeURIComponent(url) : "mainnet-beta";
  const explorer = (kind: "address" | "tx", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=${cluster}`;

  console.log(`rpc        ${url}`);
  console.log(`wallet     ${wallet.toBase58()}  (${(await connection.getBalance(wallet)) / 1e9} SOL)`);
  console.log(`program    ${programId.toBase58()}  ${explorer("address", programId.toBase58())}`);
  console.log(`server key ${serverHex}  [${source}], asked for key_id ${wantedKeyId}`);

  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("registry")], programId);
  console.log(`registry   ${registryPda.toBase58()}  ${explorer("address", registryPda.toBase58())}`);

  const registryAccount = (program.account as any).registry;
  let reg = await registryAccount.fetchNullable(registryPda);
  if (!reg) {
    const sig = await program.methods
      .initRegistry()
      .accountsStrict({ registry: registryPda, authority: wallet, systemProgram: SystemProgram.programId, program: programId, programData: programDataOf(programId) })
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

  const now = Math.floor(Date.now() / 1000);
  const keys: RegistryKey[] = reg.serverKeys.map(toRegistryKey);
  const plan = planServerKey(keys, serverHex, wantedKeyId, now);
  if (plan.action === "add") {
    const sig = await program.methods.addServerKey(plan.keyId, serverPubkey, new BN(0), new BN(0)).accountsStrict(admin).rpc();
    console.log(`add_server_key(${plan.keyId}) ${sig}  (${plan.note})`);
  } else {
    console.log(`add_server_key        skipped (${plan.note})`);
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
  for (const k of reg.serverKeys.map(toRegistryKey))
    console.log(`  server_key  id=${k.keyId} ${k.pubkeyHex} valid ${k.validFrom}..${k.validTo === 0 ? "open" : k.validTo} [${keyStatus(k, now)}]${k.pubkeyHex === serverHex ? "  ← this verifier key" : ""}`);
  for (const p of reg.partners) console.log(`  partner     ${p.toBase58()}`);
  for (const s of reg.sites)
    console.log(`  site        ${s.siteId} "${Buffer.from(s.label).toString("utf8").replace(/\0+$/, "")}"`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
