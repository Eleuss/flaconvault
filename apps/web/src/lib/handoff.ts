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

export interface ScanSessionFlag { nonce: string; expiresAt: number }
export interface TapHandoff extends TagParams { ts: number }
export interface LastTap { uid: string; serial: string | null; counter: number | null; ts: number }

export const scanSession = {
  set: (s: ScanSessionFlag) => write(K_SESSION, s),
  clear: () => drop(K_SESSION),
  active: (): ScanSessionFlag | null => { const s = read<ScanSessionFlag>(K_SESSION); return s && s.expiresAt > Date.now() / 1000 ? s : null; },
};
export const tapHandoff = {
  set: (t: TagParams) => write(K_HANDOFF, { ...t, ts: Date.now() } satisfies TapHandoff),
  take: (): TapHandoff | null => { const t = read<TapHandoff>(K_HANDOFF); if (!t) return null; drop(K_HANDOFF); return Date.now() - t.ts < 3 * 60 * 1000 ? t : null; },
  key: K_HANDOFF,
};
export const lastTap = {
  set: (t: Omit<LastTap, "ts">) => write(K_LAST, { ...t, ts: Date.now() }),
  get: (): LastTap | null => { const t = read<LastTap>(K_LAST); return t && Date.now() - t.ts < 60 * 60 * 1000 ? t : null; },
};
