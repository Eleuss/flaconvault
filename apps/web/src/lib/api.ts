import { VERIFY_URL } from "./config";

export type Hex32 = string;
export interface PassportSeal { uidHash: Hex32; kind: number; lastCounter: number; dead: boolean; attachedAt: number }
export interface PassportLatest {
  tamper: number; indicators: { heat: number; humidity: number; uv: number };
  heatLevels: number[]; fill: number; counter: number; ts: number; reviewRecommended: boolean;
}
export interface PassportEvent {
  id: number; type: number; ts: number; actor: string | null; actorLabel: string | null;
  txSig: string | null; status: "pending" | "confirmed" | "failed"; sealUidHash: Hex32 | null;
  payload: Record<string, unknown>; arBundle: string | null; arMedia: string | null;
  gradeAfter: number | null; location: { country: string | null; city: string | null } | null;
}
export interface Passport {
  serial: string; serialHash: Hex32; brand: string; name: string; batch: string;
  asset: string | null; issuer: string | null; issuerLabel: string | null;
  grade: number; void: boolean; createdAt: number;
  seals: PassportSeal[]; sealStatus: "INTACT" | "NO_RESPONSE" | "OPENED";
  stats: { scanCount: number; attesterCount: number; certifiedCount: number; counter: number };
  latest: PassportLatest | null; events: PassportEvent[];
}
export interface PassportListItem { serial: string; brand: string; name: string; grade: number; void: boolean; scanCount: number; lastEventTs: number | null }
export interface Tap {
  tapId: number; verdict: string; counter: number | null; serial: string | null; serialHash: Hex32 | null;
  uidHash: Hex32 | null; sealKind: number | null; sealDead: boolean; message: string; ts?: number;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${VERIFY_URL}${path}`, { cache: "no-store", headers: { accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as T;
  } catch (e) {
    console.error(`[api] ${path}:`, (e as Error).message);
    return null;
  }
}
export const getPassport = (serial: string) => get<Passport>(`/api/passport/${encodeURIComponent(serial)}`);
export const getPassports = () => get<PassportListItem[]>(`/api/passports`);
export const getTap = (id: string) => get<Tap>(`/api/tap/${encodeURIComponent(id)}`);
export const getHealth = () => get<{ ok: boolean; keyId: number; pubkeyHex: string; simulator: boolean; programId: string | null }>(`/health`);
