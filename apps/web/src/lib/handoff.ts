"use client";
/**
 * iPhone path (no WebNFC): a tap opens /t in Safari; if a scan session is running in this browser,
 * /t stores the tap here instead of consuming it and the /scan tab picks it up. /t also remembers the
 * last verified chip UID so /certify can take it over.
 *
 * Time: the verifier's timestamps (expiresAt, issuedAt, tap ts) are server clock. They are never compared with the
 * device clock directly; a session keeps a local `deadline` and the `offset` server − device measured on arrival.
 */
import type { TagParams } from "./verify-api";

const K_SESSION = "fv.scanSession", K_HANDOFF = "fv.tapHandoff", K_LAST = "fv.lastTap", K_CLAIM = "fv.tapHandoffClaim";
/** sessionStorage (per tab): the nonce of the scan session this tab started. */
const K_OWNER = "fv.scanOwner";
const read = <T,>(k: string, store: () => Storage = () => localStorage): T | null => { try { const v = store().getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (k: string, v: unknown, store: () => Storage = () => localStorage) => { try { store().setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const drop = (k: string, store: () => Storage = () => localStorage) => { try { store().removeItem(k); } catch { /* ignore */ } };
const tabStore = () => sessionStorage;
const nowS = () => Date.now() / 1000;

/** The server's adoption window for a tap /t already verified (apps/verify service.adopt_tap: now − tap.ts ≤ 180 s). */
export const ADOPT_WINDOW_S = 180;
/** Safety margins: request latency on arrival, and the time the final /api/verify needs to reach the server. */
const ARRIVAL_MARGIN_S = 2, ADOPT_MARGIN_S = 10;

export interface SessionClock {
  /** device clock (unix s) after which the session must be treated as expired */
  deadline: number;
  /** server clock − device clock (s), measured when the session arrived */
  offset: number;
}
/** Local deadline + clock offset for a session that has just arrived from POST /api/session. */
export function sessionClock(s: { expiresAt: number; ttl?: number; issuedAt?: number }, deviceNow = nowS()): SessionClock {
  const ttl = s.ttl ?? (s.issuedAt != null ? s.expiresAt - s.issuedAt : 90);
  const issued = s.issuedAt ?? s.expiresAt - ttl;
  return { deadline: deviceNow + ttl - ARRIVAL_MARGIN_S, offset: issued - deviceNow };
}
/** Device-clock deadline for an adopted tap: the session deadline or the server's 180 s tap window, whichever comes first. */
export function adoptDeadline(tapServerTs: number, clock: SessionClock): { deadline: number; limitedBy: "session" | "tap" } {
  const tapDeadline = tapServerTs + ADOPT_WINDOW_S - ADOPT_MARGIN_S - clock.offset;
  return tapDeadline < clock.deadline ? { deadline: tapDeadline, limitedBy: "tap" } : { deadline: clock.deadline, limitedBy: "session" };
}
export const secondsLeft = (deadline: number, deviceNow = nowS()) => Math.max(0, Math.round(deadline - deviceNow));

/** Only same-origin /scan URLs are ever redirected to (the stored value comes from localStorage). */
export function safeScanUrl(u: string | null | undefined): string {
  return typeof u === "string" && /^\/scan(\?[^#\s]*)?$/.test(u) ? u : "/scan";
}
/** /scan URL that keeps tier, role and site (never the one-shot adopt / k / resume parameters). */
export function scanUrlFor(params: { get(k: string): string | null }): string {
  const keep = new URLSearchParams();
  for (const key of ["tier", "role", "site"]) { const v = params.get(key); if (v != null && /^\d{1,5}$/.test(v)) keep.set(key, v); }
  const q = keep.toString();
  return q ? `/scan?${q}` : "/scan";
}

/** What /t does with raw tag parameters (TapGate). */
export type TapGateAction = { kind: "handoff"; back: string | null } | { kind: "verify"; url: string };
/**
 * /t received raw tag parameters. With a scan session running in this browser the tap is handed over to it: only the
 * tab that started the session goes back to its own scan page (`back`, keeping tier/role/site); any other tab stays
 * (`back` null) and asks the user to return to the scan tab, because a second /scan on the same session would only
 * fail with "session expired". Without a session the verifier consumes the tap (`url`).
 */
export function tapGateAction(params: TagParams, session: ScanSessionFlag | null, ownedHere: boolean, verifyUrl: string): TapGateAction {
  if (session) return { kind: "handoff", back: ownedHere ? safeScanUrl(session.scanUrl) : null };
  const q = params.piccData
    ? `picc_data=${encodeURIComponent(params.piccData)}&cmac=${encodeURIComponent(params.cmac)}${params.enc ? `&enc=${encodeURIComponent(params.enc)}` : ""}`
    : `uid=${encodeURIComponent(params.uid)}&ctr=${encodeURIComponent(params.ctr)}&cmac=${encodeURIComponent(params.cmac)}`;
  return { kind: "verify", url: `${verifyUrl}/t?${q}` };
}

export interface ScanSessionFlag extends SessionClock { nonce: string; expiresAt: number; ttl?: number; issuedAt?: number; scanUrl?: string }
export interface TapHandoff extends TagParams { ts: number; id?: string }
/** `uid` can be null: the verifier only reveals the chip UID for UNREGISTERED taps. */
export interface LastTap { uid: string | null; serial: string | null; counter: number | null; ts: number }

export const scanSession = {
  /** Stores the running session for other tabs (localStorage) and marks this tab as its owner (sessionStorage). */
  set: (s: ScanSessionFlag) => { write(K_SESSION, s); write(K_OWNER, s.nonce, tabStore); },
  clear: () => drop(K_SESSION),
  active: (deviceNow = nowS()): ScanSessionFlag | null => {
    const s = read<ScanSessionFlag>(K_SESSION);
    return s && typeof s.deadline === "number" && s.deadline > deviceNow ? s : null;
  },
  /** true when this tab started the session (the scan page lives here, so /t may navigate back to it). */
  ownedHere: (s: Pick<ScanSessionFlag, "nonce">): boolean => read<string>(K_OWNER, tabStore) === s.nonce,
};

const randomId = () => { try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; } };
const fresh = (t: TapHandoff | null) => (t && Date.now() - t.ts < 3 * 60 * 1000 ? t : null);
const macrotask = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Inside a Web Lock: one read, one delete — no other tab can run in between. */
const takeLocked = (): TapHandoff | null => {
  const t = read<TapHandoff>(K_HANDOFF);
  if (!t) return null;
  drop(K_HANDOFF);
  return fresh(t);
};
/**
 * Without Web Locks: claim the handoff by writing this tab's claim id, then re-check in a later task (other tabs'
 * writes become visible between tasks). Only the tab whose claim survived takes the tap.
 */
const takeClaimed = async (settleMs = 60): Promise<TapHandoff | null> => {
  const t = read<TapHandoff>(K_HANDOFF);
  if (!t) return null;
  const me = randomId();
  write(K_CLAIM, { id: t.id, by: me });
  await macrotask(settleMs);
  const claim = read<{ id?: string; by: string }>(K_CLAIM), now = read<TapHandoff>(K_HANDOFF);
  if (!claim || claim.by !== me || !now || now.id !== t.id) return null; // another tab claimed it, or a newer tap replaced it
  drop(K_HANDOFF); drop(K_CLAIM);
  return fresh(t);
};
export const tapHandoff = {
  set: (t: TagParams) => write(K_HANDOFF, { ...t, ts: Date.now(), id: randomId() } satisfies TapHandoff),
  /** Takes the pending handoff, at most once across tabs (Web Locks where available, else a claim + re-check). */
  take: async (): Promise<TapHandoff | null> => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) return takeClaimed();
    try { return await locks.request(K_HANDOFF, () => takeLocked()); } catch { return takeClaimed(); }
  },
  key: K_HANDOFF,
};
export const lastTap = {
  set: (t: Omit<LastTap, "ts">) => write(K_LAST, { ...t, ts: Date.now() }),
  get: (): LastTap | null => { const t = read<LastTap>(K_LAST); return t && Date.now() - t.ts < 60 * 60 * 1000 ? t : null; },
  clear: () => drop(K_LAST),
};
