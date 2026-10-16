/**
 * Manage the verifier's signing keys in the flacon registry (registry authority only).
 *
 *   npx tsx scripts/server-key.ts add <pubkeyHex32> <keyId> [--valid-from <unix>] [--valid-to <unix>]
 *   npx tsx scripts/server-key.ts revoke <keyId>      # valid_to = now − 1: signatures under it stop anchoring at once
 *   npx tsx scripts/server-key.ts list
 *
 * Rotation: add the new key under a fresh key_id, switch the verifier (FV_SERVER_KEY_ID + seed), then revoke the old id.
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET.
 */
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { keyStatus, loadWallet, parseServerKeyArgs, programFor, providerFor } from "./lib/cli";

async function main() {
  const cmd = parseServerKeyArgs(process.argv.slice(2));
  const keypair = loadWallet();
  const program = programFor("flacon", providerFor(keypair));
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], program.programId);
  const reg: any = await (program.account as any).registry.fetch(registry);
  const now = Math.floor(Date.now() / 1000);
  const show = (k: any) =>
    `id=${k.keyId} ${Buffer.from(k.pubkey).toString("hex")} valid ${k.validFrom}..${k.validTo.toString() === "0" ? "open" : k.validTo}` +
    ` [${keyStatus({ keyId: k.keyId, pubkeyHex: "", validFrom: Number(k.validFrom), validTo: Number(k.validTo) }, now)}]`;
  if (cmd.cmd === "list") { for (const k of reg.serverKeys) console.log(show(k)); return; }
  if (!reg.authority.equals(keypair.publicKey)) throw new Error(`registry authority is ${reg.authority.toBase58()}, not this wallet`);
  const admin = { registry, authority: keypair.publicKey };
  if (cmd.cmd === "add") {
    if (reg.serverKeys.some((k: any) => k.keyId === cmd.keyId)) throw new Error(`key_id ${cmd.keyId} is taken (revoked ids stay taken); pick another`);
    const sig = await program.methods.addServerKey(cmd.keyId, Array.from(Buffer.from(cmd.pubkeyHex, "hex")), new BN(cmd.validFrom), new BN(cmd.validTo)).accountsStrict(admin).rpc();
    console.log(`add_server_key(${cmd.keyId}) ${cmd.pubkeyHex} ${sig}`);
  } else {
    if (!reg.serverKeys.some((k: any) => k.keyId === cmd.keyId)) throw new Error(`no server key with key_id ${cmd.keyId}`);
    const sig = await program.methods.revokeServerKey(cmd.keyId).accountsStrict(admin).rpc();
    console.log(`revoke_server_key(${cmd.keyId}) ${sig}`);
  }
  const after: any = await (program.account as any).registry.fetch(registry);
  for (const k of after.serverKeys) console.log(`  ${show(k)}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
