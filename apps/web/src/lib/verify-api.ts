"use client";
import { ZERO32, bytesEqual, hexToBytes, parseScanMessage, serialHash } from "@flaconvault/proof";
import { PUBLIC_VERIFY_URL } from "./config";
import { ApiError, apiError } from "./errors";
import type { VerifyResponse } from "./flacon";

/** Abort a hung request (AbortSignal.timeout is missing on older Safari: no timeout there). */
const timeout = (ms: number): AbortSignal | undefined => (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined);
async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: timeout(30_000) });
  if (!r.ok) throw await apiError(path, r);
  return r.json() as Promise<T>;
}
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { headers: { accept: "application/json" }, cache: "no-store", signal: timeout(15_000) });
  if (!r.ok) throw await apiError(path, r);
  return r.json() as Promise<T>;
}
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
/** Retries of one /api/events post, and the pause before each (see eventRetryDelay). */
export const EVENT_RETRIES = 5;
const EVENT_RETRY_MS = 2500, BUSY_RETRY_MS = 2000, MAX_RETRY_WAIT_S = 5;
/**
 * How long to wait before posting an event again, or null to give up. Retried, at most EVENT_RETRIES times:
 *   503 tx_not_visible — the verifier's RPC has not seen the transaction yet;
 *   503 busy           — all of the verifier's transaction lookups are in use (global); waits its Retry-After when
 *                        readable (at most 5 s), else 2 s;
 *   429 rate_limited   — only with a readable Retry-After of at most 5 s: this connection's own confirmations still
 *                        running (the per-minute request budget says to wait longer, and is not hammered).
 */
export function eventRetryDelay(e: unknown, attempt: number): number | null {
  if (attempt >= EVENT_RETRIES || !(e instanceof ApiError)) return null;
  const after = e.retryAfter;
  if (e.status === 503 && e.code === "tx_not_visible") return EVENT_RETRY_MS;
  if (e.status === 503 && e.code === "busy") return after != null && after > 0 ? Math.min(after, MAX_RETRY_WAIT_S) * 1000 : BUSY_RETRY_MS;
  if (e.status === 429 && e.code === "rate_limited" && after != null && after > 0 && after <= MAX_RETRY_WAIT_S) return after * 1000;
  return null;
}

export interface Session { nonce: string; expiresAt: number; ttl: number; issuedAt?: number }
export interface SimTag { uid: string; serial: string | null; kind: number | null; counter: number; alive: boolean }
export interface TapResult { responds: boolean; uid: string; ctr?: number; ctrHex?: string; cmac?: string; url: string | null; tapId?: number }
/** `sealDead` is null when the chip is not attached to any seal. */
export interface Preview { verdict: string; counter: number | null; serial: string | null; serialHash: string | null; uidHash: string | null; sealKind: number | null; sealDead: boolean | null }
/** `uid` is only returned for UNREGISTERED taps (null otherwise). */
export interface TapView extends Preview { tapId: number; ts: number; uid: string | null; message: string }
/**
 * /api/verify answer. For a VALID scan it also carries `resumeToken`: together with `eventId` it lets the wallet
 * app's browser fetch this signed scan again (GET /api/verify/{eventId}?token=…) while it is pending.
 */
export type VerifyResult = VerifyResponse & { resumeToken?: string | null };
/** GET /health. `build` is the deployed commit (when the platform reports it), `arweave` the archiving status. */
export interface Health {
  ok: boolean; keyId: number; pubkeyHex: string; simulator: boolean; programId: string | null;
  build?: string | null;
  arweave?: { enabled: boolean; ok: boolean | null; problem: string | null; lastErrorCode: string | null } | null;
}

export const api = {
  health: () => get<Health>("/health"),
  session: () => post<Session>("/api/session", {}),
  simTags: () => get<SimTag[]>("/api/dev/tags"),
  simNewTag: (kind: number) => post<SimTag>("/api/dev/tag", { kind }),
  tap: (id: number | string) => get<TapView>(`/api/tap/${encodeURIComponent(String(id))}`),
  simTap: (uid: string) => post<TapResult>("/api/dev/tap", { uid }),
  /**
   * Wipe the simulator database and load the demo seed again. The verifier always wants its FV_ADMIN_TOKEN as
   * `x-admin-token` (403 "admin token required" without it, also on a local simulator). The caller keeps the token in
   * memory only; it is never stored in the browser.
   */
  simReset: (adminToken: string) => post<{ ok: boolean; seeded: Record<string, unknown> }>("/api/dev/reset", {}, { "x-admin-token": adminToken.trim() }),
  preview: (t: TagParams) => post<Preview>("/api/preview", { uid: t.uid || undefined, ctr: t.ctr || undefined, cmac: t.cmac, piccData: t.piccData, enc: t.enc }),
  verify: (body: Record<string, unknown>) => post<VerifyResult>("/api/verify", body),
  /** Brand and name of a passport, for the anchor step (the full passport view; only these fields are used). */
  passport: (serial: string) => get<{ serial: string; brand: string; name: string }>(`/api/passport/${encodeURIComponent(serial)}`),
  /** The pending signed scan behind a resume link (404 resume_not_found once it is anchored or failed, or for a wrong token). */
  resume: (eventId: number, token: string) => get<VerifyResult>(`/api/verify/${encodeURIComponent(String(eventId))}?token=${encodeURIComponent(token)}`),
  /**
   * Chain-backed events need `txSig` and `actor`. The server stamps the time itself, so `ts` is never sent.
   * Retries while the server's RPC has not seen the transaction yet or its lookups are busy (eventRetryDelay).
   * `wait` is the pause between attempts (tests pass a fast one).
   */
  async events(body: Record<string, unknown>, wait: (ms: number) => Promise<void> = sleep): Promise<Record<string, unknown>> {
    const clean: Record<string, unknown> = { ...body };
    delete clean.ts;
    for (let attempt = 0; ; attempt++) {
      try {
        return await post<Record<string, unknown>>("/api/events", clean);
      } catch (e) {
        const delay = eventRetryDelay(e, attempt);
        if (delay == null) throw e;
        await wait(delay);
      }
    }
  },
  /** Card photos for a tier ≥ 2 scan. The verifier accepts them only with the current, unused session nonce. */
  async media(blobs: Blob[], nonce: string): Promise<{ sha256: string; ar: string | null; bytes: number }> {
    const fd = new FormData();
    fd.append("nonce", nonce);
    blobs.forEach((b, i) => fd.append("files", b, `frame-${i}.jpg`));
    const r = await fetch(`${PUBLIC_VERIFY_URL}/api/media`, { method: "POST", body: fd, signal: timeout(120_000) });
    if (!r.ok) throw await apiError("/api/media", r);
    return r.json();
  },
};

/** Card photos the verifier holds for one session nonce: their hash as computed here and as the server stored it. */
export interface UploadedMedia { nonce: string; mediaHash: string; sha256: string }
const sameHex = (a: string, b: string) => a.replace(/^0x/i, "").toLowerCase() === b.replace(/^0x/i, "").toLowerCase();
/**
 * The upload of `frames` for the session `nonce`. The verifier stages uploads per nonce and keeps them only when a
 * VALID /api/verify consumes that nonce with their hash (at most 6 files per nonce), so an earlier upload is reused
 * only for the same nonce AND the same frames: a retried "Get signature" does not upload again, while a new session
 * (new nonce) always uploads again — the signed scan must never reference photos the server dropped.
 */
export async function uploadMediaOnce(
  cached: UploadedMedia | null, nonce: string, frames: { blobs: Blob[]; mediaHash: string },
  upload: (blobs: Blob[], nonce: string) => Promise<{ sha256: string }> = api.media,
): Promise<UploadedMedia> {
  if (cached && sameHex(cached.nonce, nonce) && sameHex(cached.mediaHash, frames.mediaHash)) return cached;
  const m = await upload(frames.blobs, nonce);
  if (!sameHex(m.sha256, frames.mediaHash)) throw new Error("The server computed a different hash for the photos. Photograph the card again.");
  return { nonce, mediaHash: frames.mediaHash, sha256: m.sha256 };
}

export interface VerifyInput {
  tag: TagParams & { source: "nfc" | "simulator"; tapId?: number; tapToken?: string };
  nonce: string; role: number; tier: number;
  /** the combined card reading, or null without a (recognised) photo */
  reading: { heat: number; humidity: number; uv: number; heatLevels: number[] } | null;
  fill: number; mediaHash?: string; serial?: string | null;
  country?: string; city?: string; attester: string | null; platform: string;
}
const MISSING = 3, decidedHeat = (h: number) => h === 0 || h === 1;
/**
 * POST /api/verify body. Never carries `tamper`: the verifier always signs tamper UNKNOWN (NTAG 424 DNA has no tamper
 * loop). heatLevels go along only for a decided heat reading (INTACT/TRIGGERED), else six zeros.
 */
export function verifyBody(i: VerifyInput): Record<string, unknown> {
  const adopted = i.tag.tapId != null;
  const r = i.reading;
  return {
    uid: adopted ? undefined : i.tag.uid || undefined, ctr: adopted ? undefined : i.tag.ctr || undefined, cmac: adopted ? undefined : i.tag.cmac,
    piccData: i.tag.piccData, enc: i.tag.enc,
    tapId: i.tag.tapId, tapToken: adopted ? i.tag.tapToken : undefined, nonce: i.nonce, role: i.role, tier: i.tier,
    indicators: { heat: r ? r.heat : MISSING, humidity: r ? r.humidity : MISSING, uv: r ? r.uv : MISSING },
    heatLevels: r && decidedHeat(r.heat) ? r.heatLevels.slice(0, 6) : [0, 0, 0, 0, 0, 0],
    fill: i.fill, mediaHash: i.mediaHash,
    serial: i.serial ?? undefined, location: { country: i.country || null, city: i.city?.trim() || null },
    attester: i.attester, platform: i.tag.source === "simulator" ? "SIMULATOR" : i.platform,
  };
}

/** Attester, tier and role the server signed this scan for (bundle.attester); nulls when absent. */
export function signedAttester(v: Pick<VerifyResponse, "bundle"> | null): { pubkey: string | null; tier: number | null; role: number | null } {
  const a = (v?.bundle?.attester ?? null) as { pubkey?: unknown; tier?: unknown; role?: unknown } | null;
  return {
    pubkey: typeof a?.pubkey === "string" && a.pubkey ? a.pubkey : null,
    tier: typeof a?.tier === "number" ? a.tier : null,
    role: typeof a?.role === "number" ? a.role : null,
  };
}
/**
 * The scan was requested for one wallet (connected at "Get signature") and must be anchored by that wallet: the
 * server binds the confirmation to it. Returns the wallet it was signed for when another one is connected now.
 */
export function attesterMismatch(v: Pick<VerifyResponse, "bundle"> | null, connected: string): string | null {
  const signedFor = signedAttester(v).pubkey;
  return signedFor && signedFor !== connected ? signedFor : null;
}

/** What the server signed, as the anchor step shows it before the wallet signs. */
export interface SignedScanSummary {
  /** the passport serial, only when it is the one the signed message commits to (its hash) */
  serial: string | null;
  counter: number; heat: number; humidity: number; uv: number; fill: number;
  /** the message commits to card photos (non-zero media hash) */
  photos: boolean;
  /** "city, country" as typed for the public record, or null */
  place: string | null;
}
/**
 * Read from the signed 152-byte message itself — exactly what record_scan anchors — rather than from the response's
 * other fields; the place comes from the signed bundle. null when there is no readable message.
 */
export function signedScanSummary(v: Pick<VerifyResponse, "msgHex" | "serial" | "bundle"> | null): SignedScanSummary | null {
  if (!v?.msgHex) return null;
  let m: ReturnType<typeof parseScanMessage>;
  try { m = parseScanMessage(hexToBytes(v.msgHex)); } catch { return null; }
  const serial = v.serial && bytesEqual(serialHash(v.serial), m.serialHash) ? v.serial : null;
  const loc = (v.bundle?.location ?? null) as { country?: unknown; city?: unknown } | null;
  const place = [loc?.city, loc?.country].filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).join(", ") || null;
  return { serial, counter: m.counter, heat: m.heat, humidity: m.hum, uv: m.uv, fill: m.fill, photos: !bytesEqual(m.mediaHash, ZERO32), place };
}

/** Parse uid/ctr/cmac out of a SUN URL (tag or simulator). */
export interface TagParams { uid: string; ctr: string; cmac: string; piccData?: string; enc?: string }
export function parseTagUrl(url: string): TagParams | null {
  try {
    const u = new URL(url);
    const piccData = u.searchParams.get("picc_data"), enc = u.searchParams.get("enc"), cmacEnc = u.searchParams.get("cmac");
    if (piccData && cmacEnc) return { uid: "", ctr: "", cmac: cmacEnc.toUpperCase(), piccData: piccData.toUpperCase(), enc: enc?.toUpperCase() };
    let uid = u.searchParams.get("uid"), ctr = u.searchParams.get("ctr"), cmac = u.searchParams.get("cmac");
    const tw = /^([0-9a-f]{14})x([0-9a-f]{6})x([0-9a-f]{16})$/i.exec(uid ?? ""); // NXP TagWriter: uid=<UID>x<CTR>x<MAC>
    if (tw) { uid = tw[1]; ctr = tw[2]; cmac = tw[3]; }
    return uid && ctr && cmac ? { uid: uid.toUpperCase(), ctr: ctr.toUpperCase(), cmac: cmac.toUpperCase() } : null;
  } catch { return null; }
}
export async function sha256Hex(parts: ArrayBuffer[]): Promise<string> {
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const buf = new Uint8Array(total); let o = 0;
  for (const p of parts) { buf.set(new Uint8Array(p), o); o += p.byteLength; }
  const d = await crypto.subtle.digest("SHA-256", buf);
  return "0x" + Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
