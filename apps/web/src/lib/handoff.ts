"use client";
/**
 * iPhone path (no WebNFC): a tap opens /t in Safari; if a scan session is running in this browser,
 * /t stores the tap here instead of consuming it and the /scan tab picks it up. /t also remembers the
 * last verified chip UID so /certify can take it over.
 */
import type { TagParams } from "./verify-api";

const K_SESSION = "fv.scanSession", K_HANDOFF = "fv.tapHandoff", K_LAST = "fv.lastTap";
const read = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const drop = (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

export interface ScanSessionFlag { nonce: string; expiresAt: number; ttl?: number; issuedAt?: number }
export interface TapHandoff extends TagParams { ts: number; id?: string }
/** `uid` can be null: the verifier only reveals the chip UID for UNREGISTERED taps. */
export interface LastTap { uid: string | null; serial: string | null; counter: number | null; ts: number }

export const scanSession = {
  set: (s: ScanSessionFlag) => write(K_SESSION, s),
  clear: () => drop(K_SESSION),
  active: (): ScanSessionFlag | null => { const s = read<ScanSessionFlag>(K_SESSION); return s && s.expiresAt > Date.now() / 1000 ? s : null; },
};
const randomId = () => { try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; } };
/** Compare-and-delete: only the handoff that was read (same random id) is removed, and only once. */
const takeOnce = (): TapHandoff | null => {
  const t = read<TapHandoff>(K_HANDOFF);
  if (!t) return null;
  const now = read<TapHandoff>(K_HANDOFF);
  if (!now || now.id !== t.id) return null; // another tab took it, or a newer tap replaced it
  drop(K_HANDOFF);
  return Date.now() - t.ts < 3 * 60 * 1000 ? t : null;
};
export const tapHandoff = {
  set: (t: TagParams) => write(K_HANDOFF, { ...t, ts: Date.now(), id: randomId() } satisfies TapHandoff),
  /** Takes the pending handoff. Serialised across tabs with the Web Locks API where available, so two tabs never both take the same tap. */
  take: async (): Promise<TapHandoff | null> => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) return takeOnce();
    try { return await locks.request(K_HANDOFF, () => takeOnce()); } catch { return takeOnce(); }
  },
  key: K_HANDOFF,
};
export const lastTap = {
  set: (t: Omit<LastTap, "ts">) => write(K_LAST, { ...t, ts: Date.now() }),
  get: (): LastTap | null => { const t = read<LastTap>(K_LAST); return t && Date.now() - t.ts < 60 * 60 * 1000 ? t : null; },
  clear: () => drop(K_LAST),
};
