import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { EventType, serialHash } from "@flaconvault/proof";
import { passportPda } from "@/lib/flacon";
import { escrowProgram, fetchOrder } from "@/lib/escrow";
import { formatUsdc, isValidSerial } from "@/lib/escrow-rules";
import { SOLANA_RPC, VERIFY_URL } from "@/lib/config";
import { ACTIONS_HEADERS, actionJson } from "../headers";

/**
 * Action chaining callback (Solana Actions `links.next`, type "post"): after the wallet sent the reserve transaction the
 * Blink client POSTs `{ account, signature }` here. We record the RESERVE event on the verifier (which verifies the
 * transaction on chain and binds it to the passport through the Order account) and answer with a completed action.
 */
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: ACTIONS_HEADERS }); }

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const done = (title: string, description: string) => actionJson({ type: "completed", icon: `${origin}/icon.svg`, title, description, label: "Done" });
  try {
    const { account, signature } = (await req.json()) as { account?: string; signature?: string };
    const orderKey = new PublicKey(req.nextUrl.searchParams.get("order") ?? "");
    const actor = new PublicKey(account ?? "");
    if (!signature || !SIG_RE.test(signature)) return actionJson({ message: "Missing transaction signature" }, 400);

    const order = await fetchOrder(escrowProgram(new Connection(SOLANA_RPC, "confirmed")), orderKey);
    if (!order) return actionJson({ message: "Unknown order" }, 400);
    const list = (await fetch(`${VERIFY_URL}/api/passports`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))) as { serial: string }[];
    const serial = list.find((p) => isValidSerial(p.serial) && passportPda(serialHash(p.serial)).equals(order.passport))?.serial;
    const reserved = `Reserved · ${formatUsdc(order.priceBase)} USDC are in the escrow vault.`;
    if (!serial) return done("Reserved", `${reserved} The passport history will catch up later.`);

    const body = JSON.stringify({
      serial, type: EventType.RESERVE, txSig: signature, actor: actor.toBase58(),
      payload: { priceUsdc: Number(formatUsdc(order.priceBase)), currency: "USDC", order: orderKey.toBase58(), via: "blink" },
    });
    // the verifier answers 503 tx_not_visible until its RPC sees the transaction
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(`${VERIFY_URL}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" });
      if (r.ok) return done("Reserved", `${reserved} Next: the seller records the shipping scan and ships.`);
      if (r.status !== 503) break;
      await sleep(2500);
    }
    return done("Reserved", `${reserved} The passport history entry could not be written yet; open the order page to retry.`);
  } catch (e) {
    return actionJson({ message: (e as Error).message }, 400);
  }
}
