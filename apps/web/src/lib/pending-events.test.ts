import { test } from "node:test";
import assert from "node:assert/strict";
import { flushPending, forgetPending, loadPending, parsePending, pendingKey, rememberPending, savePending, withPending, type KeyValue, type PendingEvent } from "./pending-events";

const kv = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const ORDER = "8vxGxW1gOrderPdaForTests";
const reserve: PendingEvent = { sig: "sigReserve", type: 3, payload: { priceUsdc: 480 } };
const receive: PendingEvent = { sig: "sigReceive", type: 6, payload: { match: true } };

test("a second landed action never overwrites an unposted one (S6/S7)", () => {
  const s = kv();
  rememberPending(ORDER, reserve, s);
  const list = rememberPending(ORDER, receive, s);
  assert.deepEqual(list.map((p) => p.sig), ["sigReserve", "sigReceive"]);
  assert.deepEqual(loadPending(ORDER, s), [reserve, receive]);
  // the same signature again replaces its entry instead of duplicating it
  assert.deepEqual(withPending(list, { ...reserve, payload: { priceUsdc: 500 } }).map((p) => [p.sig, p.payload.priceUsdc ?? null]), [["sigReserve", 500], ["sigReceive", null]]);
});

test("entries live under fv.pendingEvent.<order>; the key is removed once nothing is pending", () => {
  const s = kv();
  rememberPending(ORDER, reserve, s);
  assert.ok(s.data.has(pendingKey(ORDER)));
  assert.equal(pendingKey(ORDER), `fv.pendingEvent.${ORDER}`);
  assert.deepEqual(forgetPending(ORDER, "sigReserve", s), []);
  assert.equal(s.data.has(pendingKey(ORDER)), false);
});

test("an entry written by an older build (one object) still loads; malformed data is dropped", () => {
  assert.deepEqual(parsePending(JSON.stringify(reserve)), [reserve]);
  assert.deepEqual(parsePending(JSON.stringify([reserve, { sig: "", type: 1, payload: {} }, { type: 2 }, null, receive])), [reserve, receive]);
  assert.deepEqual(parsePending("not json"), []);
  assert.deepEqual(parsePending(null), []);
  // storage that throws (private mode, blocked site data) behaves like empty storage
  const broken: KeyValue = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadPending(ORDER, broken), []);
  savePending(ORDER, [reserve], broken);
  assert.deepEqual(loadPending(ORDER, null), []);
});

test("flushPending posts oldest first, keeps failures, drops settled ones", async () => {
  const posted: string[] = [];
  const failing = new Error("503");
  const settled = new Error("event_confirmed");
  const third: PendingEvent = { sig: "sigRelease", type: 7, payload: {} };
  const r = await flushPending([reserve, receive, third], async (p) => {
    posted.push(p.sig);
    if (p.sig === "sigReserve") throw failing;
    if (p.sig === "sigRelease") throw settled;
  }, (e) => e === settled);
  assert.deepEqual(posted, ["sigReserve", "sigReceive", "sigRelease"]);
  assert.deepEqual(r.left, [reserve]);
  assert.equal(r.error, failing);
  const ok = await flushPending([receive], async () => {});
  assert.deepEqual(ok, { left: [], error: null });
});
