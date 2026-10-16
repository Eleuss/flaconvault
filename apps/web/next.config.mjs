/**
 * Security headers. Enforced: no framing anywhere (X-Frame-Options + CSP frame-ancestors), nosniff, a referrer policy
 * and camera only for this origin. The full Content-Security-Policy runs in report-only mode first: it lists what the
 * app really loads (wallet adapters, WalletConnect relay, Solana RPC, the verifier, the Irys/Arweave gateway, the
 * OpenCV worker with WebAssembly) so violations show up in the browser console before it is enforced.
 */
const originOf = (u) => {
  try { return new URL(u).origin; } catch { return null; }
};
/** web3.js derives its websocket endpoint from the RPC URL (https → wss, same host). */
const wsOriginOf = (u) => {
  const o = originOf(u);
  return o ? o.replace(/^http/, "ws") : null;
};

/** @param {Record<string, string | undefined>} env */
export function contentSecurityPolicy(env = process.env) {
  const verify = originOf(env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787");
  const rpc = env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
  const dev = env.NODE_ENV !== "production";
  const walletConnect = [
    "https://*.walletconnect.com", "https://*.walletconnect.org", "wss://*.walletconnect.com", "wss://*.walletconnect.org",
    "https://*.reown.com", "wss://*.reown.com", "https://*.web3modal.org", "https://*.web3modal.com",
  ];
  const arweave = ["https://gateway.irys.xyz", "https://arweave.net", "https://*.arweave.net"];
  const list = (...xs) => [...new Set(xs.flat().filter(Boolean))].join(" ");
  return [
    `default-src 'self'`,
    // Next.js inline bootstrap scripts (no nonces in this app); OpenCV.js needs WebAssembly and embind's new Function()
    `script-src ${list("'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'")}`,
    `worker-src ${list("'self'", "blob:")}`,
    `style-src ${list("'self'", "'unsafe-inline'")}`,
    // fonts are self-hosted (next/font); the WalletConnect modal brings its own
    `font-src ${list("'self'", "data:", "https://fonts.reown.com")}`,
    `img-src ${list("'self'", "data:", "blob:", arweave, walletConnect.filter((x) => x.startsWith("https:")), "https://explorer-api.walletconnect.com")}`,
    `media-src ${list("'self'", "blob:")}`,
    // ws://localhost:* — the Android Mobile Wallet Adapter talks to the wallet app over a local websocket
    `connect-src ${list("'self'", verify, originOf(rpc), wsOriginOf(rpc), "https://api.devnet.solana.com", "wss://api.devnet.solana.com", walletConnect, arweave, "ws://localhost:*", "ws://127.0.0.1:*", dev && "http://localhost:*")}`,
    `frame-src ${list("'self'", "https://verify.walletconnect.com", "https://verify.walletconnect.org", "https://secure.walletconnect.com", "https://secure.walletconnect.org", "https://*.reown.com")}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `manifest-src 'self'`,
  ].join("; ");
}

export function securityHeaders(env = process.env) {
  return [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(env) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  ];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // local production builds: NEXT_DIST_DIR=.next-build npx next build (never clobbers a running dev server); Vercel uses .next
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@flaconvault/proof", "@flaconvault/vision"],
  experimental: { esmExternals: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};
export default nextConfig;
