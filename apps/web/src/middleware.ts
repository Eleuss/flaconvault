import { NextResponse, type NextRequest } from "next/server";

/**
 * The stickers written so far carry https://flaconvault.vercel.app/t?… . The app now lives on app.flaconvault.com:
 * the old production host answers with a permanent redirect that keeps path and query, so every sticker keeps
 * working and scan + tap share one origin (localStorage handoff). Preview deployments (other *.vercel.app hosts)
 * are not touched.
 */
const OLD_HOST = "flaconvault.vercel.app";
const NEW_ORIGIN = process.env.NEXT_PUBLIC_CANONICAL_ORIGIN ?? "";

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!NEW_ORIGIN || host !== OLD_HOST) return NextResponse.next();
  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, NEW_ORIGIN);
  return NextResponse.redirect(url, 308);
}

// everything except Next internals and static vendor files (OpenCV is 13 MB — no point redirecting those)
export const config = { matcher: ["/((?!_next/|vendor/|favicon|icon).*)"] };
