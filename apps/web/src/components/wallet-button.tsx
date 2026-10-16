"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SolanaMobileWalletAdapterWalletName } from "@solana-mobile/wallet-adapter-mobile";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { noInjectedWallet, walletBrowseLinks } from "@/lib/wallet-links";

// The modal button touches window at import time — load it client-only.
const MultiButton = dynamic(async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton, { ssr: false });

/**
 * Android: Phantom app via Mobile Wallet Adapter. iPhone: open this page inside the Phantom/Solflare app browser
 * (universal links). `browseLinks={false}` leaves those links out where reopening the page in another browser would
 * lose its state: the scan page (a seal tap always opens Safari, so a scan started in the wallet's browser never gets
 * the tap; a signed scan moves to the wallet app only through its own resume link).
 */
export function WalletButton({ browseLinks = true }: { browseLinks?: boolean } = {}) {
  const { wallets, select, connected, wallet } = useWallet();
  const [android, setAndroid] = useState(false);
  const [ios, setIos] = useState(false);
  const [href, setHref] = useState("");
  useEffect(() => { setAndroid(/Android/i.test(navigator.userAgent)); setIos(/iPhone|iPad|iPod/i.test(navigator.userAgent)); setHref(window.location.href); }, []);
  // iPhone: Safari gets no injected wallet and there is no Mobile Wallet Adapter on iOS — continue in the wallet app's browser
  const iosLinks = browseLinks && ios && !connected && href && noInjectedWallet(wallets.map((w) => ({ name: w.adapter.name, installed: w.readyState === WalletReadyState.Installed }))) ? walletBrowseLinks(href) : null;
  const mwa = wallets.find((w) => w.adapter.name === SolanaMobileWalletAdapterWalletName);
  // select only: the provider connects a wallet the user picked and reports failures through its error handler
  // (MWA's own connect() does not return its inner promise, so awaiting it here would never see an error)
  const viaApp = () => { if (mwa) select(mwa.adapter.name); };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <MultiButton />
      {android && mwa && !connected && wallet?.adapter.name !== mwa.adapter.name && (
        <button onClick={viaApp} className="btn btn-sm">Phantom app</button>
      )}
      {iosLinks && (
        <>
          <a href={iosLinks.phantom} className="btn btn-sm">Open in Phantom</a>
          <a href={iosLinks.solflare} className="btn-outline btn-sm">Open in Solflare</a>
        </>
      )}
    </span>
  );
}
