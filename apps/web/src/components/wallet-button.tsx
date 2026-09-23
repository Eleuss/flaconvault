"use client";
import dynamic from "next/dynamic";
// The modal button touches window at import time — load it client-only.
export const WalletButton = dynamic(async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton, { ssr: false });
