/**
 * Devnet rollout step 3 of the public record (docs/public-record.md §11; run by the owner, never by CI or a builder):
 * `init_holding_v1` for every passport the flacon program holds that has no Holding yet, so every existing pass can
 * take `record_scan_v2` scans. The registry authority (ANCHOR_WALLET) signs and pays the rent of each Holding
 * (8 + 221 bytes). Idempotent: passports with a Holding and v2 passports are skipped, so it can be re-run after a
 * failure. Run it after the program upgrade and `init_holder_config` (steps 1 and 2).
 *
 * Usage: npx tsx scripts/init-holdings.ts [--dry-run]     (ANCHOR_PROVIDER_URL, default devnet; ANCHOR_WALLET)
 *   --dry-run   list what would be initialised, send nothing
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { holdingPdaOf, loadWallet, planHoldings, programFor, providerFor, rpcUrl } from "./lib/cli";

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const unknown = process.argv.slice(2).filter((a) => a !== "--dry-run");
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]}\nusage: init-holdings [--dry-run]`);
  const url = rpcUrl();
  const keypair = loadWallet();
  const provider = providerFor(keypair, url);
  const program = programFor("flacon", provider);
  const programId = program.programId;
  const account = program.account as any;
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], programId);
  const [holderConfig] = PublicKey.findProgramAddressSync([Buffer.from("holder_config")], programId);
  console.log(`rpc ${url}\nwallet ${keypair.publicKey.toBase58()}\nprogram ${programId.toBase58()}${dryRun ? "\n(dry run: nothing is sent)" : ""}`);

  const reg = await account.registry.fetch(registry);
  if (!reg.authority.equals(keypair.publicKey)) throw new Error(`registry authority is ${reg.authority.toBase58()}, not this wallet`);
  if (!(await provider.connection.getAccountInfo(holderConfig))) {
    console.warn("warning: no holder_config yet (rollout step 2): record_scan_v2 needs it, init_holding_v1 does not");
  }

  const passports: { publicKey: PublicKey; account: { asset: PublicKey } }[] = await account.passport.all();
  const holdings = passports.map((p) => holdingPdaOf(programId, p.publicKey));
  const existing: (unknown | null)[] = [];
  for (let i = 0; i < holdings.length; i += 100) existing.push(...(await account.holding.fetchMultiple(holdings.slice(i, i + 100))));
  const plan = planHoldings(passports.map((p, i) => ({ passport: p.publicKey, asset: p.account.asset, holding: holdings[i], holdingExists: existing[i] !== null })));
  const todo = plan.filter((s) => s.op === "init");
  console.log(`${passports.length} passports, ${todo.length} without a Holding`);
  for (const step of plan) {
    if (step.op === "skip") { console.log(`  skip ${step.passport.toBase58()} (${step.reason})`); continue; }
    if (dryRun) { console.log(`  would init ${step.passport.toBase58()} → holding ${step.holding.toBase58()}`); continue; }
    const sig = await program.methods
      .initHoldingV1()
      .accountsStrict({ registry, passport: step.passport, holding: step.holding, authority: keypair.publicKey, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`  init ${step.passport.toBase58()} → holding ${step.holding.toBase58()} ${sig}`);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
