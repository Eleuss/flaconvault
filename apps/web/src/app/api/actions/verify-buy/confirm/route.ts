import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { EventType, serialHash } from "@flaconvault/proof";
import escrowIdl from "@flaconvault/proof/idl/escrow.json";
import { passportPda } from "@/lib/flacon";
import { escrowProgram, escrowProgramId, fetchOrder } from "@/lib/escrow";
import { formatUsdc, isValidSerial } from "@/lib/escrow-rules";
import { RateLimiter, clientIp, isReserveOf, postUntil } from "@/lib/blink-confirm";
import { SOLANA_RPC, VERIFY_URL } from "@/lib/config";
import { ACTIONS_HEADERS, actionJson } from "../headers";

/**
 * Action chaining callback (Solana Actions `links.next`, type "post"): after the wallet sent the reserve transaction the
 * Blink client POSTs `{ account, signature }` here. Anyone can call this URL, and every verifier POST it makes comes
 * from this server's address (one shared rate-limit bucket on the verifier), so it only posts for a signature that is a
 * landed `reserve` of this order signed by `account`, limits each client, stops on the verifier's 429 and gives up
 * after about 9 seconds. The verifier then checks the transaction again and records the RESERVE event.
 */
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: ACTIONS_HEADERS }); }

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** Per client and serverless instance: a Blink buyer needs one call per reservation. */
const limiter = new RateLimiter(10, 10);
const BUDGET_MS = 9_000, TX_LOOKUP_MS = 4_000, RETRY_MS = 1_500;
const reserveIx = (escrowIdl as { instructions: Array<{ name: string; discriminator: number[]; accounts: Array<{ name: string }> }> }).instructions.find((i) => i.name === "reserve")!;
const RESERVE = {
  discriminator: reserveIx.discriminator,
  orderIndex: reserveIx.accounts.findIndex((a) => a.name === "order"),
  buyerIndex: reserveIx.accounts.findIndex((a) => a.name === "buyer"),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** getTransaction until it is visible or `untilMs` passes (the callback can arrive before the RPC indexed the tx). */
async function landedTx(connection: Connection, signature: string, untilMs: number): Promise<VersionedTransactionResponse | null> {
  for (;;) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (tx || Date.now() + 1_000 >= untilMs) return tx;
    await sleep(1_000);
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const origin = req.nextUrl.origin;
  const done = (title: string, description: string) => actionJson({ type: "completed", icon: `${origin}/icon.svg`, title, description, label: "Done" });
  if (!limiter.take(clientIp(req.headers), started)) return actionJson({ message: "Too many requests. Open the order page instead." }, 429);
  try {
    const { account, signature } = (await req.json()) as { account?: string; signature?: string };
    const orderKey = new PublicKey(req.nextUrl.searchParams.get("order") ?? "");
    const actor = new PublicKey(account ?? "");
    if (!signature || !SIG_RE.test(signature)) return actionJson({ message: "Missing transaction signature" }, 400);

    const connection = new Connection(SOLANA_RPC, "confirmed");
    const tx = await landedTx(connection, signature, started + TX_LOOKUP_MS);
    if (!tx) return done("Reservation sent", "The network has not shown the transaction yet. Open the order page to follow the reservation.");
    if (!isReserveOf(tx, { programId: escrowProgramId(), order: orderKey, buyer: actor, ...RESERVE })) {
      return done("No reservation found", "This transaction is not a reservation of this order by this wallet. Nothing was recorded.");
    }

    const order = await fetchOrder(escrowProgram(connection), orderKey);
    if (!order) return actionJson({ message: "Unknown order" }, 400);
    const list = (await fetch(`${VERIFY_URL}/api/passports`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))) as { serial: string }[];
    const serial = list.find((p) => isValidSerial(p.serial) && passportPda(serialHash(p.serial)).equals(order.passport))?.serial;
    const reserved = `Reserved · ${formatUsdc(order.priceBase)} USDC are in the escrow vault.`;
    if (!serial) return done("Reserved", `${reserved} The passport history will catch up later.`);

    const body = JSON.stringify({
      serial, type: EventType.RESERVE, txSig: signature, actor: actor.toBase58(),
      payload: { priceUsdc: Number(formatUsdc(order.priceBase)), currency: "USDC", order: orderKey.toBase58(), via: "blink" },
    });
    const outcome = await postUntil(
      () => fetch(`${VERIFY_URL}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" }),
      { deadlineMs: started + BUDGET_MS, retryDelayMs: RETRY_MS },
    );
    if (outcome === "ok") return done("Reserved", `${reserved} Next: the seller records the shipping scan and ships.`);
    return done("Reserved", `${reserved} The reservation is on chain; the passport history entry could not be written right now.`);
  } catch (e) {
    return actionJson({ message: (e as Error).message }, 400);
  }
}
