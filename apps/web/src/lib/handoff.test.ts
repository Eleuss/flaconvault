import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ADOPT_WINDOW_S, HEALTH_TIMEOUT_MS, PUBLIC_RECORD_CHECK_MS, adoptDeadline, healthOk, reportsPublicRecord, safeScanUrl, scanSession, scanUrlFor, secondsLeft, sessionClock, tapGateAction, tapHandoff, verifierHasPublicRecord, verifierReady } from "./handoff";

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}
const g = globalThis as unknown as { localStorage: Storage; sessionStorage: Storage };
const setNavigator = (v: unknown) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true, writable: true });
beforeEach(() => { g.localStorage = new MemStorage(); g.sessionStorage = new MemStorage(); setNavigator({}); });

test("session clock: deadline from the TTL on the device clock, offset = server − device", () => {
  // device clock 2 minutes fast: the server issued at 1000, the device thinks it is 1120
  const c = sessionClock({ expiresAt: 1090, ttl: 90, issuedAt: 1000 }, 1120);
  assert.equal(c.offset, -120);
  assert.ok(c.deadline > 1120 + 80 && c.deadline <= 1120 + 90, "about 90 s from now on the device clock, not already expired");
  assert.ok(secondsLeft(c.deadline, 1120) >= 85);
  // without issuedAt the offset is derived from expiresAt − ttl
  assert.equal(sessionClock({ expiresAt: 1090, ttl: 90 }, 1000).offset, 0);
});

test("adopted tap: the 180 s server window ends the countdown when it comes first", () => {
  const c = sessionClock({ expiresAt: 2090, ttl: 90, issuedAt: 2000 }, 2000); // offset 0
  // tap 100 s before the session: window ends at tap + 180 − margin = 2070ish, before the session deadline (~2088)
  const a = adoptDeadline(1900, c);
  assert.equal(a.limitedBy, "tap");
  assert.ok(a.deadline < 1900 + ADOPT_WINDOW_S);
  // a fresh tap: the session deadline wins
  assert.equal(adoptDeadline(1995, c).limitedBy, "session");
  // the comparison uses the server clock: a device 60 s slow does not extend the window
  const slow = sessionClock({ expiresAt: 2090, ttl: 90, issuedAt: 2000 }, 1940); // offset +60
  const b = adoptDeadline(1900, slow);
  assert.equal(b.limitedBy, "tap");
  assert.ok(b.deadline - slow.offset < 1900 + ADOPT_WINDOW_S, "server-time deadline stays inside the window");
});

test("scan URL keeps tier/role/site and drops the one-shot parameters", () => {
  assert.equal(scanUrlFor(new URLSearchParams("tier=4&role=4&site=2&adopt=7&k=abc&resume=1.x")), "/scan?tier=4&role=4&site=2");
  assert.equal(scanUrlFor(new URLSearchParams("")), "/scan");
  assert.equal(scanUrlFor(new URLSearchParams("tier=<script>")), "/scan");
});

test("only same-origin /scan URLs are redirected to", () => {
  assert.equal(safeScanUrl("/scan?tier=3&role=4"), "/scan?tier=3&role=4");
  for (const bad of ["https://evil.example/scan", "//evil.example/scan", "/scanner", "/t?x", "javascript:alert(1)", null, undefined]) assert.equal(safeScanUrl(bad), "/scan");
});

test("an active session needs a local deadline in the future; the starting tab owns it", () => {
  const now = Date.now() / 1000;
  scanSession.set({ nonce: "0xabc", expiresAt: now + 90, ttl: 90, deadline: now + 60, offset: 0, scanUrl: "/scan?tier=4" });
  const s = scanSession.active();
  assert.ok(s);
  assert.equal(scanSession.ownedHere(s), true);
  // another tab: same localStorage, its own sessionStorage
  g.sessionStorage = new MemStorage();
  assert.ok(scanSession.active());
  assert.equal(scanSession.ownedHere(s), false);
  // expired on the device clock
  scanSession.set({ nonce: "0xdef", expiresAt: now + 90, ttl: 90, deadline: now - 1, offset: 0 });
  assert.equal(scanSession.active(), null);
  // a flag from an older version without a local deadline is not trusted
  g.localStorage.setItem("fv.scanSession", JSON.stringify({ nonce: "0x1", expiresAt: now + 90 }));
  assert.equal(scanSession.active(), null);
});

test("TapGate: only the tab that started the scan goes back to it, with its tier/role/site (S4)", () => {
  const now = Date.now() / 1000;
  const tag = { uid: "04A1B2C3D4E5F6", ctr: "00002A", cmac: "0011223344556677" };
  const session = { nonce: "0xabc", expiresAt: now + 90, ttl: 90, deadline: now + 60, offset: 0, scanUrl: "/scan?tier=4&role=4&site=2" };
  assert.deepEqual(tapGateAction(tag, session, true, "https://v.example"), { kind: "handoff", back: "/scan?tier=4&role=4&site=2" });
  // Android opens the sticker link in a new tab: it hands the tap over and stays, no second /scan on the same nonce
  assert.deepEqual(tapGateAction(tag, session, false, "https://v.example"), { kind: "handoff", back: null });
  // a stored scan URL that is not this origin's /scan is never followed
  assert.deepEqual(tapGateAction(tag, { ...session, scanUrl: "https://evil.example/scan" }, true, "https://v.example"), { kind: "handoff", back: "/scan" });
  // no session: the verifier consumes the tap
  assert.deepEqual(tapGateAction(tag, null, false, "https://v.example"), { kind: "verify", url: "https://v.example/t?uid=04A1B2C3D4E5F6&ctr=00002A&cmac=0011223344556677" });
  assert.deepEqual(tapGateAction({ uid: "", ctr: "", cmac: "AB", piccData: "CD", enc: "E F" }, null, true, "https://v.example"),
    { kind: "verify", url: "https://v.example/t?picc_data=CD&cmac=AB&enc=E%20F" });
});

test("tap handoff with Web Locks is taken exactly once", async () => {
  let chain = Promise.resolve<unknown>(null);
  setNavigator({ locks: { request: (_n: string, cb: () => unknown) => (chain = chain.then(cb)) } });
  tapHandoff.set({ uid: "04AABBCCDDEEFF", ctr: "000010", cmac: "00".repeat(8) });
  const [a, b] = await Promise.all([tapHandoff.take(), tapHandoff.take()]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test("tap handoff without Web Locks: the claim + re-check lets only one tab take it", async () => {
  tapHandoff.set({ uid: "04AABBCCDDEEFF", ctr: "000011", cmac: "00".repeat(8) });
  const [a, b] = await Promise.all([tapHandoff.take(), tapHandoff.take()]);
  assert.equal([a, b].filter(Boolean).length, 1, "the second claim overwrote the first, so only one survives");
  assert.equal(await tapHandoff.take(), null, "taken handoffs are gone");
});

// ---- TapGate: the verifier's /health before the tap is handed over (spec §10.3) ---------------------------------

const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("TapGate gate: only HTTP 2xx with JSON ok === true lets the tap go to the verifier", () => {
  assert.equal(healthOk(200, { ok: true, keyId: 1 }), true);
  assert.equal(healthOk(204, { ok: true }), true);
  assert.equal(healthOk(200, { ok: false }), false);
  assert.equal(healthOk(200, { ok: "true" }), false);
  assert.equal(healthOk(200, null), false);
  assert.equal(healthOk(200, [true]), false);
  assert.equal(healthOk(503, { ok: true }), false);
  assert.equal(healthOk(404, { ok: true }), false);
});

test("TapGate gate: asks {verify}/health without cache; non-2xx, ok !== true, bad JSON and network errors say no", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const answer = (r: () => Response | Promise<Response>) => (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return r(); }) as unknown as typeof fetch;
  assert.equal(await verifierReady("https://v.example", answer(() => json(200, { ok: true, simulator: false }))), true);
  assert.equal(calls[0].url, "https://v.example/health");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.ok(calls[0].init?.signal, "the request can be aborted");
  assert.equal(await verifierReady("https://v.example", answer(() => json(200, { ok: false }))), false);
  assert.equal(await verifierReady("https://v.example", answer(() => json(502, { ok: true }))), false);
  assert.equal(await verifierReady("https://v.example", answer(() => json(404, "<html>Not Found</html>"))), false, "the host's 404 page");
  assert.equal(await verifierReady("https://v.example", answer(() => json(200, "not json"))), false);
  assert.equal(await verifierReady("https://v.example", (async () => { throw new TypeError("Load failed"); }) as typeof fetch), false);
});

test("TapGate gate: gives up after 2 s, even when the request never settles", async (t) => {
  assert.equal(HEALTH_TIMEOUT_MS, 2000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  // a fetch that honours the abort, and one that ignores it: both end at 2 s
  const honours = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => { aborted = true; rej(new DOMException("aborted", "AbortError")); }))) as unknown as typeof fetch;
  const ignores = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  for (const f of [honours, ignores]) {
    let result: boolean | null = null;
    const p = verifierReady("https://v.example", f).then((v) => { result = v; });
    await Promise.resolve();
    t.mock.timers.tick(HEALTH_TIMEOUT_MS - 1);
    await Promise.resolve();
    assert.equal(result, null, "still waiting before 2 s");
    t.mock.timers.tick(1);
    await p;
    assert.equal(result, false);
  }
  assert.equal(aborted, true, "the hung request is aborted");
  // a body that arrives too late counts as a timeout as well
  const slowBody = (async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })) as unknown as typeof fetch;
  const p = verifierReady("https://v.example", slowBody);
  await Promise.resolve();
  t.mock.timers.tick(HEALTH_TIMEOUT_MS);
  assert.equal(await p, false);
});

// ---- the scan page: does the verifier have the public record? (asked once per page load) --------------------------

/** GET /health of the verifier at main (8fc705b), before the public record: no `relay`, `anchor` is ignored there. */
const HEALTH_BEFORE = { ok: true, keyId: 1, pubkeyHex: "ab".repeat(32), simulator: false, programId: null, build: null, arweave: null };
/** GET /health with the public record: `cluster` and `relay` (also while the relay is switched off). */
const HEALTH_P1 = (relay: unknown) => ({ ...HEALTH_BEFORE, cluster: "devnet", relay });

test("the relay button needs a /health that reports the public record (`relay`); an older verifier has none", async () => {
  assert.equal(reportsPublicRecord(HEALTH_P1({ enabled: true, ok: true })), true);
  // switched off, or not ok (low balance, budget spent): the verifier still signs FVSCAN2 and keeps the place to itself
  assert.equal(reportsPublicRecord(HEALTH_P1({ enabled: false, ok: false })), true);
  assert.equal(reportsPublicRecord(HEALTH_P1({ enabled: true, ok: false })), true);
  // main's verifier: no relay key → it would sign a v1 scan whose place and device type are public
  assert.equal(reportsPublicRecord(HEALTH_BEFORE), false);
  for (const relay of [null, undefined, true, "on", [], {}, { enabled: "true" }]) assert.equal(reportsPublicRecord(HEALTH_P1(relay)), false, JSON.stringify(relay));
  for (const h of [null, undefined, "ok", 1]) assert.equal(reportsPublicRecord(h), false, String(h));

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const answer = (r: () => Response) => (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return r(); }) as unknown as typeof fetch;
  assert.equal(await verifierHasPublicRecord("https://v.example", answer(() => json(200, HEALTH_P1({ enabled: false, ok: false })))), true);
  assert.equal(calls[0].url, "https://v.example/health");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.ok(calls[0].init?.signal, "the request can be aborted");
  assert.equal(await verifierHasPublicRecord("https://v.example", answer(() => json(200, HEALTH_BEFORE))), false);
  // /health that cannot be read: the wallet flow
  assert.equal(await verifierHasPublicRecord("https://v.example", answer(() => json(200, { ...HEALTH_P1({ enabled: true, ok: true }), ok: false }))), false);
  assert.equal(await verifierHasPublicRecord("https://v.example", answer(() => json(502, HEALTH_P1({ enabled: true, ok: true })))), false);
  assert.equal(await verifierHasPublicRecord("https://v.example", answer(() => json(200, "not json"))), false);
  assert.equal(await verifierHasPublicRecord("https://v.example", (async () => { throw new TypeError("Load failed"); }) as typeof fetch), false);
});

test("the scan page gives /health a short time (5 s), then settles on the wallet flow", async (t) => {
  assert.equal(PUBLIC_RECORD_CHECK_MS, 5000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hangs = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  let result: boolean | null = null;
  const p = verifierHasPublicRecord("https://v.example", hangs).then((v) => { result = v; });
  await Promise.resolve();
  t.mock.timers.tick(PUBLIC_RECORD_CHECK_MS - 1);
  await Promise.resolve();
  assert.equal(result, null, "still asking before the timeout");
  t.mock.timers.tick(1);
  await p;
  assert.equal(result, false);
});
