/**
 * The flacon HolderConfig (docs/public-record.md §6.1, §7.1; registry authority only). Devnet rollout step 2: the
 * `cluster_tag` stored here is immutable and every FVSCAN2 must carry it (the verifier's `FV_CLUSTER`), so `init`
 * checks the cluster name against the RPC. guardian, holder_key and registrar_key stay zero until P2 / P5
 * (`set_holder_config`).
 *
 *   npx tsx scripts/holder-config.ts init devnet     # init_holder_config(2, 0, 0, 0); the wallet signs and pays
 *   npx tsx scripts/holder-config.ts show
 *
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { loadWallet, parseHolderConfigArgs, programFor, providerFor, rpcUrl } from "./lib/cli";

async function main() {
  const url = rpcUrl();
  const cmd = parseHolderConfigArgs(process.argv.slice(2), url);
  const keypair = loadWallet();
  const program = programFor("flacon", providerFor(keypair, url));
  const account = program.account as any;
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], program.programId);
  const [holderConfig] = PublicKey.findProgramAddressSync([Buffer.from("holder_config")], program.programId);
  const show = async () => {
    const c = await account.holderConfig.fetchNullable(holderConfig);
    if (!c) { console.log(`holder_config ${holderConfig.toBase58()}: not initialised`); return; }
    console.log(`holder_config ${holderConfig.toBase58()}\n  authority ${c.authority.toBase58()}\n  cluster_tag ${c.clusterTag}` +
      `\n  guardian ${c.guardian.toBase58()}\n  holder_key ${c.holderKey.toBase58()}\n  registrar_key ${c.registrarKey.toBase58()}` +
      `\n  claim_delay_s ${c.claimDelayS} notap_delay_s ${c.notapDelayS} paused ${c.paused}`);
  };
  if (cmd.cmd === "show") return show();
  const reg = await account.registry.fetch(registry);
  if (!reg.authority.equals(keypair.publicKey)) throw new Error(`registry authority is ${reg.authority.toBase58()}, not this wallet`);
  if (await account.holderConfig.fetchNullable(holderConfig)) throw new Error("holder_config exists already (its cluster_tag cannot change)");
  const sig = await program.methods
    .initHolderConfig(cmd.tag, PublicKey.default, PublicKey.default, PublicKey.default)
    .accountsStrict({ registry, holderConfig, authority: keypair.publicKey, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`init_holder_config(${cmd.cluster} = ${cmd.tag}) ${sig}`);
  await show();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
