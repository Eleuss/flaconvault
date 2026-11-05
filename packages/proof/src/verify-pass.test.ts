/**
 * verify-pass against a fake RPC built from docs/vectors.json `v2` (no network): a complete history matches; a
 * missing or reordered transaction does not; forged entries (wrong cluster, wrong program id, unknown key, key not
 * valid at ts, bad signature) are not counted; record_scan_v2 inside a CPI is ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  Cluster, Grade, HoldingState, base58Decode, base58Encode, buildEd25519InstructionData, buildScanMessageV2,
  parseScanMessageV2, anchorDiscriminator, decodeHolding, decodePassport, decodeRegistry, ed25519Sign, ed25519PublicKey,
  foldScanHeads, hexToBytes, bytesToHex, i64le, u16le, u32le, concatBytes, sha256Bytes, utf8, serialHash, pdaHolding,
  pdaPassport, pdaRegistry, pdaSeal, verifyPass, formatVerifyPass, jsonRpcPassClient, READ_ONLY_RPC_METHODS,
  RECORD_SCAN_V2_ACCOUNTS, RECORD_SCAN_V2_DISCRIMINATOR, VERDICT_COMPLETE, VerifyPassError, RpcError, ED25519_PROGRAM_ID,
  type PassRpc, type RpcAccountInfo, type RpcSignatureInfo, type RpcTransaction, type ScanMessageV2Fields,
} from "./index.ts";

const execFileAsync = promisify(execFile);
const vectors = JSON.parse(readFileSync(new URL("../../../docs/vectors.json", import.meta.url), "utf8"));
const v2 = vectors.v2;
const PROGRAM = v2.programId as string;
const SERIAL = v2.scans[0].input.serial as string;
const serverSeed = hexToBytes(vectors.serverTestKey.seedHex);
const serverPub = hexToBytes(vectors.serverTestKey.pubkeyHex);
const KEY_ID = vectors.serverTestKey.keyId as number;
const passport = base58Encode(pdaPassport(serialHash(SERIAL), PROGRAM).address);
const holding = base58Encode(pdaHolding(passport, PROGRAM).address);
const registry = base58Encode(pdaRegistry(PROGRAM).address);
const msgs: Uint8Array[] = v2.scans.map((s: { msgHex: string }) => hexToBytes(s.msgHex));

// ---- account bytes, written at the offsets of docs/public-record.md §6 and state.rs (independent of accounts.ts)

function account(name: string, size: number, fields: [number, Uint8Array][]): Uint8Array {
  const d = new Uint8Array(size);
  d.set(anchorDiscriminator("account", name), 0);
  for (const [off, b] of fields) d.set(b, off);
  return d;
}
const one = (n: number) => new Uint8Array([n]);
function holdingData(head: Uint8Array, count: number): Uint8Array {
  return account("Holding", 229, [
    [8, base58Decode(passport)], [40, one(HoldingState.ACCOUNT)], [41, u32le(0)], [45, hexToBytes(v2.commitments[0].commitmentHex)],
    [77, head], [109, u32le(count)], [113, one(2)], [114, hexToBytes(v2.actors.wallet.pubkeyHex)], [146, one(1)],
    [147, i64le(1790000600)], [155, one(0)], [188, i64le(0)], [196, one(254)],
  ]);
}
function passportData(scanCount: number): Uint8Array {
  return account("Passport", 152, [
    [8, serialHash(SERIAL)], [40, sha256Bytes(utf8("binding"))], [72, base58Decode(holding)], [104, hexToBytes(v2.actors.partner.pubkeyHex)],
    [136, one(Grade.C)], [137, u32le(scanCount)], [141, one(1)], [142, one(0)], [143, i64le(1790000000)], [151, one(255)],
  ]);
}
function registryData(keys: { keyId: number; pubkey: Uint8Array; from: number; to: number }[]): Uint8Array {
  const body = concatBytes(
    sha256Bytes(utf8("authority")),
    u32le(keys.length), ...keys.map((k) => concatBytes(one(k.keyId), k.pubkey, i64le(k.from), i64le(k.to))),
    u32le(1), hexToBytes(v2.actors.partner.pubkeyHex),
    u32le(1), u16le(1), new Uint8Array(32),
    one(253),
  );
  return concatBytes(anchorDiscriminator("account", "Registry"), body);
}
const testKey = { keyId: KEY_ID, pubkey: serverPub, from: 0, to: 0 };

// ---- transactions shaped like getTransaction(…, {encoding: "json"})

const FEE_PAYER = base58Encode(ed25519PublicKey(sha256Bytes(utf8("fake-relayer"))));
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111";
let sigCounter = 0;
function txSig(): string { return base58Encode(sha256Bytes(utf8(`sig-${++sigCounter}`))) + "Q"; }

interface ScanTx { msg: Uint8Array; sig?: Uint8Array; keyId?: number; slot: number; inner?: boolean; sealOverride?: string }
function scanTx(t: ScanTx): RpcTransaction {
  const m = parseScanMessageV2(t.msg);
  const seal = t.sealOverride ?? base58Encode(pdaSeal(m.uidHash, PROGRAM).address);
  // static keys: payer, writable passport/seal/holding, then read-only accounts and programs
  const accountKeys = [FEE_PAYER, passport, seal, holding, registry, "holderConfig1111111111111111111111111111111", SYSVAR_IX,
    "eventAuthority11111111111111111111111111111", COMPUTE_BUDGET, ED25519_PROGRAM_ID, PROGRAM];
  const idx = (k: string) => accountKeys.indexOf(k);
  const sig = t.sig ?? ed25519Sign(t.msg, serverSeed);
  const ed = { programIdIndex: idx(ED25519_PROGRAM_ID), accounts: [], data: base58Encode(buildEd25519InstructionData(serverPub, sig, t.msg)) };
  const record = {
    programIdIndex: idx(PROGRAM),
    accounts: [idx(registry), 5, idx(passport), idx(seal), idx(holding), idx(SYSVAR_IX), idx(PROGRAM), idx(PROGRAM), 7, idx(PROGRAM)],
    data: base58Encode(concatBytes(RECORD_SCAN_V2_DISCRIMINATOR, one(t.keyId ?? KEY_ID))),
  };
  const budget = [
    { programIdIndex: idx(COMPUTE_BUDGET), accounts: [], data: base58Encode(concatBytes(one(2), u32le(150000))) },
    { programIdIndex: idx(COMPUTE_BUDGET), accounts: [], data: base58Encode(concatBytes(one(3), new Uint8Array(8))) },
  ];
  const signature = txSig();
  if (t.inner) {
    // a wrapper program at the top level that CPIs into record_scan_v2: the inner instruction must not count
    const wrapper = { programIdIndex: idx(COMPUTE_BUDGET), accounts: record.accounts, data: record.data };
    return { slot: t.slot, meta: { err: null, innerInstructions: [{ index: 3, instructions: [record] }] },
      transaction: { signatures: [signature], message: { accountKeys, instructions: [...budget, ed, wrapper] } } };
  }
  return { slot: t.slot, blockTime: Number(m.ts), meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [signature], message: { accountKeys, instructions: [...budget, ed, record] } } };
}

interface Chain {
  txs: RpcTransaction[]; // oldest first
  failed?: Set<number>;  // indexes listed with err != null
  head?: Uint8Array; count?: number; scanCount?: number;
  keys?: typeof testKey[];
  holdingReads?: Uint8Array[]; // successive Holding reads (the last one repeats)
  missingTx?: Set<string>;
  noHolding?: boolean; noPassport?: boolean; passportOwner?: string;
}
function fakeRpc(c: Chain): PassRpc & { calls: string[] } {
  const calls: string[] = [];
  const head = c.head ?? foldScanHeads(msgs), count = c.count ?? msgs.length;
  const accounts = new Map<string, RpcAccountInfo>([
    [registry, { owner: PROGRAM, data: registryData(c.keys ?? [testKey]) }],
  ]);
  if (!c.noPassport) accounts.set(passport, { owner: c.passportOwner ?? PROGRAM, data: passportData(c.scanCount ?? count + 2) });
  let holdingRead = 0;
  // newest first, as the RPC lists them
  const listed: RpcSignatureInfo[] = c.txs.map((tx, i) => ({
    signature: tx.transaction.signatures[0], slot: tx.slot, err: c.failed?.has(i) ? { InstructionError: [3, { Custom: 6012 }] } : null,
  })).reverse();
  const bySig = new Map(c.txs.map((tx) => [tx.transaction.signatures[0], tx]));
  return {
    calls,
    async getAccountInfo(address) {
      calls.push(`getAccountInfo ${address}`);
      if (address === holding) {
        if (c.noHolding) return null;
        const reads = c.holdingReads ?? [holdingData(head, count)];
        return { owner: PROGRAM, data: reads[Math.min(holdingRead++, reads.length - 1)] };
      }
      return accounts.get(address) ?? null;
    },
    async getSignaturesForAddress(address, o) {
      calls.push(`getSignaturesForAddress ${address} ${o.before ?? "-"} ${o.limit}`);
      if (address !== holding) return [];
      const start = o.before ? listed.findIndex((s) => s.signature === o.before) + 1 : 0;
      return listed.slice(start, start + o.limit);
    },
    async getTransaction(signature) {
      calls.push(`getTransaction ${signature}`);
      if (c.missingTx?.has(signature)) return null;
      return bySig.get(signature) ?? null;
    },
  };
}
const history = () => msgs.map((msg, i) => scanTx({ msg, slot: 1000 + i * 10 }));
const run = (rpc: PassRpc, clusterTag: number = Cluster.DEVNET, pageLimit?: number) =>
  verifyPass(rpc, { programId: PROGRAM, clusterTag, serial: SERIAL, pageLimit });

/** A message like v2.scans[i] with some fields changed, re-signed by the test key (a forgery the chain never folded). */
function variant(i: number, change: Partial<ScanMessageV2Fields>): Uint8Array {
  return buildScanMessageV2({ ...parseScanMessageV2(msgs[i]), ...change });
}

test("account decoders read the spec offsets", () => {
  const h = decodeHolding(holdingData(foldScanHeads(msgs), 6));
  assert.equal(base58Encode(h.passport), passport);
  assert.equal(h.headCount, 6);
  assert.equal(bytesToHex(h.scanHead), v2.scanHead.finalHex);
  assert.equal(bytesToHex(h.commitment), v2.commitments[0].commitmentHex);
  assert.deepEqual([h.lastActorKind, h.lastPurpose, h.lastScanTs, h.bump], [2, 1, 1790000600n, 254]);
  const p = decodePassport(passportData(9));
  assert.deepEqual([p.grade, p.scanCount, p.sealCount, p.void, p.createdAt, p.bump], [Grade.C, 9, 1, false, 1790000000n, 255]);
  assert.equal(base58Encode(p.asset), holding);
  const r = decodeRegistry(registryData([testKey, { keyId: 2, pubkey: new Uint8Array(32).fill(7), from: 5, to: 6 }]));
  assert.deepEqual(r.serverKeys.map((k) => [k.keyId, k.validFrom, k.validTo]), [[1, 0n, 0n], [2, 5n, 6n]]);
  assert.equal(r.partners.length, 1);
  assert.deepEqual([r.sites[0].siteId, r.bump], [1, 253]);
  assert.throws(() => decodeHolding(passportData(1)), /discriminator|bytes/);
  assert.throws(() => decodeHolding(holdingData(new Uint8Array(32), 0).slice(0, 200)), /200 bytes/);
});

test("complete history: match, oldest first, every field reported", async () => {
  const r = await run(fakeRpc({ txs: history() }));
  assert.equal(r.complete, true);
  assert.equal(r.verdict, VERDICT_COMPLETE);
  assert.equal(r.verdict, "complete and in order");
  assert.deepEqual([r.found, r.holdingHeadCount, r.transactions, r.rejected.length], [6, 6, 6, 0]);
  assert.equal(r.computedHeadHex, v2.scanHead.finalHex);
  assert.deepEqual(r.scans.map((s) => s.counter), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.scans.map((s) => s.purpose), ["BIRTH", "TAP", "CHECK", "CHECK", "RECEIPT", "CHECK"]);
  assert.deepEqual(r.scans.map((s) => s.actorKind), ["PARTNER", "NONE", "NONE", "HOLDER", "RECIPIENT", "WALLET"]);
  assert.deepEqual(r.scans.map((s) => s.msgSha256Hex), v2.scans.map((s: { msgSha256Hex: string }) => s.msgSha256Hex));
  assert.equal(r.scans[0].seal, v2.pdas.seal);
  assert.deepEqual([r.passport, r.holding, r.heldInAccount, r.cluster], [v2.pdas.passport, v2.pdas.holding, true, "DEVNET"]);
  const text = formatVerifyPass(r);
  assert.match(text, /Verdict: complete and in order$/);
  assert.match(text, /counter 2 +TAP +NONE/);
  assert.match(text, /v1 scans \(ScanProof accounts\) are not covered: 2 of the passport's 8\./);
});

test("pagination with `before` and same-slot ordering", async () => {
  const paged = fakeRpc({ txs: history() });
  assert.equal((await run(paged, Cluster.DEVNET, 2)).complete, true);
  assert.equal(paged.calls.filter((c) => c.startsWith("getSignaturesForAddress")).length, 4, "3 full pages + 1 empty");
  // all in one slot: the RPC lists newest first, verify-pass reverses within the slot
  const sameSlot = msgs.map((msg) => scanTx({ msg, slot: 5000 }));
  assert.equal((await run(fakeRpc({ txs: sameSlot }))).complete, true);
});

test("a missing transaction → incomplete", async () => {
  const txs = history();
  txs.splice(2, 1);
  const r = await run(fakeRpc({ txs }));
  assert.equal(r.complete, false);
  assert.equal(r.verdict, "incomplete or out of order (found 5, holding says 6)");
  // a failed transaction is not part of the history either
  const r2 = await run(fakeRpc({ txs: history(), failed: new Set([4]) }));
  assert.deepEqual([r2.complete, r2.found, r2.transactions], [false, 5, 5]);
});

test("swapped order → mismatch", async () => {
  const txs = history();
  [txs[2].slot, txs[3].slot] = [txs[3].slot, txs[2].slot];
  const r = await run(fakeRpc({ txs }));
  assert.deepEqual([r.complete, r.found], [false, 6]);
  assert.equal(r.verdict, "incomplete or out of order (found 6, holding says 6)");
  assert.deepEqual(r.scans.map((s) => s.counter), [1, 2, 4, 3, 5, 6]);
});

test("forged entries are not counted; the folded history still matches", async () => {
  const forged = [
    { msg: variant(2, { clusterTag: Cluster.MAINNET }), reason: /cluster MAINNET, not DEVNET/ },
    { msg: variant(2, { programId: sha256Bytes(utf8("other program")) }), reason: /another program id/ },
    { msg: variant(2, { serialHash: serialHash("SN-2026-000002") }), reason: /another passport/ },
    { msg: msgs[2], keyId: 2, reason: /server key 2 is not in the registry/ },
    { msg: msgs[2], sig: ed25519Sign(msgs[2], sha256Bytes(utf8("not the server key"))), reason: /bad server signature/ },
    { msg: msgs[2], sealOverride: v2.pdas.registry, reason: /seal account/ },
  ];
  for (const f of forged) {
    const txs = history();
    txs.splice(3, 0, scanTx({ ...f, slot: 1025 }));
    const r = await run(fakeRpc({ txs }));
    assert.equal(r.rejected.length, 1, String(f.reason));
    assert.match(r.rejected[0].reason, f.reason);
    assert.equal(r.rejected[0].instruction, 3);
    assert.deepEqual([r.complete, r.found], [true, 6], String(f.reason));
  }
  // a bad signature byte inside an otherwise genuine instruction
  const sig = hexToBytes(v2.scans[1].sigHex); sig[10] ^= 1;
  const txs = history(); txs[1] = scanTx({ msg: msgs[1], sig, slot: txs[1].slot });
  const r = await run(fakeRpc({ txs }));
  assert.deepEqual([r.complete, r.found, r.rejected[0].reason], [false, 5, "bad server signature"]);
});

test("key validity at ts, wrong cluster for every scan", async () => {
  // key 1 expired at 1790000350: the scans at 400, 500 and 600 are not FlaconVault-signed for this record
  const r = await run(fakeRpc({ txs: history(), keys: [{ ...testKey, to: 1790000350 }] }));
  assert.deepEqual([r.complete, r.found], [false, 3]);
  assert.deepEqual(r.rejected.map((x) => x.reason), Array(3).fill("server key 1 was not valid at ts", 0).map((s, i) => `${s} ${1790000400 + i * 100}`));
  const early = await run(fakeRpc({ txs: history(), keys: [{ ...testKey, from: 1790000150 }] }));
  assert.deepEqual([early.complete, early.found], [false, 5]);
  const otherKey = await run(fakeRpc({ txs: history(), keys: [{ ...testKey, pubkey: new Uint8Array(32).fill(9) }] }));
  assert.deepEqual([otherKey.found, otherKey.rejected[0].reason], [0, "server key 1 has another public key"]);
  const mainnet = await run(fakeRpc({ txs: history() }), Cluster.MAINNET);
  assert.deepEqual([mainnet.complete, mainnet.found, mainnet.rejected.length], [false, 0, 6]);
});

test("record_scan_v2 inside a CPI is ignored; only top-level instructions count", async () => {
  const txs = history();
  txs.splice(3, 0, scanTx({ msg: variant(2, { counter: 99 }), slot: 1025, inner: true }));
  const r = await run(fakeRpc({ txs }));
  assert.deepEqual([r.complete, r.found, r.rejected.length, r.transactions], [true, 6, 0, 7]);
});

test("input and RPC errors raise VerifyPassError", async () => {
  await assert.rejects(run(fakeRpc({ txs: history(), noPassport: true })), (e) => e instanceof VerifyPassError && /no passport/.test(e.message));
  await assert.rejects(run(fakeRpc({ txs: history(), noHolding: true })), /no Holding/);
  await assert.rejects(run(fakeRpc({ txs: history(), passportOwner: COMPUTE_BUDGET })), /not owned by program/);
  const txs = history();
  await assert.rejects(run(fakeRpc({ txs, missingTx: new Set([txs[0].transaction.signatures[0]]) })), /not available/);
  await assert.rejects(verifyPass(fakeRpc({ txs }), { programId: "nope", clusterTag: 2, serial: SERIAL }), /not a program id/);
  await assert.rejects(verifyPass(fakeRpc({ txs }), { programId: PROGRAM, clusterTag: 0, serial: SERIAL }), /cluster tag/);
});

test("a Holding that changes while reading is read again", async () => {
  const final = holdingData(foldScanHeads(msgs), 6);
  const before = holdingData(foldScanHeads(msgs.slice(0, 5)), 5);
  const rpc = fakeRpc({ txs: history(), holdingReads: [before, final, final, final] });
  const r = await run(rpc);
  assert.equal(r.complete, true);
  assert.equal(rpc.calls.filter((c) => c === `getAccountInfo ${holding}`).length, 4);
  assert.equal(rpc.calls.filter((c) => c.startsWith("getTransaction")).length, 6, "transactions are fetched once");
  const flapping = fakeRpc({ txs: history(), holdingReads: [before, final, before, final, before, final] });
  await assert.rejects(run(flapping), /changed during 3 reads/);
});

test("record_scan_v2 account positions match the IDL once it has the instruction", () => {
  const idl = JSON.parse(readFileSync(new URL("./idl/flacon.json", import.meta.url), "utf8"));
  const ix = (idl.instructions as { name: string; discriminator: number[]; accounts: { name: string }[] }[])
    .find((i) => i.name === "record_scan_v2");
  if (!ix) return; // the programs group regenerates the IDL after `anchor build`
  assert.deepEqual(ix.discriminator, Array.from(RECORD_SCAN_V2_DISCRIMINATOR));
  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  for (const [name, pos] of Object.entries(RECORD_SCAN_V2_ACCOUNTS)) assert.equal(ix.accounts[pos]?.name, snake(name), name);
});

// ---- JSON-RPC client -----------------------------------------------------------------------------------------

test("jsonRpcPassClient: read-only requests, base64 decode, retries, no URL in errors", async () => {
  const URL_WITH_KEY = "https://rpc.example.test/?api-key=placeholder-key-123";
  const seen: { method: string; params: unknown[] }[] = [];
  let fail429 = 1;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    seen.push(req);
    if (fail429-- > 0) return new Response("slow down", { status: 429 });
    const result = req.method === "getAccountInfo"
      ? { context: { slot: 1 }, value: { owner: PROGRAM, data: [btoa(String.fromCharCode(1, 2, 255)), "base64"], executable: false } }
      : req.method === "getSignaturesForAddress" ? [{ signature: "s", slot: 1, err: null }] : null;
    return Response.json({ jsonrpc: "2.0", id: req.id, result });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const rpc = jsonRpcPassClient(URL_WITH_KEY, { fetch: fakeFetch, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await rpc.getAccountInfo(holding), { owner: PROGRAM, data: new Uint8Array([1, 2, 255]) });
  assert.deepEqual(sleeps, [500]);
  assert.deepEqual(await rpc.getSignaturesForAddress(holding, { limit: 10, before: "x" }), [{ signature: "s", slot: 1, err: null }]);
  assert.equal(await rpc.getTransaction("s"), null);
  assert.ok(seen.every((r) => (READ_ONLY_RPC_METHODS as readonly string[]).includes(r.method)));
  assert.deepEqual(seen.at(-1)!.params, ["s", { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
  assert.deepEqual(seen.at(-2)!.params, [holding, { limit: 10, before: "x", commitment: "finalized" }]);

  const down = jsonRpcPassClient(URL_WITH_KEY, {
    fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, retries: 1, sleep: async () => {},
  });
  await assert.rejects(down.getTransaction("s"), (e) => e instanceof RpcError && !e.message.includes("placeholder-key-123") && /network error/.test(e.message));
  const rpcErr = jsonRpcPassClient(URL_WITH_KEY, {
    fetch: (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } })) as typeof fetch,
  });
  await assert.rejects(rpcErr.getAccountInfo("x"), /RPC error -32602/);
  assert.throws(() => jsonRpcPassClient("ftp://example.test"), /http/);
  assert.throws(() => jsonRpcPassClient("not a url"), (e) => e instanceof RpcError && !e.message.includes("not a url"));
});

// ---- CLI (scripts/verify-pass.ts) against a local JSON-RPC server that serves the fake chain -------------------

async function serveFake(rpc: PassRpc): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    let result: unknown;
    if (method === "getAccountInfo") {
      const a = await rpc.getAccountInfo(params[0]);
      result = { context: { slot: 1 }, value: a && { owner: a.owner, lamports: 1, executable: false, data: [Buffer.from(a.data).toString("base64"), "base64"] } };
    } else if (method === "getSignaturesForAddress") {
      result = await rpc.getSignaturesForAddress(params[0], { before: params[1].before, limit: params[1].limit });
    } else if (method === "getTransaction") {
      result = await rpc.getTransaction(params[0]);
    } else {
      res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not served" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
const CLI = fileURLToPath(new URL("../scripts/verify-pass.ts", import.meta.url));
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

test("CLI: exit 0 complete, 1 incomplete, 2 input or RPC error", async () => {
  const complete = await serveFake(fakeRpc({ txs: history() }));
  const txs = history(); txs.splice(1, 1);
  const gap = await serveFake(fakeRpc({ txs }));
  try {
    const ok = await cli(["--rpc", complete.url, "--serial", SERIAL, "--program", PROGRAM, "--cluster", "devnet"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Verdict: complete and in order/);
    const json = await cli(["--rpc", complete.url, "--serial", SERIAL, "--json"]); // program from the IDL
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual([JSON.parse(json.stdout).found, JSON.parse(json.stdout).holding], [6, v2.pdas.holding]);
    const bad = await cli(["--rpc", gap.url, "--serial", SERIAL, "--program", PROGRAM]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /Verdict: incomplete or out of order \(found 5, holding says 6\)/);
    const wrongCluster = await cli(["--rpc", complete.url, "--serial", SERIAL, "--cluster", "mainnet"]);
    assert.equal(wrongCluster.code, 1);
    const unknown = await cli(["--rpc", complete.url, "--serial", "SN-2026-999999"]);
    assert.deepEqual([unknown.code, /no passport/.test(unknown.stderr)], [2, true]);
  } finally {
    await complete.close();
    await gap.close();
  }
  assert.equal((await cli(["--serial", SERIAL])).code, 2, "--rpc is required");
  assert.equal((await cli(["--rpc", "http://127.0.0.1:9", "--serial", SERIAL, "--cluster", "testnet"])).code, 2);
  assert.equal((await cli(["--rpc", "http://127.0.0.1:9", "--serial", SERIAL, "--bogus"])).code, 2);
  assert.equal((await cli(["--help"])).code, 0);
});
