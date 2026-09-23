export const VERIFY_URL = (process.env.VERIFY_URL ?? process.env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const PUBLIC_VERIFY_URL = (process.env.NEXT_PUBLIC_VERIFY_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const SOLANA_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";
export const DEV_SIMULATOR = (process.env.NEXT_PUBLIC_DEV_SIMULATOR ?? "true") === "true";
export const CLUSTER = "devnet";
