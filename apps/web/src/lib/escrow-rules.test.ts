// The order page's scan choice (vision handoff: fail-closed UNREADABLE/MISSING scans must not drive an order into
// MISMATCH). The other escrow rules are covered by tests/web-escrow-rules.ts at the repository root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderState, SCAN_TS_SKEW_S, scanUsableForOrder, stepScanChoice, type OrderLike } from "./escrow-rules";

const INTACT = 0, TRIGGERED = 1, UNREADABLE = 2, MISSING = 3;

test("only scans with heat and humidity decided can stand for an order step", () => {
  assert.deepEqual(scanUsableForOrder({ heat: INTACT, humidity: INTACT }), { ok: true });
  assert.deepEqual(scanUsableForOrder({ heat: TRIGGERED, humidity: TRIGGERED }), { ok: true });
  assert.deepEqual(scanUsableForOrder({ heat: UNREADABLE, humidity: INTACT }), { ok: false, reason: "heat unreadable" });
  assert.deepEqual(scanUsableForOrder({ heat: INTACT, humidity: MISSING }), { ok: false, reason: "humidity not read" });
  assert.deepEqual(scanUsableForOrder({ heat: UNREADABLE, humidity: UNREADABLE }), { ok: false, reason: "heat unreadable, humidity unreadable" });
  // a tier-1 scan or a payload without indicators
  assert.deepEqual(scanUsableForOrder(undefined), { ok: false, reason: "heat not read, humidity not read" });
  assert.deepEqual(scanUsableForOrder({ heat: "0", humidity: 0 }), { ok: false, reason: "heat not read" }, "codes are numbers, never strings");
});

const order = (o: Partial<OrderLike> = {}): OrderLike => ({ state: OrderState.RESERVED, reservedAt: 10_000, shippedAt: 0, disputeAfterS: 86_400, assetDeposited: false, ...o });
const scan = (key: string, ts: number, unusable: string | null = null) => ({ key, ts, unusable });

test("an undecided scan is listed but never chosen; the user's pick stays while it is selectable", () => {
  const scans = [scan("new-unreadable", 12_000, "heat unreadable"), scan("good", 11_000), scan("good-older", 10_500)];
  const c = stepScanChoice(order(), "preShip", scans, "");
  assert.deepEqual(c.offered.map((s) => s.key), ["new-unreadable", "good", "good-older"]);
  assert.equal(c.chosen?.key, "good", "the newest selectable scan, not the undecided one");
  assert.equal(c.undecided, 1);
  assert.equal(c.olderHidden, 0);
  assert.equal(stepScanChoice(order(), "preShip", scans, "good-older").chosen?.key, "good-older");
  // picking the undecided scan (a stale choice, or a forged option value) never selects it
  assert.equal(stepScanChoice(order(), "preShip", scans, "new-unreadable").chosen?.key, "good");
});

test("with only undecided scans nothing can be recorded", () => {
  const c = stepScanChoice(order({ state: OrderState.SHIPPED, shippedAt: 20_000 }), "receipt", [scan("a", 21_000, "humidity not read"), scan("b", 20_500, "heat unreadable")], "a");
  assert.equal(c.chosen, undefined);
  assert.equal(c.undecided, 2);
  assert.equal(c.offered.length, 2);
});

test("scans older than the step are left out before the indicator check (ScanBeforeOrderStep)", () => {
  const o = order({ reservedAt: 50_000 });
  const c = stepScanChoice(o, "preShip", [scan("before", 50_000 - SCAN_TS_SKEW_S - 1), scan("after", 50_001, "heat unreadable")], "");
  assert.deepEqual(c.offered.map((s) => s.key), ["after"]);
  assert.equal(c.olderHidden, 1);
  assert.equal(c.chosen, undefined);
  // no step (or no order): nothing offered
  assert.deepEqual(stepScanChoice(o, null, [scan("x", 60_000)], "").offered, []);
  assert.equal(stepScanChoice(null, "preShip", [scan("x", 60_000)], "").chosen, undefined);
});
