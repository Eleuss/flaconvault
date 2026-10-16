import { test, before } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, keepsOrigin, middleware } from "./middleware";

before(() => { process.env.NEXT_PUBLIC_CANONICAL_ORIGIN = "https://app.flaconvault.com"; });
const req = (method: string, path: string, host = "flaconvault.vercel.app") =>
  new NextRequest(`https://${host}${path}`, { method, headers: { host } });

test("old host: pages and sticker links get a 308 to the canonical origin", () => {
  const r = middleware(req("GET", "/t?uid=04AA&ctr=000001&cmac=00"));
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "https://app.flaconvault.com/t?uid=04AA&ctr=000001&cmac=00");
});

test("Blink endpoints, actions.json and every OPTIONS request are never redirected (S18)", () => {
  for (const [m, p] of [["GET", "/api/actions/verify-buy?serial=SN-1"], ["POST", "/api/actions/verify-buy?serial=SN-1"], ["OPTIONS", "/api/actions/verify-buy"], ["GET", "/actions.json"], ["OPTIONS", "/scan"]] as const) {
    assert.equal(keepsOrigin(m, new URL(`https://x${p}`).pathname), true, `${m} ${p}`);
    assert.notEqual(middleware(req(m, p)).status, 308, `${m} ${p}`);
  }
  assert.equal(keepsOrigin("GET", "/api/actionsX"), false);
});

test("the matcher excludes the Blink paths too", () => {
  const re = new RegExp(`^${config.matcher[0]}$`);
  assert.equal(re.test("/t"), true);
  assert.equal(re.test("/api/actions/verify-buy"), false);
  assert.equal(re.test("/actions.json"), false);
  assert.equal(re.test("/_next/static/x.js"), false);
});

test("other hosts are untouched", () => {
  assert.notEqual(middleware(req("GET", "/scan", "app.flaconvault.com")).status, 308);
  assert.notEqual(middleware(req("GET", "/scan", "flaconvault-git-x.vercel.app")).status, 308);
});
