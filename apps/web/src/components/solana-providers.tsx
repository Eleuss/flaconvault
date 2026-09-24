"use client";
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { DevWalletAdapter } from "@/lib/dev-wallet";
import { DEV_SIMULATOR, SOLANA_RPC } from "@/lib/config";
import "@solana/wallet-adapter-react-ui/styles.css";

/** Phantom is the demo wallet (Android Chrome). The burner wallet exists only with the simulator flag, for local testing. */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => (DEV_SIMULATOR
      ? [new PhantomWalletAdapter(), new DevWalletAdapter("Dev-Wallet A (Verkäufer)", "a"), new DevWalletAdapter("Dev-Wallet B (Käufer)", "b"), new UnsafeBurnerWalletAdapter()]
      : [new PhantomWalletAdapter()]),
    [],
  );
  return (
    <ConnectionProvider endpoint={SOLANA_RPC} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
