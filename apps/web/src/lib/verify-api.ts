"use client";
import { PUBLIC_VERIFY_URL } from "./config";
import { ApiError, apiError } from "./errors";
import type { VerifyResponse } from "./flacon";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw await apiError(path, r);
  return r.json() as Promise<T>;
}
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw await apiError(path, r);
  return r.json() as Promise<T>;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** /api/events answers 503 "tx_not_visible" while its RPC has not seen the transaction yet. */
const EVENT_RETRIES = 5, EVENT_RETRY_MS = 2500;

export interface Session { nonce: string; expiresAt: number; ttl: number; issuedAt?: number }
export interface SimTag { uid: string; serial: string | null; kind: number | null; counter: number; alive: boolean }
export interface TapResult { responds: boolean; uid: string; ctr?: number; ctrHex?: string; cmac?: string; url: string | null; tapId?: number }
export interface Preview { verdict: string; counter: number | null; serial: string | null; serialHash: string | null; uidHash: string | null; sealKind: number | null; sealDead: boolean }
/** `uid` is only returned for UNREGISTERED taps (null otherwise). */
export interface TapView extends Preview { tapId: number; ts: number; uid: string | null; message: string }
export interface Health { ok: boolean; keyId: number; pubkeyHex: string; simulator: boolean; programId: string | null }

export const api = {
  health: () => get<Health>("/health"),
  session: () => post<Session>("/api/session", {}),
  simTags: () => get<SimTag[]>("/api/dev/tags"),
  simNewTag: (kind: number) => post<SimTag>("/api/dev/tag", { kind }),
  tap: (id: number | string) => get<TapView>(`/api/tap/${encodeURIComponent(String(id))}`),
  simTap: (uid: string) => post<TapResult>("/api/dev/tap", { uid }),
  preview: (t: TagParams) => post<Preview>("/api/preview", { uid: t.uid || undefined, ctr: t.ctr || undefined, cmac: t.cmac, piccData: t.piccData, enc: t.enc }),
  verify: (body: Record<string, unknown>) => post<VerifyResponse>("/api/verify", body),
  /**
   * Chain-backed events need `txSig` and `actor`. The server stamps the time itself, so `ts` is never sent.
   * Retries while the server's RPC has not seen the transaction yet (503 "tx_not_visible").
   */
  async events(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const clean: Record<string, unknown> = { ...body };
    delete clean.ts;
    for (let attempt = 0; ; attempt++) {
      try {
        return await post<Record<string, unknown>>("/api/events", clean);
      } catch (e) {
        if (attempt < EVENT_RETRIES && e instanceof ApiError && e.status === 503 && e.code === "tx_not_visible") { await sleep(EVENT_RETRY_MS); continue; }
        throw e;
      }
    }
  },
  async media(blobs: Blob[]): Promise<{ sha256: string; ar: string | null; bytes: number }> {
    const fd = new FormData();
    blobs.forEach((b, i) => fd.append("files", b, `frame-${i}.jpg`));
    const r = await fetch(`${PUBLIC_VERIFY_URL}/api/media`, { method: "POST", body: fd });
    if (!r.ok) throw await apiError("/api/media", r);
    return r.json();
  },
};

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
