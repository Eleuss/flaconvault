import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "./api";

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
