"use client";
import type { VerifyResponse } from "./flacon";

/**
 * iOS has no Mobile Wallet Adapter and Safari gets no injected wallet. The documented way for a web dapp is to
 * continue inside the wallet app's own browser (Phantom/Solflare "browse" universal links), where the standard
 * wallet adapter is injected and signs natively. The scan state needed for step 8 travels in the URL (`resume=`),
 * because the wallet's browser has its own storage.
 */
export interface ResumeState { v: VerifyResponse; tier: number; role: number; siteId: number }

const b64url = {
  enc: (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)))),
};
export const resumeState = {
  encode(st: ResumeState): string {
    // keep the bundle to its signed essentials — the URL goes through a universal link
    const v: VerifyResponse = { ...st.v, bundle: st.v.bundle ? { heatLevels: st.v.bundle.heatLevels } : null, message: "" };
    return b64url.enc(JSON.stringify({ ...st, v }));
  },
  decode(s: string): ResumeState | null {
    try { const o = JSON.parse(b64url.dec(s)); return o && o.v && typeof o.tier === "number" ? (o as ResumeState) : null; } catch { return null; }
  },
};

export function resumeUrl(st: ResumeState): string {
  const u = new URL("/scan", window.location.origin);
  u.searchParams.set("tier", String(st.tier)); u.searchParams.set("role", String(st.role));
  if (st.siteId) u.searchParams.set("site", String(st.siteId));
  u.searchParams.set("resume", resumeState.encode(st));
  return u.toString();
}

/** Universal links that open `target` inside the wallet app's browser (must be opened by a user tap). */
export function walletBrowseLinks(target: string): { phantom: string; solflare: string } {
  const ref = encodeURIComponent(window.location.origin);
  const t = encodeURIComponent(target);
  return { phantom: `https://phantom.com/ul/browse/${t}?ref=${ref}`, solflare: `https://solflare.com/ul/v1/browse/${t}?ref=${ref}` };
}

export const isIOS = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);
/** true when no real wallet is injected into this browser (only the dev wallets / MWA entries would be offered) */
export const noInjectedWallet = (names: Array<{ name: string; installed: boolean }>) => !names.some((w) => w.installed && !/^Dev-Wallet|Mobile Wallet Adapter|Burner|WalletConnect/i.test(w.name));
