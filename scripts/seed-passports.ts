/**
 * Idempotent on-chain seed of the demo passports from docs/seed/passports.json:
 *   mint_passport(serial_hash, binding_hash, asset) + attach_seal(uid_hash, kind) for every seal.
 * The wallet must be a registry partner (run scripts/seed-devnet.ts first).
 *
 * Usage: npx tsx scripts/seed-passports.ts            (ANCHOR_PROVIDER_URL, ANCHOR_WALLET as in seed-devnet.ts)
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const DEVNET = "https://api.devnet.solana.com";
const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

function loadIdl(): any {
  for (const rel of ["target/idl/flacon.json", "packages/proof/src/idl/flacon.json"]) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error("IDL not found — run `anchor build` first");
}

interface SeedSeal { uid: string; kind: number }
interface SeedPassport { serial: string; batch: string; asset?: string | null; seals: SeedSeal[] }

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? DEVNET;
  const walletPath = expandHome(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(loadIdl(), provider);
  const programId = program.programId;
  const wallet = keypair.publicKey;
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("registry")], programId);
  console.log(`rpc ${url}\nwallet ${wallet.toBase58()} (${(await connection.getBalance(wallet)) / 1e9} SOL)\nprogram ${programId.toBase58()}`);

  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/seed/passports.json"), "utf8")) as { passports: SeedPassport[] };
  const passportAccount = (program.account as any).passport;
  const sealAccount = (program.account as any).seal;

  for (const p of seed.passports) {
    const serialHash = sha256(Buffer.from(p.serial, "utf8"));
    const [passportPda] = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], programId);
    const first = p.seals[0];
    const firstUidHash = sha256(Buffer.from(first.uid, "hex"));
    const bindingHash = sha256(Buffer.concat([Buffer.from(p.serial, "utf8"), Buffer.from(p.batch ?? "", "utf8"), firstUidHash]));
    let asset: PublicKey;
    try { asset = new PublicKey(p.asset ?? ""); } catch { asset = Keypair.generate().publicKey; }

    const existing = await passportAccount.fetchNullable(passportPda);
    if (!existing) {
      const sig = await program.methods
        .mintPassport(Array.from(serialHash), Array.from(bindingHash), asset)
        .accountsStrict({ registry: registryPda, passport: passportPda, issuer: wallet, systemProgram: SystemProgram.programId })
        .rpc();
      console.log(`${p.serial}  mint_passport  ${passportPda.toBase58()}  ${sig}`);
    } else {
      console.log(`${p.serial}  mint_passport  skipped (exists, grade ${existing.grade}, scans ${existing.scanCount})`);
    }
    for (const s of p.seals) {
      const uidHash = sha256(Buffer.from(s.uid, "hex"));
      const [sealPda] = PublicKey.findProgramAddressSync([Buffer.from("seal"), uidHash], programId);
      const ex = await sealAccount.fetchNullable(sealPda);
      if (ex) { console.log(`  seal ${s.uid}  skipped (exists, counter ${ex.lastCounter}${ex.dead ? ", dead" : ""})`); continue; }
      const sig = await program.methods
        .attachSeal(Array.from(uidHash), s.kind)
        .accountsStrict({ registry: registryPda, passport: passportPda, seal: sealPda, signer: wallet, systemProgram: SystemProgram.programId })
        .rpc();
      console.log(`  seal ${s.uid}  attach_seal(kind ${s.kind})  ${sealPda.toBase58()}  ${sig}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
