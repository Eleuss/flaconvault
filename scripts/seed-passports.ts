/**
 * Idempotent on-chain seed of the demo passports from docs/seed/passports.json:
 *   mint_passport(serial_hash, binding_hash, asset) + attach_seal(uid_hash, kind) for every seal,
 *   then mark_seal_dead for every seal the seed marks `dead: true` (so the chain agrees with the verifier's VOID).
 * mint_passport only accepts a Metaplex Core asset: a seed `asset` that is not one on this cluster is replaced by a
 * freshly minted Core asset owned by the wallet.
 * The wallet must be a registry partner (run scripts/seed-devnet.ts first).
 *
 * Usage: npx tsx scripts/seed-passports.ts            (ANCHOR_PROVIDER_URL, ANCHOR_WALLET as in seed-devnet.ts)
 */
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createCoreAssetIx, fetchCoreAsset } from "./lib/core";
import { ROOT, SERIAL_RE, UID_RE, loadWallet, programFor, providerFor, rpcUrl } from "./lib/cli";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

interface SeedSeal { uid: string; kind: number; dead?: boolean }
interface SeedPassport { serial: string; batch: string; brand?: string; name?: string; asset?: string | null; seals: SeedSeal[] }

async function main() {
  const url = rpcUrl();
  const keypair = loadWallet();
  const provider = providerFor(keypair, url);
  const connection = provider.connection;
  const program = programFor("flacon", provider);
  const programId = program.programId;
  const wallet = keypair.publicKey;
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("registry")], programId);
  console.log(`rpc ${url}\nwallet ${wallet.toBase58()} (${(await connection.getBalance(wallet)) / 1e9} SOL)\nprogram ${programId.toBase58()}`);

  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/seed/passports.json"), "utf8")) as { passports: SeedPassport[] };
  for (const p of seed.passports) {
    if (!SERIAL_RE.test(p.serial)) throw new Error(`seed serial "${p.serial}" is not a valid serial`);
    for (const s of p.seals) if (!UID_RE.test(s.uid) || (s.kind !== 0 && s.kind !== 1)) throw new Error(`seed seal ${s.uid} of ${p.serial} is invalid`);
  }
  const passportAccount = (program.account as any).passport;
  const sealAccount = (program.account as any).seal;

  for (const p of seed.passports) {
    const serialHash = sha256(Buffer.from(p.serial, "utf8"));
    const [passportPda] = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], programId);
    const first = p.seals[0];
    const firstUidHash = sha256(Buffer.from(first.uid, "hex"));
    const bindingHash = sha256(Buffer.concat([Buffer.from(p.serial, "utf8"), Buffer.from(p.batch ?? "", "utf8"), firstUidHash]));

    const existing = await passportAccount.fetchNullable(passportPda);
    if (!existing) {
      let asset: PublicKey | null = null;
      try { asset = p.asset ? new PublicKey(p.asset) : null; } catch { asset = null; }
      if (!asset || !(await fetchCoreAsset(connection, asset))) {
        const assetKp = Keypair.generate();
        const ix = createCoreAssetIx({ asset: assetKp.publicKey, payer: wallet, name: `${p.brand ?? ""} ${p.name ?? ""} · ${p.serial}`.trim().slice(0, 64), uri: `https://verify.flaconvault.com/api/passport/${encodeURIComponent(p.serial)}` });
        const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [keypair, assetKp], { commitment: "confirmed" });
        asset = assetKp.publicKey;
        console.log(`${p.serial}  core asset  ${asset.toBase58()}  ${sig}`);
      }
      const sig = await program.methods
        .mintPassport(Array.from(serialHash), Array.from(bindingHash), asset)
        .accountsStrict({ registry: registryPda, passport: passportPda, issuer: wallet, systemProgram: SystemProgram.programId, coreAsset: asset })
        .rpc();
      console.log(`${p.serial}  mint_passport  ${passportPda.toBase58()}  ${sig}`);
    } else {
      console.log(`${p.serial}  mint_passport  skipped (exists, grade ${existing.grade}, scans ${existing.scanCount}${existing.void ? ", void" : ""})`);
    }
    for (const s of p.seals) {
      const uidHash = sha256(Buffer.from(s.uid, "hex"));
      const [sealPda] = PublicKey.findProgramAddressSync([Buffer.from("seal"), uidHash], programId);
      let ex = await sealAccount.fetchNullable(sealPda);
      if (ex) console.log(`  seal ${s.uid}  skipped (exists, counter ${ex.lastCounter}${ex.dead ? ", dead" : ""})`);
      else {
        const sig = await program.methods
          .attachSeal(Array.from(uidHash), s.kind)
          .accountsStrict({ registry: registryPda, passport: passportPda, seal: sealPda, signer: wallet, systemProgram: SystemProgram.programId })
          .rpc();
        console.log(`  seal ${s.uid}  attach_seal(kind ${s.kind})  ${sealPda.toBase58()}  ${sig}`);
        ex = await sealAccount.fetch(sealPda);
      }
      if (s.dead && !ex.dead) {
        const sig = await program.methods
          .markSealDead()
          .accountsStrict({ registry: registryPda, passport: passportPda, seal: sealPda, signer: wallet })
          .rpc();
        console.log(`  seal ${s.uid}  mark_seal_dead (seed says dead)  ${sig}`);
      }
    }
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
