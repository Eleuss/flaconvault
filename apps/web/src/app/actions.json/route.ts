import { NextResponse } from "next/server";
/** Solana Actions discovery: /market/<serial> pages map to the verify-buy action. */
export function GET() {
  return NextResponse.json(
    { rules: [{ pathPattern: "/market/*", apiPath: "/api/actions/verify-buy?serial=*" }] },
    { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "public, max-age=300" } },
  );
}
