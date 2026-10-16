import { NextResponse } from "next/server";
import { ACTIONS_HEADERS } from "../api/actions/verify-buy/headers";
/**
 * Solana Actions discovery. Order pages (/market/o/<orderPda>) map to the verify-buy action for exactly that order;
 * the older passport pages (/market/<serial>) still map by serial (works while the passport has one listing).
 * Rules are matched in order; `*` matches one path segment.
 *
 * The Actions spec wants CORS headers on GET and OPTIONS: a Blink client that sends the Actions request headers
 * (X-Accept-Action-Version, X-Accept-Blockchain-Ids are not CORS-safelisted) makes the browser send a preflight first.
 *
 * Rendered per request on purpose, without `dynamic = "force-static"`: a prerendered route is served as a file, which
 * answers OPTIONS with 405 and no CORS headers (Next 14 did exactly that), and Next does not prerender a route handler
 * that exports OPTIONS anyway. The document is fixed and cheap to build; browsers keep it for 5 minutes.
 */

// not exported: a route file may only export route handlers and segment config
const ACTIONS_JSON_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": ACTIONS_HEADERS["Access-Control-Allow-Headers"],
};

export function GET() {
  return NextResponse.json(
    {
      rules: [
        { pathPattern: "/market/o/*", apiPath: "/api/actions/verify-buy?order=*" },
        { pathPattern: "/market/*", apiPath: "/api/actions/verify-buy?serial=*" },
      ],
    },
    { headers: { ...ACTIONS_JSON_CORS, "Cache-Control": "public, max-age=300" } },
  );
}

/** The CORS preflight (the middleware never redirects OPTIONS or /actions.json). */
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ACTIONS_JSON_CORS });
}
