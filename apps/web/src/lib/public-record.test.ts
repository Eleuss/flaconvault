// Run: cd apps/web && npm test
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as strings from "./public-record";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADVANCED, DRAWER_TEXT, DRAWER_TITLE, NOT_SAVED, OVER_CAP, PASSPORT_PUBLIC, PUBLIC_RECORD_LINK, RECORD_ERRORS, SAVED, SAVE_BUTTON,
  SAVING, SAVING_TAP_SOON, SCAN_BY_LABEL, TAP_GATE_UNAVAILABLE, TAP_SEND_DELAY_S, TEST_PHASE_NOTICE, TRY_AGAIN, VIEW_RECORD, asRecord,
  isTerminalRecord, recordHref, recordLine, scanByLabel, scanRecordPollDelay, showTestNotice, startRecordPoll, tapRecordPollDelay,
  tapSendsSoon, watchTapRecord, witnessedBy, type PollEnd, type PublicRecord, type TapLine,
} from "./public-record";
import { ADOPT_WINDOW_S } from "./handoff";
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

test("record state → line: pending, a TAP still waiting for its send time, saved with its link, over cap, failed", () => {
  assert.deepEqual(recordLine(rec(), "SN-1"), { kind: "pending", text: SAVING, soon: false });
  // "within about 3 minutes" only for a pending TAP the /t page says is still waiting (tapSendsSoon), then "Saving…"
  assert.deepEqual(recordLine(rec({ purpose: "TAP" }), "SN-1", true), { kind: "pending", text: SAVING_TAP_SOON, soon: true });
  assert.deepEqual(recordLine(rec({ purpose: "TAP" }), "SN-1", false), { kind: "pending", text: SAVING, soon: false });
  assert.deepEqual(recordLine(rec({ purpose: "TAP" }), "SN-1"), { kind: "pending", text: SAVING, soon: false });
  // a CHECK is due at once: it never says "within about 3 minutes"
  assert.deepEqual(recordLine(rec(), "SN-1", true), { kind: "pending", text: SAVING, soon: false });
  assert.deepEqual(recordLine(rec({ state: "recorded", txSig: "Sig1" }), "SN 1/x"), { kind: "recorded", text: SAVED, link: { label: VIEW_RECORD, href: "/p/SN%201%2Fx#e12" } });
  assert.deepEqual(recordLine(rec({ state: "recorded", purpose: "TAP" }), "SN-1", true), { kind: "recorded", text: SAVED, link: { label: VIEW_RECORD, href: "/p/SN-1#e12" } });
  assert.deepEqual(recordLine(rec({ state: "recorded" }), null), { kind: "recorded", text: SAVED, link: null });
  assert.deepEqual(recordLine(rec({ state: "recorded", eventId: null }), "SN-1"), { kind: "recorded", text: SAVED, link: null });
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: "seal_daily" }), "SN-1"), { kind: "over_cap", text: OVER_CAP });
  // the daily fee budget (or no / an unknown reason) says nothing about this seal's entries
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: "budget" }), "SN-1"), { kind: "over_cap", text: NOT_SAVED });
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: null }), "SN-1"), { kind: "over_cap", text: NOT_SAVED });
  assert.deepEqual(recordLine(rec({ state: "over_cap", reason: "something_new" }), "SN-1"), { kind: "over_cap", text: NOT_SAVED });
  assert.deepEqual(recordLine(rec({ state: "failed", reason: "relay_off" }), "SN-1"), { kind: "failed", text: NOT_SAVED });
  assert.equal(recordHref("SN-2026-000001", 7), "/p/SN-2026-000001#e7");
});

test("/t: a TAP says 'within about 3 minutes' until tap ts + 185 s, from the tap's own time, never from dueAt", () => {
  const ts = 1_790_000_000;
  const tap = (o: Partial<PublicRecord> = {}) => rec({ purpose: "TAP", ...o });
  assert.equal(tapSendsSoon(tap(), ts, ts), true);
  assert.equal(tapSendsSoon(tap(), ts, ts + TAP_SEND_DELAY_S - 1), true);
  assert.equal(tapSendsSoon(tap(), ts, ts + TAP_SEND_DELAY_S), false);
  // the relayer's retry pauses move dueAt (now + 2..30 s) while the row stays queued: the line no longer follows it
  for (const [now, due] of [[ts + 186, ts + 185], [ts + 190, ts + 194], [ts + 300, ts + 330], [ts + 400, ts + 430]]) {
    assert.equal(tapSendsSoon(tap({ dueAt: due }), ts, now), false, `${now - ts} s after the tap, dueAt +${due - ts} s`);
  }
  // only a pending TAP, and only with the tap's time
  assert.equal(tapSendsSoon(tap(), null, ts), false);
  assert.equal(tapSendsSoon(tap(), undefined, ts), false);
  assert.equal(tapSendsSoon(rec(), ts, ts), false, "a CHECK (the adopting scan's record) is due at once");
  assert.equal(tapSendsSoon(tap({ state: "recorded" }), ts, ts), false);
  assert.equal(tapSendsSoon(null, ts, ts), false);
  // one way: once the line has left it, it never returns (also when the clock seems to go back)
  assert.equal(tapSendsSoon(tap(), ts, ts + 10, true), false);
  // the verifier sends a TAP once no scan session can adopt the tap any more: the adoption window + 5 s
  assert.equal(TAP_SEND_DELAY_S, ADOPT_WINDOW_S + 5);
});

test("TAP_SEND_DELAY_S is the verifier's (drift guard over apps/verify/fv relayer.py and service.py)", () => {
  const fv = (f: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../verify/fv", f), "utf8");
  const due = /^TAP_DUE_DELAY_S = ADOPT_WINDOW_S \+ (\d+)\b/m.exec(fv("relayer.py"));
  const adopt = /^ADOPT_WINDOW_S = (\d+)\b/m.exec(fv("service.py"));
  assert.ok(due && adopt, "fv/relayer.py TAP_DUE_DELAY_S or fv/service.py ADOPT_WINDOW_S moved");
  assert.equal(TAP_SEND_DELAY_S, Number(adopt[1]) + Number(due[1]));
  assert.equal(ADOPT_WINDOW_S, Number(adopt[1]));
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
  const seen: string[] = [], ends: PollEnd[] = [];
  startRecordPoll({ load: async () => { const a = answers[loads++]; if (a instanceof Error) throw a; return a; }, delay: scanRecordPollDelay, onRecord: (r) => seen.push(r.state), onEnd: (end) => ends.push(end) });
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(loads, 4, "no request after the recorded answer");
  assert.deepEqual(seen, ["pending", "pending", "recorded"]);
  assert.deepEqual(ends, [], "a terminal record is no end without one: onRecord has it");
});

test("the poller stops on a 404, at the end of its schedule, on a missing record and when cancelled, and says how it ended", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  // 404 record_not_found: stop and say so ("stopped", with the error)
  let loads = 0;
  const stopped: Array<[PollEnd, unknown]> = [];
  startRecordPoll({
    load: async () => { loads++; throw new ApiError("/api/verify/1/record", 404, "record_not_found", "record_not_found"); },
    delay: scanRecordPollDelay, onRecord: () => assert.fail("no record"),
    stopOn: (e) => e instanceof ApiError && e.status === 404, onEnd: (end, e) => { stopped.push([end, e]); },
  });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(loads, 1);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0][0], "stopped");
  assert.ok(stopped[0][1] instanceof ApiError);

  // still pending after 10 minutes: the /t schedule ends (120 requests at 5 s) with "timeout"
  let pending = 0;
  const timedOut: PollEnd[] = [];
  startRecordPoll({ load: async () => { pending++; return rec({ purpose: "TAP" }); }, delay: tapRecordPollDelay, onRecord: () => {}, onEnd: (end) => timedOut.push(end) });
  for (let i = 0; i < 130; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.equal(pending, 120);
  assert.deepEqual(timedOut, ["timeout"]);

  // the tap has no record (any more): nothing to show, stop with "gone"
  let none = 0;
  const gone: PollEnd[] = [];
  startRecordPoll({ load: async () => { none++; return null; }, delay: tapRecordPollDelay, onRecord: () => assert.fail("no record"), onEnd: (end) => gone.push(end) });
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.equal(none, 1);
  assert.deepEqual(gone, ["gone"]);

  // cancelled (the page was left): no further request, and no end reported
  let cancelled = 0;
  const after: PollEnd[] = [];
  const stop = startRecordPoll({ load: async () => { cancelled++; return rec(); }, delay: scanRecordPollDelay, onRecord: () => {}, onEnd: (end) => after.push(end) });
  t.mock.timers.tick(2000); await settle();
  stop();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(2000); await settle(); }
  assert.equal(cancelled, 1);
  assert.deepEqual(after, []);
});

test("a schedule that ends while every request fails (a phone asleep past 10 minutes) ends with 'timeout'", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const ends: PollEnd[] = [];
  let loads = 0;
  startRecordPoll({ load: async () => { loads++; throw new TypeError("Load failed"); }, delay: tapRecordPollDelay, onRecord: () => assert.fail("no record"), onEnd: (end) => ends.push(end) });
  // the one pending timer fires late (the tab was suspended): elapsed time is wall-clock, so the schedule is over
  t.mock.timers.tick(11 * 60_000); await settle();
  assert.equal(loads, 1);
  assert.deepEqual(ends, ["timeout"]);
});

// ---- the /t record line (components/tap-record.tsx) --------------------------------------------------------------

/** A /t record line under test: what it shows, and a "tab became visible again" switch. */
function tapWatch(t: TestContext, answers: Array<PublicRecord | null | Error>, initial = rec({ purpose: "TAP" })) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const shown: Array<TapLine | null> = [];
  const visible = new Set<() => void>();
  let loads = 0;
  const stop = watchTapRecord({
    initial,
    load: async () => { const a = answers[Math.min(loads++, answers.length - 1)]; if (a instanceof Error) throw a; return a; },
    isGone: (e) => e instanceof ApiError && e.status === 404,
    show: (l) => shown.push(l),
    onVisible: (cb) => { visible.add(cb); return () => visible.delete(cb); },
  });
  return { shown, stop, loads: () => loads, listening: () => visible.size, becomeVisible: () => visible.forEach((cb) => cb()) };
}
const tick = async (t: TestContext, ms: number) => { t.mock.timers.tick(ms); await settle(); };

test("/t: the line goes when the record does (null: a wallet scan adopted the tap; 404: the tap is gone)", async (t) => {
  const adopted = tapWatch(t, [rec({ purpose: "TAP" }), null]);
  await tick(t, 5000);
  await tick(t, 5000);
  assert.deepEqual(adopted.shown, [{ record: rec({ purpose: "TAP" }), live: true }, null], "hidden, not a spinner for good");
  await tick(t, 60_000);
  assert.equal(adopted.loads(), 2, "no request after the record is gone");
  assert.equal(adopted.listening(), 0);
  adopted.stop();

  t.mock.timers.reset();
  const missing = tapWatch(t, [new ApiError("/api/tap/31", 404, "tap not found", null)]);
  await tick(t, 5000);
  assert.deepEqual(missing.shown, [null]);
  missing.stop();
});

test("/t: when the 10 minutes run out the line keeps its text without the spinner; a visible tab loads it once more", async (t) => {
  // the verifier stays unreachable for the whole schedule
  const w = tapWatch(t, [new TypeError("Load failed")]);
  for (let i = 0; i < 125; i++) await tick(t, 5000);
  assert.equal(w.loads(), 120);
  assert.deepEqual(w.shown, [{ record: rec({ purpose: "TAP" }), live: false }], "no spinner after the schedule");
  assert.equal(w.listening(), 1);
  w.stop();
  assert.equal(w.listening(), 0, "the cleanup stops listening");

  // back on the tab: one request; still pending → stays without spinner and keeps listening; saved → shown, done
  t.mock.timers.reset();
  const saved = rec({ purpose: "TAP", state: "recorded", txSig: "Sig" });
  const answers: Array<PublicRecord | null | Error> = [...Array<Error>(120).fill(new TypeError("Load failed")), rec({ purpose: "TAP" }), saved, rec({ purpose: "TAP" })];
  const back = tapWatch(t, answers);
  for (let i = 0; i < 125; i++) await tick(t, 5000);
  assert.equal(back.loads(), 120);
  back.becomeVisible(); await settle();
  assert.equal(back.loads(), 121, "exactly one request per return to the tab");
  assert.deepEqual(back.shown.at(-1), { record: rec({ purpose: "TAP" }), live: false });
  assert.equal(back.listening(), 1);
  await tick(t, 60_000);
  assert.equal(back.loads(), 121, "no polling again");
  back.becomeVisible(); await settle();
  assert.deepEqual(back.shown.at(-1), { record: saved, live: false });
  assert.equal(back.listening(), 0, "a terminal record ends it");
  back.stop();

  // back on the tab, and the record is gone by now: the line goes
  t.mock.timers.reset();
  const gone = tapWatch(t, [...Array<Error>(120).fill(new TypeError("Load failed")), null]);
  for (let i = 0; i < 125; i++) await tick(t, 5000);
  gone.becomeVisible(); await settle();
  assert.equal(gone.shown.at(-1), null);
  assert.equal(gone.listening(), 0);
  gone.stop();
});

test("/t: a settled record is not polled; a pending one shows its updates live", async (t) => {
  const settled = tapWatch(t, [rec()], rec({ purpose: "TAP", state: "recorded", txSig: "S" }));
  await tick(t, 60_000);
  assert.equal(settled.loads(), 0);
  assert.deepEqual(settled.shown, []);
  settled.stop();

  t.mock.timers.reset();
  const check = rec({ purpose: "CHECK", eventId: 40 }), recorded = rec({ purpose: "CHECK", eventId: 40, state: "recorded", txSig: "S" });
  const live = tapWatch(t, [check, recorded]);
  await tick(t, 5000);
  await tick(t, 5000);
  await tick(t, 5000);
  assert.deepEqual(live.shown, [{ record: check, live: true }, { record: recorded, live: false }]);
  assert.equal(live.loads(), 2);
  assert.equal(live.listening(), 0);
  live.stop();
});
