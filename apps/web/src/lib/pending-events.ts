/**
 * Escrow transactions that landed on chain but whose history entry (POST /api/events) has not reached the verifier yet.
 * Kept per order in this browser's localStorage under `fv.pendingEvent.<orderPda>` (listed on /privacy), as a list
 * keyed by signature, so a second landed action never overwrites an earlier unposted one, and a reload or a later
 * visit can still offer "Retry confirmation". The market page stores its LIST here too, so the order page can retry it.
 */
export interface PendingEvent { sig: string; type: number; payload: Record<string, unknown> }

/** The subset of Storage these helpers use (tests pass a Map-backed fake). */
export interface KeyValue { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export const pendingKey = (order: string) => `fv.pendingEvent.${order}`;

const browserStorage = (): KeyValue | null => {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
};
const isPending = (v: unknown): v is PendingEvent => {
  const p = v as PendingEvent;
  return !!p && typeof p.sig === "string" && p.sig.length > 0 && typeof p.type === "number" && !!p.payload && typeof p.payload === "object";
};

/** What is stored: a list, or a single object written by an older build. Anything malformed is dropped. */
export function parsePending(raw: string | null): PendingEvent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return (Array.isArray(v) ? v : [v]).filter(isPending);
  } catch { return []; }
}

/** `p` added, or replacing the entry with the same signature (oldest first otherwise). */
export const withPending = (list: PendingEvent[], p: PendingEvent): PendingEvent[] =>
  list.some((x) => x.sig === p.sig) ? list.map((x) => (x.sig === p.sig ? p : x)) : [...list, p];
export const withoutPending = (list: PendingEvent[], sig: string): PendingEvent[] => list.filter((x) => x.sig !== sig);

export function loadPending(order: string, kv: KeyValue | null = browserStorage()): PendingEvent[] {
  try { return parsePending(kv?.getItem(pendingKey(order)) ?? null); } catch { return []; }
}
export function savePending(order: string, list: PendingEvent[], kv: KeyValue | null = browserStorage()): void {
  try {
    if (!kv) return;
    if (list.length) kv.setItem(pendingKey(order), JSON.stringify(list));
    else kv.removeItem(pendingKey(order));
  } catch { /* storage full or blocked: the entry lives in memory only */ }
}
/** Adds (or replaces) one entry in storage and returns the new list. */
export function rememberPending(order: string, p: PendingEvent, kv: KeyValue | null = browserStorage()): PendingEvent[] {
  const list = withPending(loadPending(order, kv), p);
  savePending(order, list, kv);
  return list;
}
/** Removes one entry from storage (it reached the verifier) and returns the remaining list. */
export function forgetPending(order: string, sig: string, kv: KeyValue | null = browserStorage()): PendingEvent[] {
  const list = withoutPending(loadPending(order, kv), sig);
  savePending(order, list, kv);
  return list;
}

/**
 * Posts every pending entry, oldest first, each on its own: one that keeps failing does not hold back the others.
 * `post` throws on failure; `isSettled(e)` says that an error means the entry is moot (for example the verifier already
 * holds this event with another transaction) and it is dropped. Returns what is left and the first error.
 */
export async function flushPending(
  list: PendingEvent[], post: (p: PendingEvent) => Promise<void>, isSettled: (e: unknown) => boolean = () => false,
): Promise<{ left: PendingEvent[]; error: unknown }> {
  let left = list;
  let error: unknown = null;
  for (const p of list) {
    try { await post(p); left = withoutPending(left, p.sig); }
    catch (e) { if (isSettled(e)) left = withoutPending(left, p.sig); else if (error === null) error = e; }
  }
  return { left, error };
}
