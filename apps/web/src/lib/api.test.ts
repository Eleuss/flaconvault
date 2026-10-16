import { test } from "node:test";
import assert from "node:assert/strict";
import { get, getTap, validTapId } from "./api";

const fake = (impl: () => Promise<Response>) => (async () => impl()) as unknown as typeof fetch;

test("only a 404 is 'missing'", async () => {
  assert.deepEqual(await get("/api/passport/X", fake(async () => new Response("{}", { status: 404 })), "http://v"), { status: "missing" });
});

test("5xx, network errors and timeouts are 'error', never 'missing'", async () => {
  for (const impl of [
    async () => new Response("bad gateway", { status: 502 }),
    async () => new Response("locked", { status: 503 }),
    async () => { throw new TypeError("fetch failed"); },
    async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; },
  ]) {
    const r = await get("/api/passport/X", fake(impl), "http://v");
    assert.equal(r.status, "error");
  }
});

test("200 returns the data, and every request carries a timeout signal", async () => {
  let init: RequestInit | undefined;
  const f = (async (_u: string, i?: RequestInit) => { init = i; return new Response(JSON.stringify({ serial: "SN-1" }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await get<{ serial: string }>("/api/passport/SN-1", f, "http://v");
  assert.deepEqual(r, { status: "ok", data: { serial: "SN-1" } });
  assert.ok(init?.signal instanceof AbortSignal);
});

test("tap ids: only what the verifier can issue (positive, no leading zero, at most 2^63 - 1)", () => {
  for (const ok of ["1", "42", "9223372036854775807", "1000000000000000000"]) assert.equal(validTapId(ok), true, ok);
  for (const bad of ["", "0", "007", "-1", "abc", "12a", " 12", "1e3", "9223372036854775808", "99999999999999999999", null, undefined]) {
    assert.equal(validTapId(bad), false, String(bad));
  }
});

test("a malformed /t tap id is 'missing' without a request, never an outage (S2)", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 422 }); }) as unknown as typeof fetch;
  try {
    for (const id of ["abc", "0", "12345678901234567890", "1%2F2"]) assert.deepEqual(await getTap(id), { status: "missing" }, id);
    assert.equal(calls, 0, "the verifier is not asked about an id it would reject with 422");
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 503 }); }) as unknown as typeof fetch;
    assert.equal((await getTap("17")).status, "error", "a well-formed id during an outage is still an outage");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
