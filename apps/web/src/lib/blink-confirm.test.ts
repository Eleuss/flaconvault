import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { RateLimiter, clientIp, isReserveOf, postUntil } from "./blink-confirm";

const PROGRAM = Keypair.generate().publicKey;
const order = Keypair.generate().publicKey;
const buyer = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const DISC = [126, 167, 72, 241, 141, 215, 128, 44];
const RESERVE = { programId: PROGRAM, order, buyer, discriminator: DISC, orderIndex: 1, buyerIndex: 2 };

/** A landed transaction as getTransaction returns it: one escrow instruction with the given accounts and data. */
function landed(o: { payer?: PublicKey; accounts?: PublicKey[]; data?: number[]; program?: PublicKey; err?: unknown } = {}): VersionedTransactionResponse {
  const payer = o.payer ?? buyer;
  const keys = (o.accounts ?? [Keypair.generate().publicKey, order, buyer]).map((pubkey) => ({ pubkey, isSigner: pubkey.equals(payer), isWritable: true }));
  const ix = new TransactionInstruction({ programId: o.program ?? PROGRAM, keys, data: Buffer.from(o.data ?? [...DISC, 1, 2, 3]) });
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
  return { slot: 1, blockTime: null, transaction: new VersionedTransaction(message), meta: { err: o.err ?? null, fee: 5000, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] } } } as unknown as VersionedTransactionResponse;
}

test("only a landed reserve of this order, signed by the account, counts (A9)", () => {
  assert.equal(isReserveOf(landed(), RESERVE), true);
  assert.equal(isReserveOf(null, RESERVE), false);
  assert.equal(isReserveOf(landed({ err: { InstructionError: [0, { Custom: 1 }] } }), RESERVE), false, "failed transaction");
  assert.equal(isReserveOf(landed({ data: [1, 2, 3, 4, 5, 6, 7, 8] }), RESERVE), false, "another instruction");
  assert.equal(isReserveOf(landed({ program: Keypair.generate().publicKey }), RESERVE), false, "another program");
  assert.equal(isReserveOf(landed({ accounts: [Keypair.generate().publicKey, Keypair.generate().publicKey, buyer] }), RESERVE), false, "another order");
  // the order key elsewhere in the instruction is not enough
  assert.equal(isReserveOf(landed({ accounts: [order, Keypair.generate().publicKey, buyer] }), RESERVE), false, "order at the wrong position");
  // a reserve by someone else, reported with the caller's account
  assert.equal(isReserveOf(landed({ payer: stranger, accounts: [Keypair.generate().publicKey, order, buyer] }), RESERVE), false, "buyer did not sign");
  assert.equal(isReserveOf(landed({ payer: stranger, accounts: [Keypair.generate().publicKey, order, stranger] }), RESERVE), false, "other buyer");
});

test("the rate limiter allows a burst per client, then refills over time", () => {
  const l = new RateLimiter(3, 3);
  const t = 1_000_000;
  assert.deepEqual([l.take("a", t), l.take("a", t), l.take("a", t), l.take("a", t)], [true, true, true, false]);
  assert.equal(l.take("b", t), true, "other clients have their own bucket");
  assert.equal(l.take("a", t + 10_000), false, "half a token after 10 s");
  assert.equal(l.take("a", t + 20_000), true, "one token after 20 s at 3/min");
  const small = new RateLimiter(1, 1, 2);
  small.take("x", t); small.take("y", t); small.take("z", t);
  assert.equal(small.take("z", t), false);
});

test("the client address is the first X-Forwarded-For hop", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
  assert.equal(clientIp(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(h({ "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(h({})), "unknown");
});

test("verifier posts: 503 is retried within the time budget, 429 and other errors end at once", async () => {
  let clock = 0;
  const run = async (statuses: number[], deadlineMs = 10_000) => {
    clock = 0;
    const seen: number[] = [];
    const outcome = await postUntil(async () => { const s = statuses[Math.min(seen.length, statuses.length - 1)]; seen.push(s); return { ok: s === 200, status: s }; },
      { deadlineMs, retryDelayMs: 1_500, now: () => clock, sleep: async (ms) => { clock += ms; } });
    return { outcome, calls: seen.length };
  };
  assert.deepEqual(await run([503, 503, 200]), { outcome: "ok", calls: 3 });
  assert.deepEqual(await run([429, 200]), { outcome: "rate_limited", calls: 1 });
  assert.deepEqual(await run([403]), { outcome: "failed", calls: 1 });
  // 503 forever: stops before the budget runs out (10 s / 1.5 s → at most 7 calls)
  const forever = await run([503]);
  assert.equal(forever.outcome, "timeout");
  assert.ok(forever.calls <= 7 && clock < 10_000, `calls ${forever.calls}, clock ${clock}`);
  assert.deepEqual(await run([200], 0), { outcome: "timeout", calls: 0 });
});
