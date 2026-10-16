/**
 * Unit tests for the ops-script helpers (scripts/lib/cli.ts, scripts/lib/core.ts). No validator needed:
 *   NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json tests/scripts-cli.ts
 * (also runs as part of `anchor test`).
 */
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  PASSPORT_ASSET_OFFSET,
  bs58encode,
  chooseServerKey,
  existingAssetProblem,
  expectationFromIdl,
  isLocalUrl,
  keyStatus,
  parseBindChipArgs,
  parseKeyIdFlag,
  parsePartnerArgs,
  parseServerKeyArgs,
  planServerKey,
  sealSeedPlan,
  txCreatesAccount,
  type RegistryKey,
} from "../scripts/lib/cli";
import { MPL_CORE_PROGRAM_ID, burnCoreAssetIx, createCoreAssetIx, parseCoreAsset, transferCoreAssetIx } from "../scripts/lib/core";

const flaconIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "../packages/proof/src/idl/flacon.json"), "utf8"));

const VECTORS_PK = "8ddafff75fe35b174d24fca867f796bc253e32363a456f3486214f01c457ee01";
const REAL_PK = "ab".repeat(32);
const DEVNET = "https://api.devnet.solana.com";
const LOCAL = "http://127.0.0.1:8899";
const derive = (seed: string) => (seed === "11".repeat(32) ? VECTORS_PK : "cd".repeat(32));

describe("ops scripts", () => {
  it("seed-devnet: the server key must be chosen explicitly; the public test key only on a local validator", () => {
    const choose = (argv: string[], url = DEVNET, envSeedHex: string | null = null) => chooseServerKey({ argv, url, envSeedHex, vectorsPubkeyHex: VECTORS_PK, derive });
    expect(() => choose([])).to.throw(/explicitly/);
    expect(() => choose(["--test-key"])).to.throw(/local validator/);
    expect(choose(["--test-key"], LOCAL).hex).to.equal(VECTORS_PK);
    expect(choose(["--server-pubkey", REAL_PK]).hex).to.equal(REAL_PK);
    expect(choose(["--server-pubkey", REAL_PK.toUpperCase()]).hex).to.equal(REAL_PK);
    expect(() => choose(["--server-pubkey", "abc"])).to.throw(/32 bytes/);
    expect(() => choose(["--server-pubkey", VECTORS_PK])).to.throw(/public/);
    expect(() => choose(["--server-pubkey", REAL_PK, "--test-key"], LOCAL)).to.throw(/only one/);
    expect(choose(["--server-pubkey-from-env"], DEVNET, "22".repeat(32)).hex).to.equal("cd".repeat(32));
    expect(() => choose(["--server-pubkey-from-env"], DEVNET, null)).to.throw(/FV_SERVER_ED25519_SEED/);
    expect(() => choose(["--server-pubkey-from-env"], DEVNET, "11".repeat(32))).to.throw(/public test seed/);
    expect(choose(["--server-pubkey-from-env"], LOCAL, "11".repeat(32)).hex).to.equal(VECTORS_PK);
  });

  it("isLocalUrl", () => {
    for (const u of ["http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899/"]) expect(isLocalUrl(u), u).to.be.true;
    for (const u of [DEVNET, "http://127.0.0.1.evil.example", "https://localhost.example.com"]) expect(isLocalUrl(u), u).to.be.false;
  });

  it("bind-chip: every argument is validated before anything is sent", () => {
    const asset = Keypair.generate().publicKey.toBase58();
    const ok = parseBindChipArgs([" SN-2026-000010 ", "04aabbccddeeff", "Roja", "Haute Luxe", "4A12", asset]);
    expect(ok.serial).to.equal("SN-2026-000010");
    expect(ok.uid).to.equal("04AABBCCDDEEFF");
    expect(ok.kind).to.equal(1);
    expect((ok.asset as PublicKey).toBase58()).to.equal(asset);
    expect(parseBindChipArgs(["SN-1x", "04AABBCCDDEEFF", "B", "N", "", "new", "0", "http://127.0.0.1:8787/"]).verify).to.equal("http://127.0.0.1:8787");
    const bad: [string[], RegExp][] = [
      [["SN 1", "04AABBCCDDEEFF", "B", "N", "", "new"], /invalid serial/],
      [["SN/1", "04AABBCCDDEEFF", "B", "N", "", "new"], /invalid serial/],
      [["SN-1x", "04AABB", "B", "N", "", "new"], /invalid uid/],
      [["SN-1x", "04AABBCCDDEEFF", "", "N", "", "new"], /brand and name/],
      [["SN-1x", "04AABBCCDDEEFF", "B", "N"], /batch is required/],
      [["SN-1x", "04AABBCCDDEEFF", "B", "N", ""], /Core asset is required/],
      [["SN-1x", "04AABBCCDDEEFF", "B", "N", "", "not-a-key"], /invalid Core asset/],
      [["SN-1x", "04AABBCCDDEEFF", "B", "N", "", "new", "2"], /kind must be/],
    ];
    for (const [argv, re] of bad) expect(() => parseBindChipArgs(argv), argv.join(" ")).to.throw(re);
  });

  it("server-key: add / revoke / list arguments", () => {
    expect(parseServerKeyArgs(["add", REAL_PK, "2"])).to.deep.equal({ cmd: "add", pubkeyHex: REAL_PK, keyId: 2, validFrom: 0, validTo: 0 });
    expect(parseServerKeyArgs(["add", REAL_PK, "3", "--valid-from", "100", "--valid-to", "200"])).to.deep.include({ validFrom: 100, validTo: 200 });
    expect(parseServerKeyArgs(["revoke", "1"])).to.deep.equal({ cmd: "revoke", keyId: 1 });
    expect(parseServerKeyArgs(["list"])).to.deep.equal({ cmd: "list" });
    expect(() => parseServerKeyArgs(["add", "zz", "2"])).to.throw(/32 bytes/);
    expect(() => parseServerKeyArgs(["add", REAL_PK, "256"])).to.throw(/keyId/);
    expect(() => parseServerKeyArgs(["add", REAL_PK, "2", "--valid-from", "200", "--valid-to", "100"])).to.throw(/valid-to/);
    expect(() => parseServerKeyArgs(["revoke"])).to.throw(/keyId/);
    expect(() => parseServerKeyArgs(["rotate"])).to.throw(/usage/);
  });

  it("partner: add / remove / list arguments", () => {
    const pk = Keypair.generate().publicKey;
    const add = parsePartnerArgs(["add", pk.toBase58()]);
    expect(add.cmd).to.equal("add");
    expect((add as { partner: PublicKey }).partner.equals(pk)).to.be.true;
    expect(parsePartnerArgs(["remove", pk.toBase58()]).cmd).to.equal("remove");
    expect(parsePartnerArgs(["list"]).cmd).to.equal("list");
    expect(() => parsePartnerArgs(["remove", "nope"])).to.throw(/invalid pubkey/);
    expect(() => parsePartnerArgs([])).to.throw(/usage/);
  });

  it("core: CreateV1 instruction layout and AssetV1 parsing", () => {
    const asset = Keypair.generate().publicKey, payer = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
    const ix = createCoreAssetIx({ asset, payer, owner, name: "Bottle", uri: "https://x.test/a" });
    expect(ix.programId.equals(MPL_CORE_PROGRAM_ID)).to.be.true;
    expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
      asset, MPL_CORE_PROGRAM_ID, MPL_CORE_PROGRAM_ID, payer, owner, MPL_CORE_PROGRAM_ID, SystemProgram.programId, MPL_CORE_PROGRAM_ID,
    ].map((k) => k.toBase58()));
    expect(ix.keys[0].isSigner && ix.keys[0].isWritable && ix.keys[3].isSigner).to.be.true;
    // [0 CreateV1, 0 AccountState, u32 6 "Bottle", u32 16 uri, 0 plugins: None]
    expect(ix.data.toString("hex")).to.equal("0000" + "06000000" + Buffer.from("Bottle").toString("hex") + "10000000" + Buffer.from("https://x.test/a").toString("hex") + "00");

    const data = Buffer.concat([Buffer.from([1]), owner.toBuffer(), Buffer.from([1]), Keypair.generate().publicKey.toBuffer()]);
    expect(parseCoreAsset({ owner: MPL_CORE_PROGRAM_ID, data })!.owner.equals(owner)).to.be.true;
    expect(parseCoreAsset({ owner: MPL_CORE_PROGRAM_ID, data })!.inCollection).to.be.false;
    const inCollection = Buffer.from(data); inCollection[33] = 2;
    expect(parseCoreAsset({ owner: MPL_CORE_PROGRAM_ID, data: inCollection })!.inCollection).to.be.true;
    expect(parseCoreAsset({ owner: SystemProgram.programId, data })).to.equal(null);
    const collection = Buffer.from(data); collection[0] = 5;
    expect(parseCoreAsset({ owner: MPL_CORE_PROGRAM_ID, data: collection })).to.equal(null);
    expect(parseCoreAsset(null)).to.equal(null);
  });

  it("seed-devnet --key-id and the server key plan after a rotation (S19)", () => {
    expect(parseKeyIdFlag([])).to.equal(1);
    expect(parseKeyIdFlag(["--server-pubkey", REAL_PK, "--key-id", "2"])).to.equal(2);
    for (const bad of [["--key-id"], ["--key-id", "256"], ["--key-id", "x"]]) expect(() => parseKeyIdFlag(bad)).to.throw(/key-id/);

    const NOW = 2_000_000_000;
    const OLD = "11".repeat(32), NEW = "22".repeat(32), OTHER = "33".repeat(32);
    const k = (keyId: number, pubkeyHex: string, validTo = 0, validFrom = 0): RegistryKey => ({ keyId, pubkeyHex, validFrom, validTo });
    expect(keyStatus(k(1, OLD), NOW)).to.equal("valid");
    expect(keyStatus(k(1, OLD, NOW - 1), NOW)).to.equal("revoked or expired");
    expect(keyStatus(k(1, OLD, NOW), NOW)).to.equal("valid");
    expect(keyStatus(k(1, OLD, 0, NOW + 5), NOW)).to.equal("not yet valid");

    // fresh registry: the key goes to the asked id
    expect(planServerKey([], NEW, 1, NOW)).to.deep.include({ action: "add", keyId: 1 });
    expect(planServerKey([], NEW, 4, NOW)).to.deep.include({ action: "add", keyId: 4 });
    // re-run with the same key
    expect(planServerKey([k(1, NEW)], NEW, 1, NOW)).to.deep.include({ action: "skip", keyId: 1 });
    // the documented rotation: revoke 1, add the new key as 2 — re-running with the new key just continues and says so
    const rotated = [k(1, OLD, NOW - 100), k(2, NEW)];
    const skip = planServerKey(rotated, NEW, 1, NOW);
    expect(skip).to.deep.include({ action: "skip", keyId: 2 });
    expect(skip.note).to.match(/key_id 2 \[valid\]/).and.to.match(/key_id 1 \[revoked or expired\]/);
    expect(planServerKey(rotated, NEW.toUpperCase(), 2, NOW)).to.deep.include({ action: "skip", keyId: 2 });
    // key 1 revoked, the new key not registered yet: it goes to the next free id, never over the revoked one
    expect(planServerKey([k(1, OLD, NOW - 100)], NEW, 1, NOW)).to.deep.include({ action: "add", keyId: 2 });
    expect(planServerKey([k(1, OLD, NOW - 100), k(2, OTHER, NOW - 50)], NEW, 1, NOW)).to.deep.include({ action: "add", keyId: 3 });
    // key 1 still valid with another key: refuse, with rotation steps that work (add first, revoke last)
    expect(() => planServerKey([k(1, OLD)], NEW, 1, NOW)).to.throw(/server-key\.ts add 2+ 2[\s\S]*revoke 1/);
    // the old key itself after its revocation: cannot come back
    expect(() => planServerKey([k(1, OLD, NOW - 100)], OLD, 1, NOW)).to.throw(/revoked key stays revoked/);
    // a full registry
    const full = Array.from({ length: 8 }, (_, i) => k(i + 1, (i + 40).toString(16).padStart(2, "0").repeat(32), NOW - 1));
    expect(() => planServerKey(full, NEW, 1, NOW)).to.throw(/maximum/);
  });

  it("seed-passports attaches every seal before it marks a dead one", () => {
    const plan = sealSeedPlan([{ uid: "04000000000001", kind: 1, dead: true }, { uid: "04000000000002", kind: 0 }]);
    expect(plan).to.deep.equal([
      { op: "attach", uid: "04000000000001", kind: 1 },
      { op: "attach", uid: "04000000000002", kind: 0 },
      { op: "markDead", uid: "04000000000001" },
    ]);
    expect(sealSeedPlan([{ uid: "04000000000003", kind: 1 }])).to.deep.equal([{ op: "attach", uid: "04000000000003", kind: 1 }]);
  });

  it("bind-chip refuses a Core asset of another owner, or one that already backs a passport", () => {
    const asset = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
    expect(existingAssetProblem({ asset, core: { owner: wallet }, wallet, usedBy: [] })).to.equal(null);
    expect(existingAssetProblem({ asset, core: null, wallet, usedBy: [] })).to.match(/not a Metaplex Core asset/);
    expect(existingAssetProblem({ asset, core: { owner: other }, wallet, usedBy: [] })).to.match(new RegExp(`belongs to ${other.toBase58()}`));
    expect(existingAssetProblem({ asset, core: { owner: wallet }, wallet, usedBy: [other] })).to.match(/already backs passport/);
    // Passport.asset sits after the discriminator, serial_hash and binding_hash (programs/flacon/src/state.rs)
    expect(PASSPORT_ASSET_OFFSET).to.equal(72);
    const disc = flaconIdl.accounts.find((a: any) => a.name === "Passport").discriminator;
    expect(bs58encode(Uint8Array.from(disc))).to.be.a("string").with.length.greaterThan(5);
    const pk = Keypair.generate().publicKey;
    expect(bs58encode(pk.toBytes())).to.equal(pk.toBase58());
    expect(bs58encode(Uint8Array.from([0, 0, 1]))).to.equal("112");
  });

  it("creatingSignature only accepts the creating instruction, with the account at its IDL position, signed by the wallet", () => {
    const programId = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey, stranger = Keypair.generate().publicKey;
    const passport = Keypair.generate().publicKey;
    const e = expectationFromIdl(flaconIdl, programId, "mint_passport", "passport", wallet);
    expect(e.accountIndex).to.equal(1);
    expect(e.discriminator).to.deep.equal(flaconIdl.instructions.find((i: any) => i.name === "mint_passport").discriminator);
    expect(expectationFromIdl(flaconIdl, programId, "attach_seal", "seal").accountIndex).to.equal(2);
    expect(() => expectationFromIdl(flaconIdl, programId, "nope", "passport")).to.throw(/not in the IDL/);
    const recordScan = flaconIdl.instructions.find((i: any) => i.name === "record_scan").discriminator;
    const tx = (o: { payer?: PublicKey; data?: number[]; accounts?: PublicKey[]; err?: unknown }): VersionedTransactionResponse => {
      const payer = o.payer ?? wallet;
      const keys = (o.accounts ?? [Keypair.generate().publicKey, passport, payer]).map((pubkey) => ({ pubkey, isSigner: pubkey.equals(payer), isWritable: true }));
      const ix = new TransactionInstruction({ programId, keys, data: Buffer.from([...(o.data ?? e.discriminator), 9, 9]) });
      const message = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
      return { transaction: new VersionedTransaction(message), meta: { err: o.err ?? null, loadedAddresses: { writable: [], readonly: [] } } } as unknown as VersionedTransactionResponse;
    };
    expect(txCreatesAccount(tx({}), passport, e)).to.be.true;
    expect(txCreatesAccount(null, passport, e)).to.be.false;
    expect(txCreatesAccount(tx({ err: { InstructionError: [0, "Custom"] } }), passport, e), "failed").to.be.false;
    // a record_scan by anyone that carries the predictable passport PDA (M10-style poisoning)
    expect(txCreatesAccount(tx({ data: recordScan }), passport, e), "other instruction").to.be.false;
    expect(txCreatesAccount(tx({ payer: stranger, accounts: [Keypair.generate().publicKey, passport, stranger] }), passport, e), "other signer").to.be.false;
    expect(txCreatesAccount(tx({ accounts: [passport, Keypair.generate().publicKey, wallet] }), passport, e), "wrong position").to.be.false;
  });

  it("core: TransferV1 and BurnV1 instruction layouts (match programs/escrow/src/mpl_core.rs)", () => {
    const asset = Keypair.generate().publicKey, payer = Keypair.generate().publicKey, owner = Keypair.generate().publicKey, to = Keypair.generate().publicKey;
    const t = transferCoreAssetIx({ asset, payer, owner, newOwner: to });
    expect(t.data.toString("hex")).to.equal("0e00");
    expect(t.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([asset, MPL_CORE_PROGRAM_ID, payer, owner, to, SystemProgram.programId, MPL_CORE_PROGRAM_ID].map((k) => k.toBase58()));
    expect(t.keys[0].isWritable && t.keys[2].isSigner && t.keys[3].isSigner && !t.keys[4].isSigner).to.be.true;
    const b = burnCoreAssetIx({ asset, payer, owner });
    expect(b.data.toString("hex")).to.equal("0c00");
    expect(b.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([asset, MPL_CORE_PROGRAM_ID, payer, owner, SystemProgram.programId, MPL_CORE_PROGRAM_ID].map((k) => k.toBase58()));
  });
});
