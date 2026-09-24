/**
 * Idempotent seed for programs/escrow on localnet (or devnet with the real USDC mint):
 *   - USDC mint: FV_USDC_MINT if set, else the mint stored in an existing config, else a new
 *     test mint (6 dp, mint authority = wallet) — printed
 *   - init_config(admin = wallet, dispute_after_s = FV_DISPUTE_AFTER_S | 7 days) if missing
 *   - wallet ATA topped up to 1000 test USDC (only when the wallet is the mint authority)
 *
 * Usage: npx tsx scripts/seed-escrow.ts
 * Env:   ANCHOR_PROVIDER_URL (default http://127.0.0.1:8899), ANCHOR_WALLET (default ~/.config/solana/id.json),
 *        FV_USDC_MINT (devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU), FV_DISPUTE_AFTER_S
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createMint, ensureAta, mintAuthority, mintTo, tokenBalance } from "./lib/spl";

const ROOT = path.resolve(__dirname, "..");
const LOCALNET = "http://127.0.0.1:8899";
const DEFAULT_DISPUTE_AFTER_S = 7 * 24 * 60 * 60;
const SEED_USDC = 1000n * 1_000_000n;

const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function loadIdl(): any {
  for (const rel of ["target/idl/escrow.json", "packages/proof/src/idl/escrow.json"]) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error("escrow IDL not found — run `anchor build` first");
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? LOCALNET;
  const walletPath = expandHome(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(loadIdl(), provider);
  const wallet = keypair.publicKey;
  const cluster = url.includes("devnet")
    ? "devnet"
    : url.includes("127.0.0.1") || url.includes("localhost")
      ? "custom&customUrl=" + encodeURIComponent(url)
      : "mainnet-beta";
  const explorer = (v: string) => `https://explorer.solana.com/address/${v}?cluster=${cluster}`;
  const disputeAfterS = Number(process.env.FV_DISPUTE_AFTER_S ?? DEFAULT_DISPUTE_AFTER_S);

  console.log(`rpc        ${url}`);
  console.log(`wallet     ${wallet.toBase58()}  (${(await connection.getBalance(wallet)) / 1e9} SOL)`);
  console.log(`program    ${program.programId.toBase58()}  ${explorer(program.programId.toBase58())}`);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const configAccount = (program.account as any).escrowConfig;
  let cfg = await configAccount.fetchNullable(configPda);

  let mint: PublicKey;
  if (cfg) {
    mint = cfg.usdcMint;
    if (process.env.FV_USDC_MINT && process.env.FV_USDC_MINT !== mint.toBase58()) {
      console.log(`warning: FV_USDC_MINT=${process.env.FV_USDC_MINT} differs from the configured mint ${mint.toBase58()}`);
    }
    console.log(`init_config          skipped (exists, admin ${cfg.admin.toBase58()}, window ${cfg.disputeAfterS}s)`);
    if (cfg.disputeAfterS.toNumber() !== disputeAfterS && cfg.admin.equals(wallet)) {
      const sig = await program.methods.setDisputeWindow(new BN(disputeAfterS)).accountsStrict({ config: configPda, admin: wallet }).rpc();
      console.log(`set_dispute_window(${disputeAfterS}s)  ${sig}`);
    }
  } else {
    if (process.env.FV_USDC_MINT) {
      mint = new PublicKey(process.env.FV_USDC_MINT);
    } else {
      mint = await createMint(connection, keypair, wallet, 6);
      console.log(`usdc mint  created test mint ${mint.toBase58()} (6 dp, authority = wallet)`);
    }
    const sig = await program.methods
      .initConfig(new BN(disputeAfterS))
      .accountsStrict({ config: configPda, admin: wallet, usdcMint: mint, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`init_config(${disputeAfterS}s)  ${sig}`);
    cfg = await configAccount.fetch(configPda);
  }
  console.log(`config     ${configPda.toBase58()}  ${explorer(configPda.toBase58())}`);
  console.log(`usdc mint  ${mint.toBase58()}  ${explorer(mint.toBase58())}`);

  const ata = await ensureAta(connection, keypair, wallet, mint);
  const bal = await tokenBalance(connection, ata);
  const auth = await mintAuthority(connection, mint);
  if (auth && auth.equals(wallet) && bal < SEED_USDC) {
    await mintTo(connection, keypair, mint, ata, keypair, SEED_USDC - bal);
    console.log(`mint_to    ${Number(SEED_USDC - bal) / 1e6} USDC → ${ata.toBase58()}`);
  } else if (!auth || !auth.equals(wallet)) {
    console.log(`mint_to    skipped (wallet is not the mint authority — real USDC?)`);
  } else {
    console.log(`mint_to    skipped (balance already ${Number(bal) / 1e6} USDC)`);
  }
  console.log(`wallet ata ${ata.toBase58()}  balance ${Number(await tokenBalance(connection, ata)) / 1e6} USDC`);
  console.log(`\nNEXT_PUBLIC_ESCROW_PROGRAM_ID=${program.programId.toBase58()}\nNEXT_PUBLIC_USDC_MINT=${mint.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
