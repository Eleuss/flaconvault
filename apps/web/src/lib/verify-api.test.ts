import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZERO32, buildScanMessage, bytesToHex, serialHash } from "@flaconvault/proof";
import { api, attesterMismatch, signedAttester, signedScanSummary, verifyBody, type VerifyInput } from "./verify-api";

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
