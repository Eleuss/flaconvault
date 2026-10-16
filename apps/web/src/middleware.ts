import { NextResponse, type NextRequest } from "next/server";

/**
 * The stickers written so far carry https://flaconvault.vercel.app/t?… . The app now lives on app.flaconvault.com:
 * the old production host answers with a permanent redirect that keeps path and query, so every sticker keeps
 * working and scan + tap share one origin (localStorage handoff). Preview deployments (other *.vercel.app hosts)
 * are not touched.
 *
 * Never redirected: Solana Actions (Blink) endpoints and their discovery file — Blink clients do not follow a
 * redirect and a CORS preflight must not be redirected at all — and OPTIONS requests in general.
 */
const OLD_HOST = "flaconvault.vercel.app";

export function keepsOrigin(method: string, pathname: string): boolean {
  return method === "OPTIONS" || pathname === "/actions.json" || pathname === "/api/actions" || pathname.startsWith("/api/actions/");
}

export function middleware(req: NextRequest) {
  const newOrigin = process.env.NEXT_PUBLIC_CANONICAL_ORIGIN ?? "";
  const host = req.headers.get("host") ?? "";
  if (!newOrigin || host !== OLD_HOST || keepsOrigin(req.method, req.nextUrl.pathname)) return NextResponse.next();
  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, newOrigin);
  return NextResponse.redirect(url, 308);
}

// everything except Next internals, static vendor files (OpenCV is 13 MB) and the Blink endpoints
export const config = { matcher: ["/((?!_next/|vendor/|favicon|icon|actions.json|api/actions).*)"] };
