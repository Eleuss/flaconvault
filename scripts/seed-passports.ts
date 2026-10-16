/**
 * Idempotent on-chain seed of the demo passports from docs/seed/passports.json:
 *   mint_passport(serial_hash, binding_hash, asset) + attach_seal(uid_hash, kind) for every seal of a passport,
 *   then mark_seal_dead for every seal the seed marks `dead: true` (so the chain agrees with the verifier's VOID).
 *   All seals are attached before any is marked dead: a dead seal voids the passport, and a void passport takes no
 *   further seal.
 * mint_passport only accepts a Metaplex Core asset owned by the issuer: a seed `asset` that is not one on this cluster
 * (or belongs to someone else, or already backs another passport) is replaced by a freshly minted Core asset owned by
 * the wallet, whose uri is the verifier's metadata JSON (<FV_VERIFY_URL>/api/passport/<serial>/metadata.json).
 * The wallet must be a registry partner (run scripts/seed-devnet.ts first).
 *
 * Usage: npx tsx scripts/seed-passports.ts            (ANCHOR_PROVIDER_URL, ANCHOR_WALLET as in seed-devnet.ts;
 *                                                     FV_VERIFY_URL, default https://verify.flaconvault.com)
 */
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createCoreAssetIx, fetchCoreAsset } from "./lib/core";
import { ROOT, SERIAL_RE, UID_RE, existingAssetProblem, loadIdl, loadWallet, passportsUsingAsset, programFor, providerFor, rpcUrl, sealSeedPlan, verifyUrl } from "./lib/cli";
import { coreAssetUri } from "../apps/web/src/lib/escrow-rules";

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
  const verify = verifyUrl();
  const idl = loadIdl("flacon");
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
      if (asset) {
        const core = await fetchCoreAsset(connection, asset);
        const problem = existingAssetProblem({ asset, core, wallet, usedBy: core ? await passportsUsingAsset(connection, programId, idl, asset) : [] });
        if (problem) { console.log(`${p.serial}  seed asset not usable (${problem.replace(/; pass "new".*$/, "")}), minting a new one`); asset = null; }
      }
      if (!asset) {
        const assetKp = Keypair.generate();
        const ix = createCoreAssetIx({ asset: assetKp.publicKey, payer: wallet, name: `${p.brand ?? ""} ${p.name ?? ""} · ${p.serial}`.trim().slice(0, 64), uri: coreAssetUri(verify, p.serial) });
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
    const sealPdaOf = (uid: string) => PublicKey.findProgramAddressSync([Buffer.from("seal"), sha256(Buffer.from(uid, "hex"))], programId)[0];
    // every seal is attached before any is marked dead (a dead seal voids the passport, which then takes no new seal)
    for (const step of sealSeedPlan(p.seals)) {
      const sealPda = sealPdaOf(step.uid);
      const ex = await sealAccount.fetchNullable(sealPda);
      if (step.op === "attach") {
        if (ex) { console.log(`  seal ${step.uid}  skipped (exists, counter ${ex.lastCounter}${ex.dead ? ", dead" : ""})`); continue; }
        const sig = await program.methods
          .attachSeal(Array.from(sha256(Buffer.from(step.uid, "hex"))), step.kind)
          .accountsStrict({ registry: registryPda, passport: passportPda, seal: sealPda, signer: wallet, systemProgram: SystemProgram.programId })
          .rpc();
        console.log(`  seal ${step.uid}  attach_seal(kind ${step.kind})  ${sealPda.toBase58()}  ${sig}`);
      } else if (ex && !ex.dead) {
        const sig = await program.methods
          .markSealDead()
          .accountsStrict({ registry: registryPda, passport: passportPda, seal: sealPda, signer: wallet })
          .rpc();
        console.log(`  seal ${step.uid}  mark_seal_dead (seed says dead)  ${sig}`);
      }
    }
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
