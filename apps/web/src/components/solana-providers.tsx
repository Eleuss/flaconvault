"use client";
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { WalletAdapterNetwork, WalletReadyState, type Adapter } from "@solana/wallet-adapter-base";
import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { SolanaMobileWalletAdapter, createDefaultAddressSelector, createDefaultAuthorizationResultCache, createDefaultWalletNotFoundHandler } from "@solana-mobile/wallet-adapter-mobile";
import { DevWalletAdapter } from "@/lib/dev-wallet";
import { DEV_SIMULATOR, SOLANA_RPC, WALLETCONNECT_PROJECT_ID } from "@/lib/config";
import "@solana/wallet-adapter-react-ui/styles.css";

/** Phantom is the demo wallet (Android Chrome). The burner wallet exists only with the simulator flag, for local testing. */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => {
    // Android Chrome: Mobile Wallet Adapter deep-links into the Phantom app (the "Phantom" entry is the browser extension)
    const mobile = new SolanaMobileWalletAdapter({
      addressSelector: createDefaultAddressSelector(),
      appIdentity: { name: "FlaconVault", uri: typeof window !== "undefined" ? window.location.origin : "https://flaconvault.vercel.app", icon: "icon.svg" },
      authorizationResultCache: createDefaultAuthorizationResultCache(),
      chain: "solana:devnet",
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    });
    // The "Phantom" entry is the browser extension: list it only where it is actually injected (desktop or Phantom's
    // in-app browser). On phones it would only send people to the download page and block the wallet selection.
    const phantom = new PhantomWalletAdapter();
    const base: Adapter[] = phantom.readyState === WalletReadyState.Installed ? [mobile, phantom] : [mobile];
    // WalletConnect: the wallet app (Phantom, Solflare, Backpack …) signs via the relay — the only way to sign from
    // iPhone Safari without leaving the page's browser. Needs a Reown Cloud project id.
    if (WALLETCONNECT_PROJECT_ID) {
      const origin = typeof window !== "undefined" ? window.location.origin : "https://flaconvault.vercel.app";
      base.push(new WalletConnectWalletAdapter({
        network: WalletAdapterNetwork.Devnet,
        options: { projectId: WALLETCONNECT_PROJECT_ID, metadata: { name: "FlaconVault", description: "Siegel, Zustand und Herkunft eines Flakons — ScanProof auf Solana", url: origin, icons: [`${origin}/icon.svg`] } },
      }));
    }
    return DEV_SIMULATOR ? [...base, new DevWalletAdapter("Dev-Wallet A (Verkäufer)", "a"), new DevWalletAdapter("Dev-Wallet B (Käufer)", "b"), new UnsafeBurnerWalletAdapter()] : base;
  }, []);
  return (
    <ConnectionProvider endpoint={SOLANA_RPC} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
