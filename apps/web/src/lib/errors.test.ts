// Run: cd apps/web && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_TOKEN_TEXT, ApiError, CODES, PROGRAM_ERRORS, TxFailedError, apiError, friendly, retryAfterSeconds, waitText } from "./errors";

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

test("not_partner and request_too_large are readable", async () => {
  for (const [status, code, path] of [[403, "not_partner", "/api/verify"], [413, "request_too_large", "/api/events"]] as const) {
    const e = await apiError(path, res(status, { detail: code }));
    assert.equal(friendly(e), CODES[code]);
    assert.doesNotMatch(CODES[code], /_/);
  }
  // not_partner comes only from the certified page, which has no owner role: the text sends the user to the scan
  // without certification instead of to an owner choice that page does not offer
  assert.match(CODES.not_partner, /Connect the partner wallet before “Get signature” \(on iPhone Safari: via WalletConnect\)\./);
  assert.match(CODES.not_partner, /Without a partner wallet, open the scan without certification and scan as owner\.$/);
  assert.doesNotMatch(CODES.not_partner, /, or scan as owner/);
});

test("new program errors read clearly, by Anchor name and by the program's message", () => {
  const sim = "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1794. Logs: Program log: AnchorError occurred. Error Code: StaleScanTimestamp. Error Number: 6036. Error Message: Signed ts is more than MAX_SCAN_TS_SKEW_S away from the cluster clock.";
  assert.match(friendly(new Error(sim)), /expired.*Scan again/);
  const landed = new TxFailedError("sig", "The order's price differs from the price the buyer agreed to — instruction 1 returned error 6022 (0x1786)");
  assert.match(friendly(landed), /^The transaction failed on chain: The price of this listing has changed/);
  for (const p of PROGRAM_ERRORS) assert.equal(friendly(new Error(`Error Code: ${p.name}. Error Number: 6000. Error Message: x.`)), p.text, p.name);
  // unknown program errors keep the program's own message
  assert.match(friendly(new Error("Error Code: Whatever. Error Number: 6001. Error Message: Something odd happened.")), /Something odd happened/);
});

test("report_limited does not claim an open report: it can also be the per-connection budget (C8)", () => {
  const m = friendly(new ApiError("/api/events", 429, "report_limited", "report_limited"));
  assert.match(m, /already open/);
  assert.match(m, /too many reports came from this connection/);
  assert.doesNotMatch(m, /no need to report it again/);
});

// ---- every verifier code and every user-facing program error ----------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

test("every machine code the verifier raises has a readable message (drift guard over apps/verify/fv)", () => {
  const dir = resolve(repo, "apps/verify/fv");
  const raised = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".py"))) {
    const src = readFileSync(resolve(dir, f), "utf8");
    // Array.from: the web tsconfig has no ES2015 target, so iterators are not iterable for the type checker
    Array.from(src.matchAll(/(?:HTTPException|TxRejected)\(\s*\d{3},\s*"([a-z][a-z0-9_]*)"/g)).forEach((m) => raised.add(m[1]));
    Array.from(src.matchAll(/"detail":\s*"([a-z][a-z0-9_]*)"/g)).forEach((m) => raised.add(m[1]));
  }
  for (const c of ["busy", "storage_full", "media_limited", "media_busy", "request_too_large", "not_partner", "rate_limited"]) assert.ok(raised.has(c), `the scan no longer finds ${c}`);
  for (const code of Array.from(raised)) {
    assert.ok(CODES[code], `verifier code ${code} has no entry in lib/errors.ts CODES`);
    assert.doesNotMatch(CODES[code], /\b[a-z]+_[a-z_]+\b/, `${code}: the message must not show a raw code`);
  }
});

test("the new verifier codes read clearly", async () => {
  const cases: Array<[number, string, string, RegExp]> = [
    [503, "busy", "/api/events", /busy checking other transactions/],
    [507, "storage_full", "/api/media", /cannot store photos/],
    [429, "media_limited", "/api/media", /too many photos/],
    [503, "media_busy", "/api/media", /too many photos right now/],
    [503, "rpc_unavailable", "/api/admin/purge-seed", /cannot reach the Solana network/],
  ];
  for (const [status, code, path, re] of cases) {
    const e = await apiError(path, res(status, { detail: code }));
    assert.equal(e.code, code);
    assert.match(friendly(e), re, code);
    assert.doesNotMatch(friendly(e), /HTTP \d/, `${code} is not a generic server error`);
  }
});

test("403 admin token required (dev reset, reconcile, admin routes) reads as text, other 403s keep their detail", async () => {
  for (const path of ["/api/dev/reset", "/api/reconcile", "/api/admin/purge-seed"]) {
    const e = await apiError(path, new Response(JSON.stringify({ detail: "admin token required" }), { status: 403 }));
    assert.equal(e.code, null);
    assert.equal(friendly(e), ADMIN_TOKEN_TEXT, path);
  }
  assert.match(ADMIN_TOKEN_TEXT, /FV_ADMIN_TOKEN/);
  assert.doesNotMatch(ADMIN_TOKEN_TEXT, /admin token required|HTTP \d/);
  assert.equal(friendly(new ApiError("/api/dev/reset", 403, "forbidden", "forbidden")), "The server refused this: forbidden.");
});

test("Retry-After is kept on the error and shown for the waiting codes only", async () => {
  assert.equal(retryAfterSeconds("7"), 7);
  assert.equal(retryAfterSeconds(" 120 "), 120);
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds("soon"), null);
  assert.equal(retryAfterSeconds(new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toUTCString(), Date.UTC(2026, 0, 1, 0, 0, 0)), 60);
  const limited = await apiError("/api/verify", new Response(JSON.stringify({ detail: "rate_limited" }), { status: 429, headers: { "Retry-After": "40" } }));
  assert.equal(limited.retryAfter, 40);
  assert.match(friendly(limited), /^Too many requests from this connection\..*The server asks to wait about 40 seconds\.$/);
  assert.match(friendly(new ApiError("/api/media", 429, "media_limited", "media_limited", 7200)), /about 2 hours/);
  // without the header the plain text stands alone
  assert.equal(friendly(new ApiError("/api/events", 503, "busy", "busy")), CODES.busy);
  // a code without a waiting meaning ignores the header
  assert.equal(friendly(new ApiError("/api/events", 403, "tx_mismatch", "tx_mismatch", 30)), CODES.tx_mismatch);
  assert.equal(waitText(1), "about 1 second");
  assert.equal(waitText(600), "about 10 minutes");
});

test("the verifier exposes Retry-After to the web origin (cross-origin fetch() hides it otherwise)", () => {
  // the web calls the verifier from the browser on another origin; Retry-After is not a CORS-safelisted header, so
  // without Access-Control-Expose-Headers r.headers.get("retry-after") is null there (tested in apps/verify/tests/test_cors.py)
  const main = readFileSync(resolve(repo, "apps/verify/fv/main.py"), "utf8");
  const cors = /add_middleware\(\s*CORSMiddleware,([^)]*)\)/.exec(main)?.[1] ?? "";
  assert.match(cors, /expose_headers=\[[^\]]*"Retry-After"[^\]]*\]/, "fv/main.py CORSMiddleware must expose Retry-After");
  assert.match(cors, /allow_credentials=False/);
});

test("media upload refusals (411/413/415) name the cause", async () => {
  const media = async (status: number, detail: string) => friendly(await apiError("/api/media", res(status, { detail })));
  assert.match(await media(411, "Content-Length required"), /did not send its size/);
  assert.match(await media(413, "at most 6 files per session"), /session already holds the most photos it can take \(6\)\. Restart the scan/);
  assert.match(await media(413, "each file must be at most 8 MB"), /larger than the server accepts \(8 MB\)/);
  assert.match(await media(413, "upload too large (at most 6 × 8 MB)"), /too large or too many for one upload/);
  assert.match(await media(413, "at most 6 files per upload"), /too many for one upload/);
  assert.match(await media(415, "only image/jpeg, image/png and image/webp are accepted"), /JPEG, PNG or WebP/);
});

test("the verifier's 422 input texts that can reach a user are readable", async () => {
  const e422 = async (path: string, detail: string) => friendly(await apiError(path, res(422, { detail })));
  assert.match(await e422("/api/events", "invalid serial (3–64 characters: letters, digits, '.', '_', '-')"), /^The serial number is not valid: 3–64 characters/);
  assert.match(await e422("/api/verify", "invalid serial"), /^The serial number is not valid/);
  assert.match(await e422("/api/events", "txSig must be a base58 transaction signature (64 bytes)"), /signature is malformed/);
  assert.match(await e422("/api/verify", "attester must be a base58 pubkey"), /wallet address was not accepted/);
});

/** The committed IDLs (packages/proof/src/idl): the program errors as the programs define them. */
const idlErrors = (["flacon", "escrow"] as const).flatMap((p) =>
  (JSON.parse(readFileSync(resolve(repo, `packages/proof/src/idl/${p}.json`), "utf8")) as { errors: Array<{ code: number; name: string; msg: string }> }).errors.map((e) => ({ ...e, program: p })));

test("PROGRAM_ERRORS matches the committed IDLs: each name exists and its msg matches exactly that error's messages", () => {
  const names = PROGRAM_ERRORS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
  for (const p of PROGRAM_ERRORS) {
    const same = idlErrors.filter((e) => e.name === p.name);
    assert.ok(same.length > 0, `${p.name} is not an error of flacon or escrow`);
    for (const e of same) assert.ok(e.msg.includes(p.msg), `${p.name}: "${p.msg}" must be part of the ${e.program} message "${e.msg}" (a landed-but-failed transaction only carries the message)`);
    for (const e of idlErrors.filter((x) => x.name !== p.name)) assert.ok(!e.msg.includes(p.msg), `${p.name}: "${p.msg}" also matches ${e.program} ${e.name} ("${e.msg}")`);
    assert.ok(!p.text.includes("_") && !idlErrors.some((e) => new RegExp(`\\b${e.name}\\b`).test(p.text)), `${p.name}: the text must not show code names`);
  }
});

test("the appended program errors and the escrow-step errors all have readable texts", () => {
  const appended = idlErrors.filter((e) => (e.program === "flacon" && e.code >= 6033) || (e.program === "escrow" && e.code >= 6022)).map((e) => e.name);
  const required = [...appended, "ScanBeforeOrderStep", "DeadSealAfterShipping", "AssetNotOwnedByIssuer", "NotIssuerOrAuthority", "PassportVoid",
    "TooManySeals", "ServerKeyNotValidNow", "StaleScanTimestamp", "CounterOutOfRange", "PriceChanged", "NotPassportOwner", "NotPartner",
    "SealDead", "CounterNotIncreasing", "TierNotAllowedForRole", "InvalidState", "NotSeller", "NotBuyer", "ScanAttesterMismatch", "ReceiptScanNotNewer"];
  for (const n of required) assert.ok(PROGRAM_ERRORS.some((p) => p.name === n), `missing ${n}`);
});

test("program errors read the same from a simulation (Anchor name) and from a landed transaction (message)", () => {
  for (const e of idlErrors) {
    const p = PROGRAM_ERRORS.find((x) => x.name === e.name);
    if (!p) continue;
    const sim = `Transaction simulation failed: Error processing Instruction 1: custom program error: 0x${e.code.toString(16)}. Logs: Program log: AnchorError occurred. Error Code: ${e.name}. Error Number: ${e.code}. Error Message: ${e.msg}.`;
    assert.equal(friendly(new Error(sim)), p.text, `${e.program} ${e.name} (simulation)`);
    const landed = new TxFailedError("sig", `${e.msg} — instruction 1 returned error ${e.code} (0x${e.code.toString(16)})`);
    assert.equal(friendly(landed), `The transaction failed on chain: ${p.text}`, `${e.program} ${e.name} (landed)`);
  }
  assert.match(friendly(new Error("Error Code: ScanBeforeOrderStep. Error Number: 6026.")), /made before the reservation/);
  assert.match(friendly(new Error("Error Code: DeadSealAfterShipping. Error Number: 6027.")), /only the escrow admin can refund/);
  assert.match(friendly(new Error("Error Code: NotPassportOwner. Error Number: 6023.")), /owner of the passport's Core asset can list it \(without a Core asset: its issuer, while still a partner\)/);
});

test("an Anchor error in the log wins over the keyword guesses (an 'Instruction: Cancel' line is no wallet cancel)", () => {
  const m = "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770. Logs: Program log: Instruction: Cancel, Program log: AnchorError occurred. Error Code: InvalidState. Error Number: 6000. Error Message: Order is not in the required state for this instruction.";
  assert.equal(friendly(new Error(m)), "The order has already moved on to another step. Reload the order.");
  const unknown = "Logs: Program log: Instruction: Cancel, Program log: AnchorError occurred. Error Code: MathOverflow. Error Number: 6021. Error Message: Arithmetic overflow.";
  assert.equal(friendly(new Error(unknown)), "The program refused the transaction: Arithmetic overflow.");
  // a real wallet rejection still reads as one
  assert.match(friendly(new Error("User rejected the request.")), /rejected or cancelled in the wallet/);
});
