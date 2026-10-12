export const VERIFY_URL = (process.env.VERIFY_URL ?? process.env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const PUBLIC_VERIFY_URL = (process.env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const SOLANA_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";
/** Simulator UI and dev wallets: only when the env says exactly "true" (production sets it explicitly for the demo). */
export const DEV_SIMULATOR = process.env.NEXT_PUBLIC_DEV_SIMULATOR === "true";
export const CLUSTER = "devnet";

/** Reown (WalletConnect) Cloud project id — enables the WalletConnect entry (Phantom/Solflare/Backpack on iPhone from Safari). */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
