import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { SCAN_PROOF_DISCRIMINATOR, anchorDiscriminator, creatingSignature, scanProofAttester, txCreates } from "./send-tx";

const idl = JSON.parse(readFileSync(new URL("../../../../packages/proof/src/idl/flacon.json", import.meta.url), "utf8")) as {
  instructions: Array<{ name: string; discriminator: number[] }>; accounts: Array<{ name: string; discriminator: number[] }>;
};
const PROGRAM = new PublicKey(Keypair.generate().publicKey);
const target = Keypair.generate().publicKey;
const me = Keypair.generate().publicKey;
const someoneElse = Keypair.generate().publicKey;

test("discriminators match the flacon IDL", async () => {
  for (const name of ["record_scan", "mint_passport", "attach_seal"]) {
    assert.deepEqual(Array.from(await anchorDiscriminator(name)), idl.instructions.find((i) => i.name === name)!.discriminator, name);
  }
  assert.deepEqual(Array.from(SCAN_PROOF_DISCRIMINATOR), idl.accounts.find((a) => a.name === "ScanProof")!.discriminator);
});

function scanProofData(attester: PublicKey): Uint8Array {
  const d = new Uint8Array(160);
  d.set(SCAN_PROOF_DISCRIMINATOR, 0);
  d.set(attester.toBytes(), 8 + 32 + 4 + 8 + 2 + 32 + 32);
  return d;
}

test("only a real ScanProof counts as anchored (M10)", () => {
  assert.ok(scanProofAttester({ owner: PROGRAM, data: scanProofData(me) }, PROGRAM)?.equals(me));
  // someone pre-funded the address with a SOL transfer: system-owned, no data
  assert.equal(scanProofAttester({ owner: SystemProgram.programId, data: new Uint8Array(0) }, PROGRAM), null);
  assert.equal(scanProofAttester({ owner: PROGRAM, data: new Uint8Array(0) }, PROGRAM), null);
  const foreign = scanProofData(me); foreign[0] ^= 0xff;
  assert.equal(scanProofAttester({ owner: PROGRAM, data: foreign }, PROGRAM), null);
  assert.equal(scanProofAttester(null, PROGRAM), null);
});

async function txResponse(o: { payer: PublicKey; ixs: TransactionInstruction[]; err?: unknown }): Promise<VersionedTransactionResponse> {
  const message = new TransactionMessage({ payerKey: o.payer, recentBlockhash: "11111111111111111111111111111111", instructions: o.ixs }).compileToV0Message();
  return { slot: 1, blockTime: 1, transaction: { message, signatures: ["x"] }, meta: { err: o.err ?? null, fee: 5000, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] } } } as unknown as VersionedTransactionResponse;
}
const recordScanIx = async (signer: PublicKey) => new TransactionInstruction({
  programId: PROGRAM, keys: [{ pubkey: target, isSigner: false, isWritable: true }, { pubkey: signer, isSigner: true, isWritable: true }],
  data: Buffer.concat([Buffer.from(await anchorDiscriminator("record_scan")), Buffer.alloc(8)]),
});
const transferIx = (from: PublicKey) => SystemProgram.transfer({ fromPubkey: from, toPubkey: target, lamports: 1 });

test("txCreates wants the program, the instruction, the account and the signer", async () => {
  const disc = [await anchorDiscriminator("record_scan")];
  assert.equal(txCreates(await txResponse({ payer: me, ixs: [await recordScanIx(me)] }), target, PROGRAM, disc, me), true);
  assert.equal(txCreates(await txResponse({ payer: someoneElse, ixs: [transferIx(someoneElse)] }), target, PROGRAM, disc), false, "a transfer is not a creation");
  assert.equal(txCreates(await txResponse({ payer: someoneElse, ixs: [await recordScanIx(someoneElse)] }), target, PROGRAM, disc, me), false, "not this wallet's");
  assert.equal(txCreates(await txResponse({ payer: me, ixs: [await recordScanIx(me)] }), target, PROGRAM, [await anchorDiscriminator("mint_passport")]), false, "wrong instruction");
  assert.equal(txCreates(await txResponse({ payer: me, ixs: [await recordScanIx(me)], err: { InstructionError: [0, "x"] } }), target, PROGRAM, disc), false, "failed tx");
});

/** Fake RPC: `sigs` newest first. */
function fakeConnection(sigs: Array<{ signature: string; err?: unknown }>, txs: Record<string, VersionedTransactionResponse>) {
  let txCalls = 0;
  const conn = {
    async getSignaturesForAddress(_a: PublicKey, o: { limit: number; before?: string }) {
      const start = o.before ? sigs.findIndex((s) => s.signature === o.before) + 1 : 0;
      return sigs.slice(start, start + o.limit).map((s) => ({ signature: s.signature, err: s.err ?? null, slot: 1, blockTime: 1, memo: null }));
    },
    async getTransaction(sig: string) { txCalls++; return txs[sig] ?? null; },
  };
  return { conn: conn as unknown as Connection, calls: () => txCalls };
}

test("creatingSignature skips a pre-funding transfer and returns this wallet's record_scan", async () => {
  const txs = { create: await txResponse({ payer: me, ixs: [await recordScanIx(me)] }), fund: await txResponse({ payer: someoneElse, ixs: [transferIx(someoneElse)] }) };
  const { conn } = fakeConnection([{ signature: "later" }, { signature: "create" }, { signature: "fund" }], txs); // fund is the oldest
  assert.equal(await creatingSignature(conn, target, { programId: PROGRAM, instruction: "record_scan", signer: me }), "create");
  assert.equal(await creatingSignature(conn, target, { programId: PROGRAM, instruction: "record_scan", signer: someoneElse }), null);
});

test("creatingSignature returns null when the 1000-signature window is exhausted", async () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}` }));
  const txs = { s999: await txResponse({ payer: me, ixs: [await recordScanIx(me)] }) };
  const { conn, calls } = fakeConnection(many, txs);
  assert.equal(await creatingSignature(conn, target, { programId: PROGRAM }), null, "the creating tx may lie beyond the window");
  assert.equal(calls(), 0);
  // 999 signatures: the history ends inside the window, the oldest one is the creating transaction
  const { conn: c2 } = fakeConnection(many.slice(0, 999), { s998: await txResponse({ payer: me, ixs: [await recordScanIx(me)] }) });
  assert.equal(await creatingSignature(c2, target, { programId: PROGRAM }), "s998");
});

test("creatingSignature ignores failed signatures", async () => {
  const txs = { ok: await txResponse({ payer: me, ixs: [await recordScanIx(me)] }) };
  const { conn } = fakeConnection([{ signature: "ok" }, { signature: "bad", err: { InstructionError: [0, "x"] } }], txs);
  assert.equal(await creatingSignature(conn, target, { programId: PROGRAM, instruction: "record_scan" }), "ok");
});
