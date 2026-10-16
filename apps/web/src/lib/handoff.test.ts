import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ADOPT_WINDOW_S, adoptDeadline, safeScanUrl, scanSession, scanUrlFor, secondsLeft, sessionClock, tapHandoff } from "./handoff";

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
