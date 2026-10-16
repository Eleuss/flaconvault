import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AnchorRefused, anchorPlan, anchorScan, needsOwnScanConfirmation, resetsTxSig, type AnchorDeps } from "./anchor-scan";
import { ApiError } from "./errors";
import { SCAN_PROOF_DISCRIMINATOR, type CreatingTxExpectation } from "./send-tx";
import type { VerifyResult } from "./verify-api";

const PROGRAM = Keypair.generate().publicKey;
const me = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const scanProof = Keypair.generate().publicKey;

function scanProofAccount(attester: PublicKey) {
  const data = new Uint8Array(160);
  data.set(SCAN_PROOF_DISCRIMINATOR, 0);
  data.set(attester.toBytes(), 8 + 32 + 4 + 8 + 2 + 32 + 32);
  return { owner: PROGRAM, data };
}
const verifyFor = (pubkey: string | null): VerifyResult =>
  ({ verdict: "VALID", eventId: 7, serial: "SN-1", bundle: { heatLevels: [0, 0, 0, 0, 0, 0], attester: { pubkey, tier: 2, role: 0 } } }) as unknown as VerifyResult;

/** Fake wallet / RPC / verifier that records what the anchor step did. */
function deps(o: Partial<AnchorDeps> & { account?: { owner: PublicKey; data: Uint8Array } | null; found?: string | null; confirmError?: unknown } = {}) {
  const log: string[] = [];
  let expectation: CreatingTxExpectation | null = null;
  const d: AnchorDeps = {
    verify: verifyFor(me.toBase58()), wallet: me, programId: PROGRAM, landedSig: null,
    build: async () => { log.push("build"); return { tx: new Transaction(), scanProof }; },
    accountInfo: async () => { log.push("accountInfo"); return o.account ?? null; },
    findCreating: async (_a, e) => { log.push("findCreating"); expectation = e; return o.found === undefined ? "found-sig" : o.found; },
    send: async () => { log.push("send"); return "sent-sig"; },
    confirm: async (sig) => { log.push(`confirm:${sig}`); if (o.confirmError) throw o.confirmError; },
    ...o,
  };
  return { d, log, expectation: () => expectation };
}

test("a scan signed for another wallet is refused before anything is built or sent (S17)", async () => {
  const { d, log } = deps({ verify: verifyFor(other.toBase58()), landedSig: "kept" });
  const r = await anchorScan(d);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error instanceof AnchorRefused && /signed for wallet/.test(r.error.message));
  assert.ok(!r.ok && r.landedSig === "kept", "a landed signature is not forgotten by a wallet switch");
  assert.deepEqual(log, []);
});

test("no ScanProof yet, or only a SOL transfer to its address: record_scan is sent (M10)", async () => {
  for (const account of [null, { owner: SystemProgram.programId, data: new Uint8Array(0) }]) {
    const { d, log } = deps({ account });
    assert.deepEqual(await anchorScan(d), { ok: true, sig: "sent-sig" });
    assert.deepEqual(log, ["build", "accountInfo", "send", "confirm:sent-sig"]);
  }
});

test("this wallet's ScanProof already exists: its record_scan is recovered, nothing is sent again (M10)", async () => {
  const { d, log, expectation } = deps({ account: scanProofAccount(me) });
  assert.deepEqual(await anchorScan(d), { ok: true, sig: "found-sig" });
  assert.deepEqual(log, ["build", "accountInfo", "findCreating", "confirm:found-sig"]);
  const e = expectation()!;
  assert.equal(e.instruction, "record_scan");
  assert.ok(e.programId?.equals(PROGRAM));
  assert.ok(e.signer?.equals(me), "only a transaction signed by this wallet counts");
  // recovery found nothing (yet): a readable refusal, no signature kept
  const none = deps({ account: scanProofAccount(me), found: null });
  const r = await anchorScan(none.d);
  assert.ok(!r.ok && r.error instanceof AnchorRefused && /not found yet/.test(r.error.message) && r.landedSig === null);
  assert.ok(!none.log.includes("send") && !none.log.some((l) => l.startsWith("confirm")));
});

test("a ScanProof attested by another wallet is refused, never recovered or re-sent", async () => {
  const { d, log } = deps({ account: scanProofAccount(other) });
  const r = await anchorScan(d);
  assert.ok(!r.ok && r.error instanceof AnchorRefused && /already anchored by another wallet/.test(r.error.message));
  assert.deepEqual(log, ["build", "accountInfo"]);
  assert.deepEqual(anchorPlan(scanProofAccount(other), me, PROGRAM).kind, "refuse");
  assert.deepEqual(anchorPlan(scanProofAccount(me), me, PROGRAM), { kind: "recover" });
  assert.deepEqual(anchorPlan(null, me, PROGRAM), { kind: "send" });
});

test("tx_mismatch and tx_failed forget the landed signature; other failures keep it for the retry (M10)", async () => {
  for (const code of ["tx_mismatch", "tx_failed"]) {
    const { d } = deps({ confirmError: new ApiError("/api/events", 403, code, code) });
    const r = await anchorScan(d);
    assert.ok(!r.ok && r.landedSig === null, code);
  }
  for (const err of [new ApiError("/api/events", 503, "tx_not_visible", "tx_not_visible"), new TypeError("Failed to fetch")]) {
    const { d } = deps({ confirmError: err });
    const r = await anchorScan(d);
    assert.ok(!r.ok && r.landedSig === "sent-sig", String(err));
  }
  assert.equal(resetsTxSig(new ApiError("/api/events", 403, "tx_mismatch", "tx_mismatch")), true);
  assert.equal(resetsTxSig(new Error("tx_mismatch")), false, "only the verifier's code counts");
});

test("a landed signature only retries the confirmation", async () => {
  const { d, log } = deps({ landedSig: "landed" });
  assert.deepEqual(await anchorScan(d), { ok: true, sig: "landed" });
  assert.deepEqual(log, ["confirm:landed"]);
});

test("a resumed scan signed without a wallet is anchored only after the user confirms it is their own (M3)", async () => {
  const unbound = verifyFor(null);
  assert.equal(needsOwnScanConfirmation(true, unbound), true);
  assert.equal(needsOwnScanConfirmation(false, unbound), false, "a scan made on this page");
  assert.equal(needsOwnScanConfirmation(true, verifyFor(me.toBase58())), false, "bound to a wallet: only that wallet can anchor it");
  const refused = deps({ verify: unbound, resumed: true, ownScanConfirmed: false });
  const r = await anchorScan(refused.d);
  assert.ok(!r.ok && r.error instanceof AnchorRefused && /your own scan/.test(r.error.message));
  assert.deepEqual(refused.log, [], "nothing is built or signed");
  const confirmed = deps({ verify: unbound, resumed: true, ownScanConfirmed: true });
  assert.deepEqual(await anchorScan(confirmed.d), { ok: true, sig: "sent-sig" });
});
