"use client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { WalletAdapterNetwork, type Adapter } from "@solana/wallet-adapter-base";
import { WalletConnectWalletAdapter, WalletConnectWalletName } from "@solana/wallet-adapter-walletconnect";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { SolanaMobileWalletAdapter, createDefaultAddressSelector, createDefaultAuthorizationResultCache, createDefaultWalletNotFoundHandler } from "@solana-mobile/wallet-adapter-mobile";
import { DevWalletAdapter } from "@/lib/dev-wallet";
import { demoMode } from "@/lib/demo";
import { CANONICAL_ORIGIN, SOLANA_RPC, WALLETCONNECT_PROJECT_ID } from "@/lib/config";
import { autoConnectPolicy } from "@/lib/wallet-links";
// the package's styles.css without its Google Fonts @import (no third-party font request from visitors' browsers)
import "./wallet-adapter-ui.css";

/** WalletProvider's default localStorage key for the selected wallet (stored JSON-encoded). */
const WALLET_NAME_KEY = "walletName";
const rememberedWallet = (): string | null => {
  if (typeof window === "undefined") return null;
  try { const v = window.localStorage.getItem(WALLET_NAME_KEY); return v ? (JSON.parse(v) as string) : null; } catch { return null; }
};

/**
 * Wallets: injected Wallet Standard wallets (Phantom, Solflare, Backpack … found by the provider itself), the Mobile
 * Wallet Adapter (Android Chrome → wallet app) and WalletConnect (iPhone Safari → wallet app via the relay). The demo
 * wallets (two localStorage dev wallets and the burner) are added only in demo mode (lib/demo.ts).
 */
export function SolanaProviders({ children }: { children: ReactNode }) {
  // demo mode depends on window/localStorage: read it after hydration, never during render
  const [demo, setDemo] = useState(false);
  useEffect(() => setDemo(demoMode()), []);
  // the wallet remembered from the last visit, read before any selection in this page view (see autoConnectPolicy)
  const [atLoad] = useState(rememberedWallet);
  const policy = useMemo(() => autoConnectPolicy(WalletConnectWalletName, atLoad), [atLoad]);
  const autoConnect = useCallback(async (adapter: Adapter) => policy(adapter.name), [policy]);

  // adapter instances are created once: a changing list must never replace the instance the provider is connected to
  const base = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : CANONICAL_ORIGIN;
    const list: Adapter[] = [new SolanaMobileWalletAdapter({
      addressSelector: createDefaultAddressSelector(),
      appIdentity: { name: "FlaconVault", uri: origin, icon: "icon.svg" },
      authorizationResultCache: createDefaultAuthorizationResultCache(),
      chain: "solana:devnet",
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    })];
    // WalletConnect: the wallet app (Phantom, Solflare, Backpack …) signs via the relay — the only way to sign from
    // iPhone Safari without leaving the page's browser. Needs a Reown Cloud project id.
    if (WALLETCONNECT_PROJECT_ID) {
      list.push(new WalletConnectWalletAdapter({
        network: WalletAdapterNetwork.Devnet,
        options: { projectId: WALLETCONNECT_PROJECT_ID, metadata: { name: "FlaconVault", description: "Seal, condition and provenance of a bottle — ScanProof on Solana", url: origin, icons: [`${origin}/icon.svg`] } },
      }));
    }
    return list;
  }, []);
  const demoWallets = useMemo<Adapter[]>(
    () => (demo ? [new DevWalletAdapter("Dev wallet A (seller)", "a"), new DevWalletAdapter("Dev wallet B (buyer)", "b"), new UnsafeBurnerWalletAdapter()] : []),
    [demo],
  );
  const wallets = useMemo(() => [...base, ...demoWallets], [base, demoWallets]);
  return (
    <ConnectionProvider endpoint={SOLANA_RPC} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
