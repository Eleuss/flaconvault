"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SolanaMobileWalletAdapterWalletName } from "@solana-mobile/wallet-adapter-mobile";

// The modal button touches window at import time — load it client-only.
const MultiButton = dynamic(async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton, { ssr: false });

/** On Android, offer the Phantom app directly (Mobile Wallet Adapter deep link) next to the standard modal button. */
export function WalletButton() {
  const { wallets, select, connected, wallet } = useWallet();
  const [android, setAndroid] = useState(false);
  useEffect(() => { setAndroid(/Android/i.test(navigator.userAgent)); }, []);
  const mwa = wallets.find((w) => w.adapter.name === SolanaMobileWalletAdapterWalletName);
  const viaApp = async () => {
    if (!mwa) return;
    select(mwa.adapter.name);
    try { await mwa.adapter.connect(); } catch (e) { console.error("[wallet] mobile connect", e); }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <MultiButton />
      {android && mwa && !connected && wallet?.adapter.name !== mwa.adapter.name && (
        <button onClick={viaApp} className="btn btn-sm">Phantom-App</button>
      )}
    </span>
  );
}
