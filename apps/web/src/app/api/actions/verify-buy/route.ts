import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { serialHash } from "@flaconvault/proof";
import { passportPda } from "@/lib/flacon";
import { ata, escrowIx, escrowProgram, fetchConfig, fetchOrders, OrderState } from "@/lib/escrow";
import { SOLANA_RPC, VERIFY_URL } from "@/lib/config";

/** Solana Actions ("Blink"): reserve a listed passport — the buyer's USDC goes into the escrow vault. */
const ACTIONS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Content-Type": "application/json",
  "X-Action-Version": "2.4",
  "X-Blockchain-Ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};
const json = (body: unknown, status = 200) => new NextResponse(JSON.stringify(body), { status, headers: ACTIONS_HEADERS });

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: ACTIONS_HEADERS }); }

export async function GET(req: NextRequest) {
  const serial = req.nextUrl.searchParams.get("serial") ?? "";
  const origin = req.nextUrl.origin;
  let title = "FlaconVault · Reserve passport", description = "Sealed bottle with passport. USDC goes into the escrow vault and is released only after a matching receipt scan.";
  let price: number | null = null;
  try {
    const p = await fetch(`${VERIFY_URL}/api/passport/${encodeURIComponent(serial)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    if (p) title = `${p.brand} · ${p.name} · Grade ${["A", "B", "C", "D", "VOID"][p.void ? 4 : p.grade]}`;
    const orders = await fetchOrders(escrowProgram(new Connection(SOLANA_RPC, "confirmed")));
    const o = orders.find((x) => x.passport.equals(passportPda(serialHash(serial))) && x.state === OrderState.LISTED);
    if (o) price = o.priceUsdc; else description = "No active listing for this passport at the moment.";
  } catch { /* metadata stays generic */ }
  return json({
    type: "action", icon: `${origin}/icon.svg`, title, description, label: price ? `Reserve · ${price} USDC` : "Not available", disabled: !price,
    links: price ? { actions: [{ type: "transaction", label: `Reserve · ${price} USDC`, href: `${origin}/api/actions/verify-buy?serial=${encodeURIComponent(serial)}` }] } : undefined,
  });
}

export async function POST(req: NextRequest) {
  try {
    const serial = req.nextUrl.searchParams.get("serial") ?? "";
    const { account } = (await req.json()) as { account: string };
    const buyer = new PublicKey(account);
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const program = escrowProgram(connection);
    const config = await fetchConfig(program);
    if (!config) return json({ message: "Escrow not configured" }, 400);
    const order = (await fetchOrders(program)).find((x) => x.passport.equals(passportPda(serialHash(serial))) && x.state === OrderState.LISTED);
    if (!order) return json({ message: "No active listing" }, 400);
    const ix = await escrowIx.reserve(program, order, buyer, config.usdcMint).instruction();
    const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(buyer, ata(buyer, config.usdcMint), buyer, config.usdcMint), ix);
    tx.feePayer = buyer;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    return json({ type: "transaction", transaction: serialized, message: `Reservation ${serial} · ${order.priceUsdc} USDC into the escrow vault` });
  } catch (e) {
    return json({ message: (e as Error).message }, 400);
  }
}
