import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig, { contentSecurityPolicy, securityHeaders } from "../next.config.mjs";

const env = { NODE_ENV: "production", NEXT_PUBLIC_VERIFY_URL: "https://verify.flaconvault.com", NEXT_PUBLIC_SOLANA_RPC: "https://rpc.example.org/key-path" } as NodeJS.ProcessEnv;
const header = (k: string) => securityHeaders(env).find((h) => h.key === k)?.value;

test("enforced headers (A7)", async () => {
  assert.equal(header("X-Frame-Options"), "DENY");
  assert.equal(header("Content-Security-Policy"), "frame-ancestors 'none'");
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  assert.equal(header("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(header("Permissions-Policy") ?? "", /camera=\(self\)/);
  assert.equal(nextConfig.poweredByHeader, false);
  const rules = await nextConfig.headers!();
  assert.equal(rules[0].source, "/:path*");
});

test("report-only CSP lists what the app loads", () => {
  const csp = contentSecurityPolicy(env);
  const dir = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
  assert.match(dir("connect-src"), /https:\/\/verify\.flaconvault\.com/);
  assert.match(dir("connect-src"), /https:\/\/rpc\.example\.org(\s|$)/, "the RPC origin, never its path (may carry an API key)");
  assert.match(dir("connect-src"), /wss:\/\/rpc\.example\.org/);
  assert.match(dir("connect-src"), /wss:\/\/\*\.walletconnect\.(com|org)/);
  assert.match(dir("img-src"), /https:\/\/gateway\.irys\.xyz/);
  assert.match(dir("script-src"), /'wasm-unsafe-eval'/);
  assert.match(dir("worker-src"), /'self'/);
  assert.equal(dir("frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(dir("object-src"), "object-src 'none'");
  assert.doesNotMatch(csp, /fonts\.googleapis\.com/, "no Google Fonts");
  assert.match(dir("connect-src"), /ws:\/\/localhost:\*/, "Mobile Wallet Adapter's local websocket");
  assert.doesNotMatch(csp, /http:\/\/localhost/, "production policy allows no local http origin");
});
