"use client";
/**
 * iOS has no Mobile Wallet Adapter and Safari gets no injected wallet. The documented way for a web dapp is to
 * continue inside the wallet app's own browser (Phantom/Solflare "browse" universal links), where the standard
 * wallet adapter is injected and signs natively. The wallet's browser has its own storage, so the link carries a
 * reference to the signed scan: `resume=<eventId>.<resumeToken>`. The wallet browser exchanges it with the verifier
 * (GET /api/verify/{eventId}?token=…). No signed message, server signature or nonce ever travels in the URL.
 */
export interface ResumeRef { eventId: number; token: string }
export interface ResumeLink extends ResumeRef { tier: number; role: number; siteId: number }

/** `secrets.token_urlsafe(16)` on the verifier: 22 url-safe base64 characters (a little slack either way). */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const resumeRef = {
  encode: (r: ResumeRef): string => `${r.eventId}.${r.token}`,
  decode(s: string | null | undefined): ResumeRef | null {
    const m = /^(\d{1,15})\.([A-Za-z0-9_-]+)$/.exec(s ?? "");
    if (!m || !TOKEN_RE.test(m[2])) return null;
    const eventId = Number(m[1]);
    return Number.isSafeInteger(eventId) && eventId > 0 ? { eventId, token: m[2] } : null;
  },
};

export function resumeUrl(st: ResumeLink, origin = window.location.origin): string {
  const u = new URL("/scan", origin);
  u.searchParams.set("resume", resumeRef.encode(st));
  u.searchParams.set("tier", String(st.tier)); u.searchParams.set("role", String(st.role));
  if (st.siteId) u.searchParams.set("site", String(st.siteId));
  return u.toString();
}

/** Universal links that open `target` inside the wallet app's browser (must be opened by a user tap). */
export function walletBrowseLinks(target: string, origin = window.location.origin): { phantom: string; solflare: string } {
  const ref = encodeURIComponent(origin);
  const t = encodeURIComponent(target);
  return { phantom: `https://phantom.com/ul/browse/${t}?ref=${ref}`, solflare: `https://solflare.com/ul/v1/browse/${t}?ref=${ref}` };
}

export const isIOS = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);
/** true when no real wallet is injected into this browser (only the demo wallets / MWA / WalletConnect entries would be offered) */
export const noInjectedWallet = (names: Array<{ name: string; installed: boolean }>) => !names.some((w) => w.installed && !/^Dev[- ]wallet|Mobile Wallet Adapter|Burner|WalletConnect/i.test(w.name));

/**
 * Auto-connect policy for the wallet provider. Every adapter reconnects on its own, except WalletConnect on page
 * load: when its relay session is gone, its connect() opens the QR modal by itself (over a /t tap result, say). That
 * one waits for the user to press "Connect". A wallet the user picks in this page view always connects.
 */
export function autoConnectPolicy(walletConnectName: string, rememberedAtLoad: string | null) {
  let pageLoadAttempt = true;
  return (adapterName: string): boolean => {
    const atLoad = pageLoadAttempt && adapterName === rememberedAtLoad;
    pageLoadAttempt = false;
    return !(atLoad && adapterName === walletConnectName);
  };
}
