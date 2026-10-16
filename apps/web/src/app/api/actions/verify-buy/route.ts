import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { serialHash } from "@flaconvault/proof";
import { passportPda } from "@/lib/flacon";
import { ensureAtaIx, escrowIx, escrowProgram, fetchConfig, fetchOrder, fetchOrders, OrderState, type OrderView } from "@/lib/escrow";
import { formatUsdc, isValidSerial } from "@/lib/escrow-rules";
import { SOLANA_RPC, VERIFY_URL } from "@/lib/config";
import { ACTIONS_HEADERS, actionJson } from "./headers";

/**
 * Solana Actions ("Blink"): reserve one listed order — the buyer's USDC goes into the escrow vault.
 * Addressed by the Order PDA (`?order=`); the legacy `?serial=` works only while that passport has exactly one listing.
 * The POST carries the price the GET showed (`&price=` in base units), which becomes reserve's `expected_price`, and
 * chains to ./confirm, which records the RESERVE event once the wallet has sent the transaction.
 */
const GRADES = ["A", "B", "C", "D", "VOID"];

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: ACTIONS_HEADERS }); }

async function resolveOrder(req: NextRequest, connection: Connection): Promise<{ order: OrderView | null; why: string | null }> {
  const program = escrowProgram(connection);
  const orderParam = req.nextUrl.searchParams.get("order");
  if (orderParam) {
    let key: PublicKey;
    try { key = new PublicKey(orderParam); } catch { return { order: null, why: "Invalid order address." }; }
    const o = await fetchOrder(program, key);
    if (!o) return { order: null, why: "This order does not exist (any more)." };
    return o.state === OrderState.LISTED ? { order: o, why: null } : { order: null, why: "This order is no longer available." };
  }
  const serial = req.nextUrl.searchParams.get("serial") ?? "";
  if (!isValidSerial(serial)) return { order: null, why: "Unknown passport." };
  const listed = (await fetchOrders(program, { passport: passportPda(serialHash(serial)) })).filter((o) => o.state === OrderState.LISTED);
  if (listed.length === 1) return { order: listed[0], why: null };
  return { order: null, why: listed.length ? "Several listings for this passport: open the market page and choose one." : "No active listing for this passport at the moment." };
}

/** The passport behind an order, from the verifier (title only; the chain decides everything else). */
async function passportTitle(o: OrderView): Promise<{ serial: string | null; title: string | null }> {
  const list = (await fetch(`${VERIFY_URL}/api/passports`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))) as { serial: string }[];
  const hit = list.find((p) => isValidSerial(p.serial) && passportPda(serialHash(p.serial)).equals(o.passport));
  if (!hit) return { serial: null, title: null };
  const p = await fetch(`${VERIFY_URL}/api/passport/${encodeURIComponent(hit.serial)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
  return { serial: hit.serial, title: p ? `${p.brand} · ${p.name} · Grade ${GRADES[p.void ? 4 : p.grade]}` : null };
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  let title = "FlaconVault · Reserve passport", description = "Sealed bottle with passport. USDC goes into the escrow vault and is released only after a matching receipt scan.";
  let href: string | null = null, label = "Not available";
  try {
    const { order, why } = await resolveOrder(req, new Connection(SOLANA_RPC, "confirmed"));
    if (order) {
      const t = await passportTitle(order);
      if (t.title) title = t.title;
      const price = formatUsdc(order.priceBase);
      label = `Reserve · ${price} USDC`;
      href = `${origin}/api/actions/verify-buy?order=${encodeURIComponent(order.pubkey.toBase58())}&price=${order.priceBase.toString()}`;
    } else if (why) description = why;
  } catch { /* metadata stays generic */ }
  return actionJson({
    type: "action", icon: `${origin}/icon.svg`, title, description, label, disabled: !href,
    links: href ? { actions: [{ type: "transaction", label, href }] } : undefined,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { account } = (await req.json()) as { account: string };
    const buyer = new PublicKey(account);
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const program = escrowProgram(connection);
    const config = await fetchConfig(program);
    if (!config) return actionJson({ message: "Escrow not configured" }, 400);
    const { order, why } = await resolveOrder(req, connection);
    if (!order) return actionJson({ message: why ?? "No active listing" }, 400);
    if (order.seller.equals(buyer)) return actionJson({ message: "This is your own listing." }, 400);
    // the price the buyer was shown; the program refuses the reservation if the order's price differs
    const priceParam = req.nextUrl.searchParams.get("price");
    const expected = priceParam && /^\d{1,20}$/.test(priceParam) ? BigInt(priceParam) : order.priceBase;
    const ix = await escrowIx.reserve(program, order, buyer, config.usdcMint, expected).instruction();
    const tx = new Transaction().add(ensureAtaIx(buyer, buyer, config.usdcMint), ix);
    tx.feePayer = buyer;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const next = `${req.nextUrl.origin}/api/actions/verify-buy/confirm?order=${encodeURIComponent(order.pubkey.toBase58())}`;
    return actionJson({
      type: "transaction", transaction: serialized,
      message: `Reservation · ${formatUsdc(expected)} USDC into the escrow vault`,
      links: { next: { type: "post", href: next } },
    });
  } catch (e) {
    return actionJson({ message: (e as Error).message }, 400);
  }
}
