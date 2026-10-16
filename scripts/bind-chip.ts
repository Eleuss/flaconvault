/**
 * Bind a real chip to a new passport from the CLI partner wallet (no phone needed):
 * mint_passport + attach_seal on chain, then MINT/SEAL_ATTACH events on the verifier.
 *
 * Usage: npx tsx scripts/bind-chip.ts <serial> <uid14hex> "<brand>" "<name>" "<batch>" <coreAssetPubkey|new> [kind=1] [verifyUrl]
 *   coreAsset  an existing Metaplex Core asset owned by this wallet and not bound to another passport (mint_passport only
 *              accepts a Core asset owned by the issuer), or `new` to mint one owned by this wallet, named after the
 *              serial, whose uri is the verifier's metadata JSON (<verifyUrl>/api/passport/<serial>/metadata.json).
 *   verifyUrl  default FV_VERIFY_URL or https://verify.flaconvault.com
 *
 * Every argument is checked before anything is sent. Re-running is safe: when the passport or seal already exists on
 * chain, the script looks up the transaction that created it (a mint_passport / attach_seal instruction on that account,
 * signed by this wallet) and posts the event again (the verifier treats a repeated MINT / SEAL_ATTACH for the same
 * transaction as a no-op), so a failed post can always be recovered.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { createCoreAssetIx, fetchCoreAsset } from "./lib/core";
import { creatingSignature, existingAssetProblem, expectationFromIdl, loadIdl, loadWallet, parseBindChipArgs, passportsUsingAsset, postEvent, programFor, providerFor } from "./lib/cli";
import { coreAssetUri } from "../apps/web/src/lib/escrow-rules";

const sha = (b: Buffer) => createHash("sha256").update(b).digest();
const APP_URL = (process.env.FV_APP_URL ?? "https://app.flaconvault.com").replace(/\/$/, "");

async function main() {
  const a = parseBindChipArgs(process.argv.slice(2));
  const kp = loadWallet();
  const provider = providerFor(kp);
  const connection = provider.connection;
  const program = programFor("flacon", provider);
  const pid = program.programId, wallet = kp.publicKey;
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("registry")], pid);
  const serialHash = sha(Buffer.from(a.serial, "utf8")), uidHash = sha(Buffer.from(a.uid, "hex"));
  const [passport] = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], pid);
  const [seal] = PublicKey.findProgramAddressSync([Buffer.from("seal"), uidHash], pid);
  const bindingHash = sha(Buffer.concat([Buffer.from(a.serial, "utf8"), Buffer.from(a.batch, "utf8"), uidHash]));
  const acct: any = program.account;
  const idl = loadIdl("flacon");

  const reg: any = await acct.registry.fetch(registry);
  const isPartner = reg.partners.some((p: PublicKey) => p.equals(wallet)) || reg.authority.equals(wallet);
  if (!isPartner) throw new Error(`wallet ${wallet.toBase58()} is not a registry partner`);

  const existingPassport: any = await acct.passport.fetchNullable(passport);
  let mintSig: string;
  let asset: PublicKey;
  if (!existingPassport) {
    if (a.asset === "new") {
      const assetKp = Keypair.generate();
      const ix = createCoreAssetIx({ asset: assetKp.publicKey, payer: wallet, name: `${a.brand} ${a.name} · ${a.serial}`.slice(0, 64), uri: coreAssetUri(a.verify, a.serial) });
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [kp, assetKp], { commitment: "confirmed" });
      asset = assetKp.publicKey;
      console.log(`core asset ${asset.toBase58()} ${sig}`);
    } else {
      asset = a.asset;
      const core = await fetchCoreAsset(connection, asset);
      const problem = existingAssetProblem({ asset, core, wallet, usedBy: core ? await passportsUsingAsset(connection, pid, idl, asset) : [] });
      if (problem) throw new Error(problem);
    }
    mintSig = await program.methods
      .mintPassport(Array.from(serialHash), Array.from(bindingHash), asset)
      .accountsStrict({ registry, passport, issuer: wallet, systemProgram: SystemProgram.programId, coreAsset: asset })
      .rpc();
    console.log(`mint_passport ${a.serial} ${mintSig}`);
  } else {
    if (!existingPassport.issuer.equals(wallet)) throw new Error(`passport ${a.serial} exists and was issued by ${existingPassport.issuer.toBase58()}`);
    asset = existingPassport.asset;
    const found = await creatingSignature(connection, passport, expectationFromIdl(idl, pid, "mint_passport", "passport", wallet));
    if (!found) throw new Error(`passport ${a.serial} exists, but no mint_passport transaction for it signed by this wallet was found; cannot post MINT`);
    mintSig = found;
    console.log(`passport ${a.serial} exists · re-posting MINT for ${mintSig}`);
  }
  await postEvent(a.verify, {
    serial: a.serial, type: 0, txSig: mintSig, actor: wallet.toBase58(),
    payload: { brand: a.brand, name: a.name, batch: a.batch, asset: asset.toBase58(), issuerLabel: "Parfümerie X, Düsseldorf", siteId: 1, bindingHash: "0x" + Buffer.from(existingPassport?.bindingHash ?? bindingHash).toString("hex") },
  });

  const existingSeal: any = await acct.seal.fetchNullable(seal);
  let sealSig: string;
  if (!existingSeal) {
    sealSig = await program.methods
      .attachSeal(Array.from(uidHash), a.kind)
      .accountsStrict({ registry, passport, seal, signer: wallet, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`attach_seal ${a.uid} kind ${a.kind} ${sealSig}`);
  } else {
    if (!existingSeal.passport.equals(passport)) throw new Error(`seal ${a.uid} is attached to another passport (${existingSeal.passport.toBase58()})`);
    const found = await creatingSignature(connection, seal, expectationFromIdl(idl, pid, "attach_seal", "seal", wallet));
    if (!found) throw new Error(`seal ${a.uid} exists, but no attach_seal transaction for it signed by this wallet was found; cannot post SEAL_ATTACH`);
    sealSig = found;
    console.log(`seal ${a.uid} exists · re-posting SEAL_ATTACH for ${sealSig}`);
  }
  await postEvent(a.verify, { serial: a.serial, type: 1, txSig: sealSig, actor: wallet.toBase58(), payload: { uid: a.uid, kind: existingSeal?.kind ?? a.kind, siteId: 1 } });
  console.log(`passport: ${APP_URL}/p/${encodeURIComponent(a.serial)}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
