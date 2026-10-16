/** Server-side reads from the verifier (server components). Client calls live in verify-api.ts. */
import { VERIFY_URL } from "./config";
import type { TapView } from "./verify-api";

export type Hex32 = string;
export interface PassportSeal { uidHash: Hex32; kind: number; lastCounter: number; dead: boolean; attachedAt: number }
export interface PassportLatest {
  tamper: number; indicators: { heat: number; humidity: number; uv: number };
  heatLevels: number[]; fill: number; counter: number; ts: number; reviewRecommended: boolean;
}
export interface PassportEvent {
  id: number; type: number; ts: number; actor: string | null; actorLabel: string | null;
  txSig: string | null; status: "pending" | "confirmed" | "failed" | "reported"; sealUidHash: Hex32 | null;
  payload: Record<string, unknown>; arBundle: string | null; arMedia: string | null;
  gradeAfter: number | null; location: { country: string | null; city: string | null } | null;
}
export interface PassportStats {
  /** confirmed SCAN events (tier-0 sightings included) */
  scanCount: number;
  attesterCount: number;
  certifiedCount: number;
  counter: number;
  /** confirmed SCAN events with a txSig that the program counted in passport.scan_count (absent on older verifiers) */
  onChainScanCount?: number;
}
export interface Passport {
  serial: string; serialHash: Hex32; brand: string; name: string; batch: string;
  asset: string | null; issuer: string | null; issuerLabel: string | null;
  grade: number; void: boolean; createdAt: number;
  seals: PassportSeal[]; sealStatus: "INTACT" | "NO_RESPONSE" | "OPENED";
  stats: PassportStats;
  latest: PassportLatest | null; events: PassportEvent[];
}
export interface PassportListItem { serial: string; brand: string; name: string; grade: number; void: boolean; scanCount: number; lastEventTs: number | null }
export interface Attester {
  pubkey: string; label: string | null; isPartner: boolean; firstSeen: number | null; scanCount: number; certifiedCount: number;
  agreeCount: number; compareCount: number; agreeRate: number | null; escrowsOk: number; escrowsDisputed: number; recentSerials: string[];
}

/**
 * Result of a verifier read: `missing` only for a 404, `error` for anything else (5xx, timeout, network), so a
 * verifier outage never reads as "this passport does not exist".
 */
export type ApiResult<T> = { status: "ok"; data: T } | { status: "missing" } | { status: "error"; error: string };

export const FETCH_TIMEOUT_MS = 8000;

export async function get<T>(path: string, fetchImpl: typeof fetch = fetch, base = VERIFY_URL): Promise<ApiResult<T>> {
  try {
    const r = await fetchImpl(`${base}${path}`, { cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (r.status === 404) return { status: "missing" };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { status: "ok", data: (await r.json()) as T };
  } catch (e) {
    const err = e as Error;
    const error = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err?.message ?? String(e);
    console.error(`[api] ${path}:`, error);
    return { status: "error", error };
  }
}
export const getPassport = (serial: string) => get<Passport>(`/api/passport/${encodeURIComponent(serial)}`);
export const getPassports = () => get<PassportListItem[]>(`/api/passports`);
/** Largest tap id the verifier accepts: 2^63 − 1 (SQLite INTEGER, apps/verify routes_tag MAX_ID). */
const MAX_TAP_ID = "9223372036854775807";
/**
 * A tap id as the verifier issues it: a positive integer without leading zeros, at most 2^63 − 1. Anything else (a
 * truncated or altered /t link) can never resolve: the verifier answers 422, which must not read as an outage.
 */
export function validTapId(id: string | null | undefined): id is string {
  // digit strings of equal length compare like the numbers they spell
  return typeof id === "string" && /^[1-9]\d{0,18}$/.test(id) && (id.length < MAX_TAP_ID.length || id <= MAX_TAP_ID);
}
/** A malformed id is "missing" without asking the verifier (its 422 would otherwise show "server did not answer"). */
export const getTap = (id: string): Promise<ApiResult<TapView>> =>
  validTapId(id) ? get<TapView>(`/api/tap/${encodeURIComponent(id)}`) : Promise.resolve({ status: "missing" });
export const getAttester = (pubkey: string) => get<Attester>(`/api/attester/${encodeURIComponent(pubkey)}`);
export const getHealth = () => get<{ ok: boolean; simulator: boolean }>(`/health`);
