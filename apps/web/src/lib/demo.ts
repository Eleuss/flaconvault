"use client";
/**
 * Demo tools (dev wallets, burner, airdrop, test images, placeholder asset) exist for the hackathon video and local
 * development. They are only active when NEXT_PUBLIC_DEV_SIMULATOR=true AND either the page runs on localhost or demo
 * mode was switched on in this browser via /dev?demo=1 (switch off with /dev?demo=0).
 */
import { DEV_SIMULATOR } from "./config";

const KEY = "fv.demo";

export function demoMode(): boolean {
  if (!DEV_SIMULATOR || typeof window === "undefined") return false;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return true;
  try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function setDemoMode(on: boolean): void {
  try { if (on) window.localStorage.setItem(KEY, "1"); else window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}
