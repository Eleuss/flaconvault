import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { firstSet, resolveUrls } from "./config";

/** KEY=VALUE lines of an env file, the way @next/env (dotenv) reads them: comments skipped, `KEY=` is an empty string. */
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

test("firstSet skips unset and blank values", () => {
  assert.equal(firstSet(undefined, "", "  ", "b", "c"), "b");
  assert.equal(firstSet(" a "), "a");
  assert.equal(firstSet(undefined, ""), "");
});

test("an empty VERIFY_URL falls back to NEXT_PUBLIC_VERIFY_URL (S21)", () => {
  const u = resolveUrls({ verifyUrl: "", publicVerifyUrl: "https://verify.example.test/" });
  assert.equal(u.verifyUrl, "https://verify.example.test");
  assert.equal(u.publicVerifyUrl, "https://verify.example.test");
  assert.equal(resolveUrls({ verifyUrl: "http://verify.internal:8787", publicVerifyUrl: "https://verify.example.test" }).verifyUrl,
    "http://verify.internal:8787", "a set VERIFY_URL wins");
});

test("empty values fall back to the defaults", () => {
  const u = resolveUrls({ verifyUrl: "", publicVerifyUrl: "", solanaRpc: "", canonicalOrigin: "" });
  assert.equal(u.verifyUrl, "http://localhost:8787");
  assert.equal(u.publicVerifyUrl, "http://localhost:8787");
  assert.equal(u.solanaRpc, "https://api.devnet.solana.com");
  assert.equal(u.canonicalOrigin, "https://app.flaconvault.com");
});

test("apps/web/.env.example copied to .env.local gives absolute server-side URLs", () => {
  const env = parseEnvFile(path.join(__dirname, "../../.env.example"));
  assert.ok(!("VERIFY_URL" in env) || env.VERIFY_URL !== "", "the template must not set VERIFY_URL to an empty value");
  const u = resolveUrls({ verifyUrl: env.VERIFY_URL, publicVerifyUrl: env.NEXT_PUBLIC_VERIFY_URL, solanaRpc: env.NEXT_PUBLIC_SOLANA_RPC, canonicalOrigin: env.NEXT_PUBLIC_CANONICAL_ORIGIN });
  for (const base of [u.verifyUrl, u.publicVerifyUrl, u.solanaRpc, u.canonicalOrigin]) {
    assert.doesNotThrow(() => new URL(`${base}/api/passports`), `${base} is not an absolute URL`);
    assert.match(base, /^https?:\/\//);
  }
  assert.equal(u.verifyUrl, "http://localhost:8787");
});
