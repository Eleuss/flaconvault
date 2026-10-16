// Run: cd apps/web && npx tsx --test 'src/**/*.test.ts'
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, CODES, TxFailedError, apiError, friendly } from "./errors";

const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

test("every verifier error code of contract C8 has a readable message", () => {
  for (const code of ["tx_not_visible", "tx_failed", "tx_mismatch", "nonce_invalid", "not_issuer", "event_confirmed", "chain_not_configured",
    "rate_limited", "report_limited", "media_nonce_invalid", "resume_not_found"]) {
    assert.ok(CODES[code], `missing ${code}`);
    assert.doesNotMatch(CODES[code], /_/, `${code} message must not show a raw code`);
  }
});

test("codes arrive as FastAPI detail strings and map to their message", async () => {
  const cases: Array<[number, string, string]> = [
    [429, "rate_limited", "/api/verify"], [429, "report_limited", "/api/events"], [403, "media_nonce_invalid", "/api/media"],
    [404, "resume_not_found", "/api/verify/7"], [403, "nonce_invalid", "/api/events"], [403, "not_issuer", "/api/events"],
    [409, "event_confirmed", "/api/events"], [503, "chain_not_configured", "/api/events"], [403, "tx_mismatch", "/api/events"],
  ];
  for (const [status, code, path] of cases) {
    const e = await apiError(path, res(status, { detail: code }));
    assert.equal(e.code, code);
    assert.equal(friendly(e), CODES[code], code);
  }
});

test("tx_mismatch no longer claims the wallet did not sign", () => {
  assert.doesNotMatch(CODES.tx_mismatch, /did not sign/);
});

test("structured detail objects keep their code", async () => {
  const e = await apiError("/api/events", res(503, { detail: { code: "tx_not_visible", message: "not yet visible" } }));
  assert.equal(e.code, "tx_not_visible");
  assert.equal(friendly(e), CODES.tx_not_visible);
});

test("media upload errors are specific", () => {
  assert.match(friendly(new ApiError("/api/media", 413, "too large", null)), /too many|too large/i);
  assert.match(friendly(new ApiError("/api/media", 422, "no file", null)), /No photo/);
});

test("an SPL token shortfall is not reported as missing SOL", () => {
  const usdc = friendly(new Error("Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1. Logs: Program log: Error: insufficient funds"));
  assert.match(usdc, /USDC/);
  assert.doesNotMatch(usdc, /SOL on devnet/);
  const sol = friendly(new Error("Attempt to debit an account but found no record of a prior credit."));
  assert.match(sol, /no SOL/);
  assert.doesNotMatch(sol, /airdrop/i, "the airdrop button exists only in demo mode");
});

test("timeouts and landed-but-failed transactions read clearly", () => {
  const t = new Error("The operation was aborted due to timeout"); t.name = "TimeoutError";
  assert.match(friendly(t), /did not answer in time/);
  assert.match(friendly(new TxFailedError("sig", "insufficient SOL")), /failed on chain/);
});
