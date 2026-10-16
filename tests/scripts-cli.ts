/**
 * Unit tests for the ops-script helpers (scripts/lib/cli.ts, scripts/lib/core.ts). No validator needed:
 *   NODE_OPTIONS=--no-experimental-strip-types npx ts-mocha -p ./tsconfig.json tests/scripts-cli.ts
 * (also runs as part of `anchor test`).
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import {
  chooseServerKey,
  isLocalUrl,
  parseBindChipArgs,
  parsePartnerArgs,
  parseServerKeyArgs,
} from "../scripts/lib/cli";
import { MPL_CORE_PROGRAM_ID, createCoreAssetIx, parseCoreAsset } from "../scripts/lib/core";

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
});
