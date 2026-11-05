// Run: cd apps/web && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as strings from "./public-record";
import {
  ADVANCED, DRAWER_TEXT, DRAWER_TITLE, NOT_SAVED, OVER_CAP, PASSPORT_PUBLIC, PUBLIC_RECORD_LINK, RECORD_ERRORS, SAVED, SAVE_BUTTON,
  SAVING, SAVING_TAP_SOON, SCAN_BY_LABEL, TAP_GATE_UNAVAILABLE, TEST_PHASE_NOTICE, TRY_AGAIN, VIEW_RECORD, asRecord,
  isTerminalRecord, recordHref, recordLine, scanByLabel, scanRecordPollDelay, showTestNotice, startRecordPoll, tapRecordPollDelay,
  witnessedBy, type PublicRecord,
} from "./public-record";
import { ADVANCED_INTRO } from "./scan-steps";
import { ApiError, CODES, friendly } from "./errors";

const rec = (o: Partial<PublicRecord> = {}): PublicRecord => ({ state: "pending", purpose: "CHECK", eventId: 12, dueAt: null, txSig: null, reason: null, cluster: "DEVNET", ...o });

test("the strings are exactly the ones of spec §10.2 (… U+2026, ✓ U+2713, · U+00B7)", () => {
  assert.equal(TAP_GATE_UNAVAILABLE, "Seal check unavailable right now. Try again in a minute.");
  assert.equal(TRY_AGAIN, "Try again");
  assert.equal(SAVE_BUTTON, "Save to the public record");
  assert.equal(SAVING, "Saving…");
  assert.equal(SAVING_TAP_SOON, "Saving to the public record within about 3 minutes.");
  assert.equal(`${SAVED} · ${VIEW_RECORD}`, "Saved to the public record ✓ · view record");
  assert.equal(OVER_CAP, "Kept by FlaconVault only: this seal already has its public entries for the last 24 hours.");
  assert.equal(NOT_SAVED, "Not saved to the public record this time. FlaconVault keeps the check.");
  assert.equal(ADVANCED, "Advanced");
  assert.equal(ADVANCED_INTRO, "For partners and your own wallet: sign and pay for this scan yourself.");
  assert.deepEqual(Object.values(SCAN_BY_LABEL), ["Visitor", "Holder", "Partner", "Recipient"]);
  assert.equal(PUBLIC_RECORD_LINK, "Public record");
  assert.equal(DRAWER_TITLE, "How this record is checked");
  assert.equal(DRAWER_TEXT, "Public record signed by FlaconVault. Anyone can check our signature and that this list is complete; the seal's secret check itself can only be done by FlaconVault.");
  assert.equal(TEST_PHASE_NOTICE, "Test phase: records are saved on Solana's test network until launch.");
  assert.equal(RECORD_ERRORS.ticket_invalid, "This kind of scan needs a FlaconVault account. It is not available yet.");
  assert.equal(RECORD_ERRORS.ticket_required, RECORD_ERRORS.ticket_invalid);
  assert.equal(RECORD_ERRORS.relay_not_for_certified, "Certified scans are signed by the partner (Advanced).");
  assert.equal(RECORD_ERRORS.wallet_anchor_not_allowed, "This pass is held in a FlaconVault account. Use \"Save to the public record\".");
  assert.equal(RECORD_ERRORS.record_not_found, "The public record status of this scan is not available.");
});

/** Every string the module exports, also inside exported objects. */
function exportedStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") Object.values(v).forEach((x) => exportedStrings(x, out));
  return out;
}

test("the consumer strings never say blockchain, wallet, NFT, token, crypto, guaranteed or trustless", () => {
  // the /p header pill and footer are built at render time: their outputs are checked too
  const all = [...exportedStrings(Object.values(strings)), witnessedBy(1, 0), witnessedBy(3, 1), PASSPORT_PUBLIC];
  assert.ok(all.length >= 25, `found ${all.length} strings`);
  for (const s of all) assert.doesNotMatch(s, /blockchain|wallet|\bNFTs?\b|token|crypto|guarantee|trustless/i, s);
  // the one Advanced line that names the wallet is kept with the wallet flow, not here
  assert.ok(!all.includes(ADVANCED_INTRO));
  assert.match(ADVANCED_INTRO, /wallet/);
});

test("the new verifier codes have their messages in lib/errors.ts", async () => {
  for (const [code, text] of Object.entries(RECORD_ERRORS)) {
    assert.equal(CODES[code], text, code);
    assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, `${code}: no raw code in the message`);
  }
  assert.ok(CODES.purpose_invalid);
  // 409 on /api/verify reads as "other passport" only without a code: wallet_anchor_not_allowed keeps its own text
  assert.equal(friendly(new ApiError("/api/verify", 409, "wallet_anchor_not_allowed", "wallet_anchor_not_allowed")), RECORD_ERRORS.wallet_anchor_not_allowed);
  assert.equal(friendly(new ApiError("/api/verify", 422, "relay_not_for_certified", "relay_not_for_certified")), RECORD_ERRORS.relay_not_for_certified);
  assert.equal(friendly(new ApiError("/api/verify/12/record", 404, "record_not_found", "record_not_found")), RECORD_ERRORS.record_not_found);
});

test("record state → line: pending, a TAP still inside its adoption window, saved with its link, over cap, failed", () => {
  const now = 1_790_000_000;
  assert.deepEqual(recordLine(rec(), "SN-1", now), { kind: "pending", text: SAVING, soon: false });
  // a TAP waits for the 180 s adoption window: "within about 3 minutes" while its dueAt lies ahead, then "Saving…"
  assert.deepEqual(recordLine(rec({ purpose: "TAP", dueAt: now + 120 }), "SN-1", now), { kind: "pending", text: SAVING_TAP_SOON, soon: true });
  assert.deepEqual(recordLine(rec({ purpose: "TAP", dueAt: now }), "SN-1", now), { kind: "pending", text: SAVING, soon: false });
  assert.deepEqual(recordLine(rec({ purpose: "TAP", dueAt: null }), "SN-1", now), { kind: "pending", text: SAVING, soon: false });
  // a CHECK is due at once: a dueAt never makes it "within about 3 minutes"
  assert.equal(recordLine(rec({ dueAt: now + 120 }), "SN-1", now).text, SAVING);
  assert.deepEqual(recordLine(rec({ state: "recorded", txSig: "Sig1" }), "SN 1/x", now), { kind: "recorded", text: SAVED, link: { label: VIEW_RECORD, href: "/p/SN%201%2Fx#e12" } });
  assert.deepEqual(recordLine(rec({ state: "recorded" }), null, now), { kind: "recorded", text: SAVED, link: null });
  assert.deepEqual(recordLine(rec({ state: "recorded", eventId: null }), "SN-1", now), { kind: "recorded", text: SAVED, link: null });
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: "seal_daily" }), "SN-1", now), { kind: "over_cap", text: OVER_CAP });
  // the daily fee budget (or no / an unknown reason) says nothing about this seal's entries
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: "budget" }), "SN-1", now), { kind: "over_cap", text: NOT_SAVED });
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: null }), "SN-1", now), { kind: "over_cap", text: NOT_SAVED });
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: "something_new" }), "SN-1", now), { kind: "over_cap", text: NOT_SAVED });
  assert.deepEqual(recordLine(rec({ state: "failed", reason: "relay_off" }), "SN-1", now), { kind: "failed", text: NOT_SAVED });
  assert.equal(recordHref("SN-2026-000001", 7), "/p/SN-2026-000001#e7");
});

test("the /p header pill and footer name signers and an account, not wallets", () => {
  assert.equal(witnessedBy(1, 0), "Witnessed by 1 signer, 0 of them certified");
  assert.equal(witnessedBy(3, 1), "Witnessed by 3 signers, 1 of them certified");
  assert.equal(PASSPORT_PUBLIC, "This passport is publicly readable, without an account and without login.");
});

test("only a record object with a known state is taken; only pending keeps polling", () => {
  assert.equal(asRecord(undefined), null);
  assert.equal(asRecord(null), null);
  assert.equal(asRecord({ state: "replaced", purpose: "TAP", eventId: 1 }), null, "replaced rows are never shown");
  assert.equal(asRecord("pending"), null);
  assert.deepEqual(asRecord(rec()), rec());
  assert.equal(isTerminalRecord(rec()), false);
  for (const state of ["recorded", "over_cap", "failed"] as const) assert.equal(isTerminalRecord(rec({ state })), true, state);
});

test("scanBy → history label; unknown or absent values give none", () => {
  assert.equal(scanByLabel("VISITOR"), "Visitor");
  assert.equal(scanByLabel("HOLDER"), "Holder");
  assert.equal(scanByLabel("PARTNER"), "Partner");
  assert.equal(scanByLabel("RECIPIENT"), "Recipient");
  for (const v of [undefined, null, "", "visitor", "WALLET", "toString", 1]) assert.equal(scanByLabel(v), null, String(v));
});

test("the test-phase notice shows on devnet and localnet, never on mainnet", () => {
  assert.equal(showTestNotice("devnet"), true);
  assert.equal(showTestNotice("localnet"), true);
  assert.equal(showTestNotice("mainnet"), false);
});

test("polling schedules: scan page 2 s for 2 minutes, then 10 s up to 10 minutes; /t every 5 s for 10 minutes", () => {
  assert.equal(scanRecordPollDelay(0), 2000);
  assert.equal(scanRecordPollDelay(119_999), 2000);
  assert.equal(scanRecordPollDelay(120_000), 10_000);
  assert.equal(scanRecordPollDelay(599_999), 10_000);
  assert.equal(scanRecordPollDelay(600_000), null);
  assert.equal(tapRecordPollDelay(0), 5000);
  assert.equal(tapRecordPollDelay(599_999), 5000);
  assert.equal(tapRecordPollDelay(600_000), null);
});

/** Lets the poller's awaited load settle between timer ticks. */
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("the poller stops at a terminal record and retries transient errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const answers: Array<PublicRecord | Error> = [rec(), new Error("Load failed"), rec(), rec({ state: "recorded", txSig: "S" }), rec()];
  let loads = 0;
  const seen: string[] = [];
  startRecordPoll({ load: async () => { const a = answers[loads++]; if (a instanceof Error) throw a; return a; }, delay: scanRecordPollDelay, onRecord: (r) => seen.push(r.state) });
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(loads, 4, "no request after the recorded answer");
  assert.deepEqual(seen, ["pending", "pending", "recorded"]);
});

test("the poller stops on a 404, at the end of its schedule, on a missing record and when cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  // 404 record_not_found: stop and say so
  let loads = 0, stoppedWith: unknown = null;
  startRecordPoll({
    load: async () => { loads++; throw new ApiError("/api/verify/1/record", 404, "record_not_found", "record_not_found"); },
    delay: scanRecordPollDelay, onRecord: () => assert.fail("no record"),
    stopOn: (e) => e instanceof ApiError && e.status === 404, onStop: (e) => { stoppedWith = e; },
  });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(loads, 1);
  assert.ok(stoppedWith instanceof ApiError);

  // still pending after 10 minutes: the /t schedule ends (120 requests at 5 s)
  let pending = 0;
  startRecordPoll({ load: async () => { pending++; return rec({ purpose: "TAP" }); }, delay: tapRecordPollDelay, onRecord: () => {} });
  for (let i = 0; i < 130; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.equal(pending, 120);

  // the tap has no record (any more): nothing to show, stop
  let none = 0;
  startRecordPoll({ load: async () => { none++; return null; }, delay: tapRecordPollDelay, onRecord: () => assert.fail("no record") });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.equal(none, 1);

  // cancelled (the page was left): no further request
  let cancelled = 0;
  const stop = startRecordPoll({ load: async () => { cancelled++; return rec(); }, delay: scanRecordPollDelay, onRecord: () => {} });
  t.mock.timers.tick(2000); await settle();
  stop();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(cancelled, 1);
});
