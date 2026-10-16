/** The first value that is set and not blank. `.env` templates leave optional variables empty (`VERIFY_URL=`), and `??`
 * would keep that "" instead of falling through to the next value. */
export function firstSet(...values: (string | undefined)[]): string {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return "";
}

const noTrailingSlash = (u: string) => u.replace(/\/$/, "");

/**
 * Resolves the URL settings from raw environment values (empty = unset). The callers below pass `process.env.NAME`
 * literally, so Next.js still inlines the NEXT_PUBLIC_* values into the browser bundle.
 */
export function resolveUrls(env: { verifyUrl?: string; publicVerifyUrl?: string; solanaRpc?: string; canonicalOrigin?: string }) {
  return {
    /** Verification server as the Next.js server reaches it (server components, Blink routes). */
    verifyUrl: noTrailingSlash(firstSet(env.verifyUrl, env.publicVerifyUrl, "http://localhost:8787")),
    /** Verification server as the browser reaches it. */
    publicVerifyUrl: noTrailingSlash(firstSet(env.publicVerifyUrl, "http://localhost:8787")),
    solanaRpc: firstSet(env.solanaRpc, "https://api.devnet.solana.com"),
    canonicalOrigin: noTrailingSlash(firstSet(env.canonicalOrigin, "https://app.flaconvault.com")),
  };
}

const urls = resolveUrls({
  verifyUrl: process.env.VERIFY_URL,
  publicVerifyUrl: process.env.NEXT_PUBLIC_VERIFY_URL,
  solanaRpc: process.env.NEXT_PUBLIC_SOLANA_RPC,
  canonicalOrigin: process.env.NEXT_PUBLIC_CANONICAL_ORIGIN,
});

export const VERIFY_URL = urls.verifyUrl;
export const PUBLIC_VERIFY_URL = urls.publicVerifyUrl;
export const SOLANA_RPC = urls.solanaRpc;
export const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";
/**
 * Simulator UI and demo tools are possible only when the env says exactly "true". Even then the demo tools (dev
 * wallets, burner, airdrop, test images) stay hidden unless demo mode is on — see lib/demo.ts.
 */
export const DEV_SIMULATOR = process.env.NEXT_PUBLIC_DEV_SIMULATOR === "true";
export const CLUSTER = "devnet";
/** Public origin of this app (used where no window is available, e.g. wallet app identity during SSR). */
export const CANONICAL_ORIGIN = urls.canonicalOrigin;

/** Reown (WalletConnect) Cloud project id — enables the WalletConnect entry (Phantom/Solflare/Backpack on iPhone from Safari). */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
