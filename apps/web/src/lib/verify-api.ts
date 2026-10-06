"use client";
import { PUBLIC_VERIFY_URL } from "./config";
import type { VerifyResponse } from "./flacon";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export interface Session { nonce: string; expiresAt: number; ttl: number; issuedAt?: number }
export interface SimTag { uid: string; serial: string | null; kind: number | null; counter: number; alive: boolean }
export interface TapResult { responds: boolean; uid: string; ctr?: number; ctrHex?: string; cmac?: string; url: string | null; tapId?: number }
export interface Preview { verdict: string; counter: number | null; serial: string | null; serialHash: string | null; uidHash: string | null; sealKind: number | null; sealDead: boolean }

export const api = {
  session: () => post<Session>("/api/session", {}),
  simTags: () => get<SimTag[]>("/api/dev/tags"),
  simTap: (uid: string) => post<TapResult>("/api/dev/tap", { uid }),
  preview: (t: TagParams) => post<Preview>("/api/preview", { uid: t.uid || undefined, ctr: t.ctr || undefined, cmac: t.cmac, piccData: t.piccData, enc: t.enc }),
  verify: (body: Record<string, unknown>) => post<VerifyResponse>("/api/verify", body),
  events: (body: Record<string, unknown>) => post<Record<string, unknown>>("/api/events", body),
  async media(blobs: Blob[]): Promise<{ sha256: string; ar: string | null; bytes: number }> {
    const fd = new FormData();
    blobs.forEach((b, i) => fd.append("files", b, `frame-${i}.jpg`));
    const r = await fetch(`${PUBLIC_VERIFY_URL}/api/media`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(`/api/media: ${r.status} ${(await r.text()).slice(0, 200)}`);
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
