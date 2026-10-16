import { NextResponse } from "next/server";
/**
 * Solana Actions discovery. Order pages (/market/o/<orderPda>) map to the verify-buy action for exactly that order;
 * the older passport pages (/market/<serial>) still map by serial (works while the passport has one listing).
 * Rules are matched in order; `*` matches one path segment.
 */
// a fixed document: prerendered at build time, as Next 14 did for GET handlers (Next 15 renders them per request)
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    {
      rules: [
        { pathPattern: "/market/o/*", apiPath: "/api/actions/verify-buy?order=*" },
        { pathPattern: "/market/*", apiPath: "/api/actions/verify-buy?serial=*" },
      ],
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "public, max-age=300" } },
  );
}
