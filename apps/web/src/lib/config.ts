export const VERIFY_URL = (process.env.VERIFY_URL ?? process.env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const PUBLIC_VERIFY_URL = (process.env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const SOLANA_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";
/**
 * Simulator UI and demo tools are possible only when the env says exactly "true". Even then the demo tools (dev
 * wallets, burner, airdrop, test images) stay hidden unless demo mode is on — see lib/demo.ts.
 */
export const DEV_SIMULATOR = process.env.NEXT_PUBLIC_DEV_SIMULATOR === "true";
export const CLUSTER = "devnet";
/** Public origin of this app (used where no window is available, e.g. wallet app identity during SSR). */
export const CANONICAL_ORIGIN = (process.env.NEXT_PUBLIC_CANONICAL_ORIGIN ?? "https://app.flaconvault.com").replace(/\/$/, "");

/** Reown (WalletConnect) Cloud project id — enables the WalletConnect entry (Phantom/Solflare/Backpack on iPhone from Safari). */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
