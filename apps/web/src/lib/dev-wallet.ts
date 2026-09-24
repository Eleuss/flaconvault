"use client";
import { BaseSignerWalletAdapter, WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";

/**
 * Dev-only wallet with a keypair persisted in localStorage — survives reloads, so one browser can play
 * seller and buyer in the escrow demo. Only registered when NEXT_PUBLIC_DEV_SIMULATOR=true.
 */
export class DevWalletAdapter extends BaseSignerWalletAdapter {
  name: WalletName;
  url = "https://github.com/anza-xyz/wallet-adapter";
  icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171C19"/><circle cx="16" cy="16" r="6.5" fill="none" stroke="#A6651B" stroke-width="2"/></svg>');
  readonly supportedTransactionVersions = new Set(["legacy", 0] as const);
  private keypair: Keypair | null = null;
  private storageKey: string;
  private _connecting = false;

  constructor(label: string, slot: string) {
    super();
    this.name = label as WalletName;
    this.storageKey = `fv.devwallet.${slot}`;
  }
  get publicKey(): PublicKey | null { return this.keypair?.publicKey ?? null; }
  get connecting() { return this._connecting; }
  // Loadable (not Installed): with Installed the provider never reports `connected` for this adapter.
  get readyState() { return typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable; }

  private load(): Keypair {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch { /* regenerate */ }
    const kp = Keypair.generate();
    try { localStorage.setItem(this.storageKey, JSON.stringify(Array.from(kp.secretKey))); } catch { /* private mode */ }
    return kp;
  }
  async connect(): Promise<void> {
    if (this._connecting) return;
    this._connecting = true;
    try {
      // Always emit, even when already connected: React Strict Mode detaches and re-attaches the
      // provider's listeners after the first connect, and a silent early return leaves the UI on "Connect".
      if (!this.keypair) this.keypair = this.load();
      this.emit("connect", this.keypair.publicKey);
    } catch (e) {
      console.error("[dev-wallet] connect failed", e);
      throw e;
    } finally { this._connecting = false; }
  }
  async disconnect(): Promise<void> { this.keypair = null; this.emit("disconnect"); }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this.keypair) throw new Error("Dev-Wallet nicht verbunden");
    if ("version" in tx) tx.sign([this.keypair]); else tx.partialSign(this.keypair);
    return tx;
  }
}
