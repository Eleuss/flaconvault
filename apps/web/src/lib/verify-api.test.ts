import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZERO32, buildScanMessage, bytesToHex, serialHash } from "@flaconvault/proof";
import { ApiError } from "./errors";
import { EVENT_RETRIES, api, attesterMismatch, eventRetryDelay, signedAttester, signedScanSummary, uploadMediaOnce, verifyBody, type VerifyInput } from "./verify-api";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const base: VerifyInput = {
  tag: { uid: "04AABBCCDDEEFF", ctr: "00000A", cmac: "0011223344556677", source: "nfc" },
  nonce: "0x" + "ab".repeat(32), role: 0, tier: 2, reading: { heat: 1, humidity: 0, uv: 3, heatLevels: [1, 1, 1, 1, 1, 0] },
  fill: 90, mediaHash: "0x" + "cd".repeat(32), serial: "SN-1", country: "", city: "  ", attester: null, platform: "ANDROID_WEB",
};

test("the verify body never carries tamper (contract C5)", () => {
  const b = verifyBody(base);
  assert.equal("tamper" in b, false);
  assert.doesNotMatch(JSON.stringify(b), /tamper/i);
});

test("heat levels only go along for a decided heat reading", () => {
  assert.deepEqual(verifyBody(base).heatLevels, [1, 1, 1, 1, 1, 0]);
  assert.deepEqual(verifyBody({ ...base, reading: { ...base.reading!, heat: 2, heatLevels: [0, 0, 1, 1, 1, 0] } }).heatLevels, [0, 0, 0, 0, 0, 0]);
  const none = verifyBody({ ...base, reading: null });
  assert.deepEqual(none.heatLevels, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(none.indicators, { heat: 3, humidity: 3, uv: 3 });
});

test("an adopted tap sends tapId + token instead of chip parameters; empty location fields are null", () => {
  const b = verifyBody({ ...base, tag: { ...base.tag, tapId: 7, tapToken: "tok" } });
  assert.equal(b.uid, undefined); assert.equal(b.cmac, undefined);
  assert.equal(b.tapId, 7); assert.equal(b.tapToken, "tok");
  assert.deepEqual(b.location, { country: null, city: null });
  assert.equal(verifyBody({ ...base, tag: { ...base.tag, source: "simulator" } }).platform, "SIMULATOR");
});

test("the scan must be anchored by the wallet it was signed for", () => {
  const v = { bundle: { heatLevels: [], attester: { pubkey: "WalletA", tier: 4, role: 4 } } };
  assert.deepEqual(signedAttester(v), { pubkey: "WalletA", tier: 4, role: 4 });
  assert.equal(attesterMismatch(v, "WalletA"), null);
  assert.equal(attesterMismatch(v, "WalletB"), "WalletA");
  // signed without a wallet (iPhone Safari): any wallet may anchor
  assert.equal(attesterMismatch({ bundle: { heatLevels: [], attester: { pubkey: null } } }, "WalletB"), null);
  assert.deepEqual(signedAttester(null), { pubkey: null, tier: null, role: null });
});

test("media uploads carry the session nonce (contract C11)", async () => {
  let sent: FormData | null = null;
  globalThis.fetch = (async (_u: string, i?: RequestInit) => { sent = i?.body as FormData; return new Response(JSON.stringify({ sha256: "0x00", ar: null, bytes: 3 }), { status: 200 }); }) as typeof fetch;
  await api.media([new Blob(["abc"], { type: "image/jpeg" })], "0xnonce");
  assert.ok(sent);
  const fd = sent as FormData;
  assert.equal(fd.get("nonce"), "0xnonce");
  assert.equal(fd.getAll("files").length, 1);
});

test("resume fetches the pending scan by id + token", async () => {
  let url = "";
  globalThis.fetch = (async (u: string) => { url = u; return new Response(JSON.stringify({ verdict: "VALID" }), { status: 200 }); }) as typeof fetch;
  await api.resume(42, "tok_en-1");
  assert.match(url, /\/api\/verify\/42\?token=tok_en-1$/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "resume_not_found" }), { status: 404 })) as typeof fetch;
  await assert.rejects(api.resume(42, "x"), (e: { code?: string }) => e.code === "resume_not_found");
});

test("the anchor step shows what the signed message commits to (resume link, M3)", () => {
  const msg = (o: { serial: string; media?: Uint8Array }) => bytesToHex(buildScanMessage({
    serialHash: serialHash(o.serial), uidHash: new Uint8Array(32).fill(2), counter: 41, tamper: 3, uv: 3, hum: 0, heat: 1, fill: 87,
    mediaHash: o.media ?? new Uint8Array(32).fill(9), nonce: new Uint8Array(32).fill(4), ts: 1_800_000_000,
  }));
  const v = { msgHex: msg({ serial: "SN-2026-000007" }), serial: "SN-2026-000007", bundle: { heatLevels: [], location: { country: "DE", city: " Berlin " } } };
  assert.deepEqual(signedScanSummary(v), { serial: "SN-2026-000007", counter: 41, heat: 1, humidity: 0, uv: 3, fill: 87, photos: true, place: "Berlin, DE" });
  // a serial the message does not commit to is not shown as the scanned passport
  assert.equal(signedScanSummary({ ...v, serial: "SN-2026-000008" })?.serial, null);
  const tier1 = signedScanSummary({ msgHex: msg({ serial: "SN-1", media: ZERO32 }), serial: "SN-1", bundle: { heatLevels: [], location: { country: null, city: null } } })!;
  assert.equal(tier1.photos, false);
  assert.equal(tier1.place, null);
  assert.equal(signedScanSummary({ msgHex: "00", serial: "SN-1", bundle: null }), null);
  assert.equal(signedScanSummary(null), null);
});

// ---- /api/events retries ----------------------------------------------------------------------------------------

const apiErr = (status: number, code: string, retryAfter: number | null = null) => new ApiError("/api/events", status, code, code, retryAfter);

test("event posts are retried for tx_not_visible and busy, and for rate_limited only with a short Retry-After", () => {
  assert.equal(eventRetryDelay(apiErr(503, "tx_not_visible"), 0), 2500);
  // busy: the verifier's Retry-After when the browser can read it (at most 5 s), else 2 s
  assert.equal(eventRetryDelay(apiErr(503, "busy"), 0), 2000);
  assert.equal(eventRetryDelay(apiErr(503, "busy", 3), 0), 3000);
  assert.equal(eventRetryDelay(apiErr(503, "busy", 60), 0), 5000);
  // rate_limited: this connection's own lookups still running (Retry-After 1) — not the per-minute budget
  assert.equal(eventRetryDelay(apiErr(429, "rate_limited", 1), 0), 1000);
  assert.equal(eventRetryDelay(apiErr(429, "rate_limited", 30), 0), null);
  assert.equal(eventRetryDelay(apiErr(429, "rate_limited"), 0), null);
  // never retried
  for (const [s, c] of [[403, "tx_mismatch"], [422, "tx_failed"], [409, "event_confirmed"], [503, "chain_not_configured"], [429, "report_limited"]] as const) assert.equal(eventRetryDelay(apiErr(s, c), 0), null, c);
  assert.equal(eventRetryDelay(new Error("Failed to fetch"), 0), null);
  // bounded
  assert.equal(eventRetryDelay(apiErr(503, "busy"), EVENT_RETRIES - 1), 2000);
  assert.equal(eventRetryDelay(apiErr(503, "busy"), EVENT_RETRIES), null);
});

test("api.events waits out 'busy' and then posts the event", async () => {
  const answers = [{ status: 503, body: { detail: "busy" } }, { status: 503, body: { detail: "tx_not_visible" } }, { status: 200, body: { id: 9 } }];
  let calls = 0;
  globalThis.fetch = (async () => { const a = answers[calls++]; return new Response(JSON.stringify(a.body), { status: a.status }); }) as typeof fetch;
  const waits: number[] = [];
  const r = await api.events({ serial: "SN-1", type: 2, txSig: "sig", actor: "me", ts: 5 }, async (ms) => { waits.push(ms); });
  assert.deepEqual(r, { id: 9 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2500]);
});

test("api.events gives up after EVENT_RETRIES and surfaces the last error", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ detail: "busy" }), { status: 503 }); }) as typeof fetch;
  await assert.rejects(api.events({ serial: "SN-1", type: 2 }, async () => {}), (e: unknown) => e instanceof ApiError && e.code === "busy");
  assert.equal(calls, EVENT_RETRIES + 1);
  // a refusal is not retried at all
  calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ detail: "tx_mismatch" }), { status: 403 }); }) as typeof fetch;
  await assert.rejects(api.events({ serial: "SN-1", type: 2 }, async () => {}));
  assert.equal(calls, 1);
});

// ---- media upload cache -----------------------------------------------------------------------------------------

test("photos are uploaded once per session nonce and set of frames, and again for a new session", async () => {
  const uploads: string[] = [];
  const upload = async (_b: Blob[], nonce: string) => { uploads.push(nonce); return { sha256: "0xABCD" }; };
  const frames = { blobs: [new Blob(["x"])], mediaHash: "0xabcd" };
  const first = await uploadMediaOnce(null, "0xn1", frames, upload);
  assert.deepEqual(first, { nonce: "0xn1", mediaHash: "0xabcd", sha256: "0xABCD" });
  // retried "Get signature" in the same session: reused (the verifier caps the files per nonce)
  assert.equal(await uploadMediaOnce(first, "0xN1", frames, upload), first);
  assert.deepEqual(uploads, ["0xn1"]);
  // the session was renewed: the server keeps uploads only for the nonce they came with, so upload again
  const renewed = await uploadMediaOnce(first, "0xn2", frames, upload);
  assert.equal(renewed.nonce, "0xn2");
  assert.deepEqual(uploads, ["0xn1", "0xn2"]);
  // new frames in the same session: upload again
  await uploadMediaOnce(renewed, "0xn2", { ...frames, mediaHash: "0xbeef" }, async (b, n) => { uploads.push(n); return { sha256: "0xbeef" }; });
  assert.deepEqual(uploads, ["0xn1", "0xn2", "0xn2"]);
});

test("an upload whose server hash differs from the frames is refused", async () => {
  await assert.rejects(uploadMediaOnce(null, "0xn1", { blobs: [], mediaHash: "0x01" }, async () => ({ sha256: "0x02" })), /different hash/);
});
