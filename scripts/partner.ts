/**
 * Manage the registry partner list (registry authority only).
 *
 *   npx tsx scripts/partner.ts add <pubkey>
 *   npx tsx scripts/partner.ts remove <pubkey>   # also ends its attach_seal / mark_seal_dead rights on passports it issued
 *   npx tsx scripts/partner.ts list
 *
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET.
 */
import { PublicKey } from "@solana/web3.js";
import { loadWallet, parsePartnerArgs, programFor, providerFor } from "./lib/cli";

export async function runPartner(argv: string[]) {
  const cmd = parsePartnerArgs(argv);
  const keypair = loadWallet();
  const program = programFor("flacon", providerFor(keypair));
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], program.programId);
  const reg: any = await (program.account as any).registry.fetch(registry);
  if (cmd.cmd === "list") { for (const p of reg.partners) console.log(p.toBase58()); return; }
  if (!reg.authority.equals(keypair.publicKey)) throw new Error(`registry authority is ${reg.authority.toBase58()}, not this wallet`);
  const admin = { registry, authority: keypair.publicKey };
  const known = reg.partners.some((p: PublicKey) => p.equals(cmd.partner));
  if (cmd.cmd === "add") {
    if (known) { console.log("already a partner"); return; }
    const sig = await program.methods.addPartner(cmd.partner).accountsStrict(admin).rpc();
    console.log(`add_partner ${cmd.partner.toBase58()} ${sig}`);
  } else {
    if (!known) { console.log("not a partner"); return; }
    const sig = await program.methods.removePartner(cmd.partner).accountsStrict(admin).rpc();
    console.log(`remove_partner ${cmd.partner.toBase58()} ${sig}`);
  }
}

if (require.main === module) runPartner(process.argv.slice(2)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
