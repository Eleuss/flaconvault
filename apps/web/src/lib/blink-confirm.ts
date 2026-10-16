/**
 * Pieces of the Blink confirm callback (app/api/actions/verify-buy/confirm) that decide what an anonymous request may
 * cost: a per-client token bucket, a check that the signature really is a landed `reserve` of the order signed by the
 * account, and a time-boxed verifier post that stops on 429. Plain functions so lib/blink-confirm.test.ts can run them.
 */
import type { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

/** In-process token bucket per key (one serverless instance each; good enough to stop a single client flooding it). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly capacity: number, private readonly perMinute: number, private readonly maxKeys = 10_000) {}

  /** Takes one token for `key` at `nowMs`; false when the bucket is empty. */
  take(key: string, nowMs: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: nowMs };
    const refill = ((nowMs - b.at) / 60_000) * this.perMinute;
    b.tokens = Math.min(this.capacity, b.tokens + Math.max(0, refill));
    b.at = nowMs;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) this.buckets.clear(); // bounded memory
    this.buckets.set(key, b);
    return true;
  }
}

/** The client address as the platform proxy reports it: the first hop of X-Forwarded-For, else X-Real-IP. */
export function clientIp(headers: { get(name: string): string | null }): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}

const startsWith = (data: Uint8Array, prefix: Uint8Array | number[]) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);

/**
 * True when `tx` succeeded and carries an escrow `reserve` instruction (by Anchor discriminator) whose order account is
 * `order` and whose buyer account is `buyer`, and `buyer` signed the transaction. Account positions come from the IDL.
 */
export function isReserveOf(
  tx: Pick<VersionedTransactionResponse, "meta" | "transaction"> | null,
  o: { programId: PublicKey; order: PublicKey; buyer: PublicKey; discriminator: Uint8Array | number[]; orderIndex: number; buyerIndex: number },
): boolean {
  if (!tx || !tx.meta || tx.meta.err) return false;
  const msg = tx.transaction.message;
  const keys = msg.version === 0 ? msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }) : msg.getAccountKeys();
  let signed = false;
  for (let i = 0; i < msg.header.numRequiredSignatures; i++) if (keys.get(i)?.equals(o.buyer)) signed = true;
  if (!signed) return false;
  return msg.compiledInstructions.some((ix) =>
    !!keys.get(ix.programIdIndex)?.equals(o.programId)
    && startsWith(ix.data, o.discriminator)
    && !!keys.get(ix.accountKeyIndexes[o.orderIndex])?.equals(o.order)
    && !!keys.get(ix.accountKeyIndexes[o.buyerIndex])?.equals(o.buyer));
}

export type PostOutcome = "ok" | "rate_limited" | "failed" | "timeout";

/**
 * Posts until it succeeds, retrying only 503 (tx_not_visible: the verifier's RPC has not seen the transaction yet)
 * while another attempt still fits before `deadlineMs`. A 429 ends at once (retrying would only use up the shared
 * per-IP budget of the web server further), as does any other error status.
 */
export async function postUntil(
  post: () => Promise<{ ok: boolean; status: number }>,
  o: { deadlineMs: number; retryDelayMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<PostOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    if (now() >= o.deadlineMs) return "timeout";
    const r = await post();
    if (r.ok) return "ok";
    if (r.status === 429) return "rate_limited";
    if (r.status !== 503) return "failed";
    if (now() + o.retryDelayMs >= o.deadlineMs) return "timeout";
    await sleep(o.retryDelayMs);
  }
}
