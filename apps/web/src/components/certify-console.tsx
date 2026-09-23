"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ArrowRight, Loader2, Printer, ShieldCheck } from "lucide-react";
import { bindingHash, bytesToHex, serialHash, uidHash } from "@flaconvault/proof";
import { flaconProgram, passportPda, registryPda, sealPda } from "@/lib/flacon";
import { api, type SimTag } from "@/lib/verify-api";
import { DEV_SIMULATOR, PROGRAM_ID, PUBLIC_VERIFY_URL, SOLANA_RPC } from "@/lib/config";
import { txUrl } from "@/lib/format";
import { cardSvgForSerial } from "@/lib/card";
import { Lamp, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

interface Site { siteId: number; label: string }
interface Registry { authority: string; partners: string[]; sites: Site[] }
const labelOf = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, "");

export function CertifyConsole() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [registry, setRegistry] = useState<Registry | null | undefined>(undefined);
  const [form, setForm] = useState({ serial: "SN-2026-000004", brand: "", name: "", batch: "", siteId: 1, kind: 1, uid: "", useCore: true });
  const [simTags, setSimTags] = useState<SimTag[]>([]);
  const [asset, setAsset] = useState<string | null>(null);
  const [txs, setTxs] = useState<{ core?: string; mint?: string; seal?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 20));

  const loadRegistry = useCallback(async () => {
    if (!PROGRAM_ID || !anchorWallet) { setRegistry(null); return; }
    try {
      const program = flaconProgram(connection, anchorWallet);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reg: any = await (program.account as any).registry.fetch(registryPda());
      setRegistry({ authority: reg.authority.toBase58(), partners: reg.partners.map((p: PublicKey) => p.toBase58()), sites: reg.sites.map((s: { siteId: number; label: number[] }) => ({ siteId: s.siteId, label: labelOf(s.label) })) });
    } catch (e) { setRegistry(null); setError(`Registry nicht lesbar: ${(e as Error).message}`); }
  }, [connection, anchorWallet]);
  useEffect(() => { loadRegistry(); }, [loadRegistry]);
  useEffect(() => { if (DEV_SIMULATOR) api.simTags().then(setSimTags).catch(() => {}); }, []);

  const isPartner = !!(registry && wallet.publicKey && (registry.partners.includes(wallet.publicKey.toBase58()) || registry.authority === wallet.publicKey.toBase58()));
  const site = registry?.sites.find((s) => s.siteId === form.siteId);

  const mintCore = async () => {
    if (!wallet.connected) return;
    setBusy("core"); setError(null);
    try {
      const [{ createUmi }, { walletAdapterIdentity }, { mplCore, create }, { generateSigner }] = await Promise.all([
        import("@metaplex-foundation/umi-bundle-defaults"), import("@metaplex-foundation/umi-signer-wallet-adapters"),
        import("@metaplex-foundation/mpl-core"), import("@metaplex-foundation/umi"),
      ]);
      const umi = createUmi(SOLANA_RPC).use(mplCore()).use(walletAdapterIdentity(wallet));
      const signer = generateSigner(umi);
      const res = await create(umi, { asset: signer, name: `${form.brand} ${form.name} · ${form.serial}`.trim(), uri: `${PUBLIC_VERIFY_URL}/api/passport/${form.serial}` }).sendAndConfirm(umi);
      const sig = Buffer.from(res.signature).toString("base64");
      setAsset(signer.publicKey.toString()); setTxs((t) => ({ ...t, core: sig }));
      note(`Core-Asset ${signer.publicKey.toString()} gemintet`);
    } catch (e) { setError(`Core-Mint fehlgeschlagen (auf localnet fehlt das Core-Programm): ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  const airdrop = async () => {
    if (!wallet.publicKey) return;
    setBusy("airdrop"); setError(null);
    try { const s = await connection.requestAirdrop(wallet.publicKey, 1e9); await connection.confirmTransaction(s, "confirmed"); note("1 SOL Airdrop"); }
    catch (e) { setError(`Airdrop: ${(e as Error).message}`); } finally { setBusy(null); }
  };
  const usePlaceholder = () => { const k = Keypair.generate().publicKey.toBase58(); setAsset(k); note(`Platzhalter-Asset ${k.slice(0, 8)}…`); };

  const mintPassport = async () => {
    if (!anchorWallet || !wallet.publicKey || !asset) return;
    setBusy("mint"); setError(null);
    try {
      if (!/^[0-9A-Fa-f]{14}$/.test(form.uid)) throw new Error("UID des ersten Siegels (7 Byte hex) wird für den binding_hash gebraucht");
      const program = flaconProgram(connection, anchorWallet);
      const sh = serialHash(form.serial), uh = uidHash(form.uid), bh = bindingHash(form.serial, form.batch, uh);
      const sig = await program.methods.mintPassport(Array.from(sh), Array.from(bh), new PublicKey(asset))
        .accountsStrict({ registry: registryPda(), passport: passportPda(sh), issuer: wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
      setTxs((t) => ({ ...t, mint: sig }));
      await api.events({ serial: form.serial, type: 0, txSig: sig, actor: wallet.publicKey.toBase58(), payload: { brand: form.brand, name: form.name, batch: form.batch, asset, issuerLabel: site?.label ?? null, siteId: form.siteId, bindingHash: bytesToHex(bh, true) } });
      note(`mint_passport ${form.serial} · ${sig.slice(0, 12)}…`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const attachSeal = async () => {
    if (!anchorWallet || !wallet.publicKey) return;
    setBusy("seal"); setError(null);
    try {
      if (!/^[0-9A-Fa-f]{14}$/.test(form.uid)) throw new Error("UID muss 7 Byte hex sein");
      const program = flaconProgram(connection, anchorWallet);
      const sh = serialHash(form.serial), uh = uidHash(form.uid);
      const sig = await program.methods.attachSeal(Array.from(uh), form.kind)
        .accountsStrict({ registry: registryPda(), passport: passportPda(sh), seal: sealPda(uh), signer: wallet.publicKey, systemProgram: SystemProgram.programId }).rpc();
      setTxs((t) => ({ ...t, seal: sig }));
      await api.events({ serial: form.serial, type: 1, txSig: sig, actor: wallet.publicKey.toBase58(), payload: { uid: form.uid.toUpperCase(), kind: form.kind, siteId: form.siteId } });
      note(`attach_seal ${form.uid.toUpperCase()} · ${sig.slice(0, 12)}…`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const newSimTag = async () => {
    setBusy("tag"); setError(null);
    try {
      const t = await fetch(`${PUBLIC_VERIFY_URL}/api/dev/tag`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: form.kind }) }).then((r) => r.json());
      setForm((f) => ({ ...f, uid: t.uid })); setSimTags((s) => [...s, t]); note(`virtueller Tag ${t.uid}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const readNfc = async () => {
    const w = window as unknown as { NDEFReader?: new () => { scan: () => Promise<void>; onreading: ((ev: { serialNumber?: string }) => void) | null } };
    if (!w.NDEFReader) { setError("WebNFC nur in Android Chrome"); return; }
    const r = new w.NDEFReader(); await r.scan();
    r.onreading = (ev) => { const uid = (ev.serialNumber ?? "").replace(/:/g, "").toUpperCase(); if (uid.length === 14) setForm((f) => ({ ...f, uid })); };
    note("NFC bereit — Chip ans Handy halten (UID wird übernommen)");
  };
  const printCard = async () => {
    setBusy("print");
    try {
      const tpl = await fetch("/card-template.svg").then((r) => r.text());
      const svg = await cardSvgForSerial(tpl, form.serial);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a"); a.href = url; a.download = `Einlegekarte_${form.serial}.svg`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const field = (k: keyof typeof form, label: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label className="block text-sm"><span className="text-muted">{label}</span>
      <input value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm" />
    </label>
  );

  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Zertifizierungskonsole · Vault / Partner</p>
      <h1 className="mt-3 font-serif text-4xl">Geburtsurkunde</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">Pass anlegen, Core-Asset minten, Siegel anlegen, dann der Erst-Scan Tier 4 mit Foto. Nur Wallets auf der Partner-Whitelist des Registry-Kontos.</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <WalletButton />
        {registry === undefined && wallet.connected && <span className="text-xs text-muted"><Loader2 className="inline h-3.5 w-3.5 animate-spin" aria-hidden /> Registry …</span>}
        {registry && <Pill tone={isPartner ? "ok" : "bad"}>{isPartner ? "Partner-Wallet bestätigt" : "Wallet ist kein Partner"}</Pill>}
        {wallet.publicKey && <span className="mono text-xs text-muted" data-wallet={wallet.publicKey.toBase58()}>{wallet.publicKey.toBase58()}</span>}
        {registry === null && wallet.connected && <Pill tone="none">Registry nicht gefunden — scripts/seed-devnet.ts ausführen</Pill>}
        {wallet.connected && <button onClick={loadRegistry} className="btn-outline btn-sm">Registry neu laden</button>}
        {wallet.connected && DEV_SIMULATOR && <button onClick={airdrop} disabled={busy !== null} className="btn-outline btn-sm">1 SOL Airdrop (Test)</button>}
      </div>
      {error && <p className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <section className="card grid gap-4 p-5 sm:grid-cols-2">
            {field("serial", "Seriennummer", { placeholder: "SN-2026-000004" })}
            <label className="block text-sm"><span className="text-muted">Standort (site_id)</span>
              <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: +e.target.value })} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm">
                {(registry?.sites ?? [{ siteId: 1, label: "Parfümerie X, Düsseldorf" }, { siteId: 2, label: "FlaconVault Vault, Wickede" }]).map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId} · {s.label}</option>)}
              </select>
            </label>
            {field("brand", "Marke", { placeholder: "Roja Parfums" })}
            {field("name", "Name", { placeholder: "Haute Luxe" })}
            {field("batch", "Charge", { placeholder: "4A12" })}
            <label className="block text-sm"><span className="text-muted">Siegel</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: +e.target.value })} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"><option value={1}>Hals</option><option value={0}>Packung</option></select>
            </label>
            <div className="sm:col-span-2">
              {field("uid", "Chip-UID (7 Byte hex)", { placeholder: "04A1B2C3D4E5F6" })}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={readNfc} className="btn-outline btn-sm">UID per NFC lesen</button>
                {DEV_SIMULATOR && <button onClick={newSimTag} disabled={busy !== null} className="btn-outline btn-sm">Neuen virtuellen Tag anlegen</button>}
                {DEV_SIMULATOR && simTags.filter((t) => !t.serial).map((t) => <button key={t.uid} onClick={() => setForm({ ...form, uid: t.uid })} className="btn-outline btn-sm mono">{t.uid}</button>)}
              </div>
            </div>
          </section>

          <section className="card p-5">
            <p className="text-sm font-medium">1 · Core-Asset</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={mintCore} disabled={busy !== null || !wallet.connected} className="btn btn-sm">{busy === "core" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Metaplex Core minten</button>
              <button onClick={usePlaceholder} className="btn-outline btn-sm">Platzhalter (localnet)</button>
              {asset && <span className="mono text-xs text-muted">Asset {asset.slice(0, 10)}…</span>}
            </div>
          </section>
          <section className="card p-5">
            <p className="text-sm font-medium">2 · Pass anlegen (mint_passport)</p>
            <p className="mt-1 text-xs text-muted">binding_hash = sha256(Serial ‖ Charge ‖ uid_hash des ersten Siegels)</p>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={mintPassport} disabled={busy !== null || !isPartner || !asset} className="btn btn-sm">{busy === "mint" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Pass minten</button>
              {txs.mint && <a href={txUrl(txs.mint)} target="_blank" rel="noreferrer" className="link text-xs text-muted">tx {txs.mint.slice(0, 10)}…</a>}
            </div>
          </section>
          <section className="card p-5">
            <p className="text-sm font-medium">3 · Siegel anlegen (attach_seal)</p>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={attachSeal} disabled={busy !== null || !isPartner} className="btn btn-sm">{busy === "seal" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Siegel anlegen</button>
              {txs.seal && <a href={txUrl(txs.seal)} target="_blank" rel="noreferrer" className="link text-xs text-muted">tx {txs.seal.slice(0, 10)}…</a>}
            </div>
          </section>
          <section className="card p-5">
            <p className="text-sm font-medium">4 · Erst-Scan Tier 4 (Geburt) mit Foto</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Link href={`/scan?role=4&tier=4&site=${form.siteId}`} className="btn btn-sm"><ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Zum Scan <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
              <button onClick={printCard} disabled={busy !== null} className="btn-outline btn-sm"><Printer className="h-3.5 w-3.5" aria-hidden /> Karte mit QR drucken (SVG)</button>
              {txs.mint && <Link href={`/p/${form.serial}`} className="link text-sm">Pass ansehen</Link>}
            </div>
          </section>
        </div>
        <aside>
          <p className="eyebrow">Protokoll</p>
          <ol className="mt-3 space-y-2 text-xs">
            {log.length === 0 && <li className="text-muted">Noch nichts passiert.</li>}
            {log.map((l, i) => <li key={i} className="card flex items-center gap-2 p-2"><Lamp tone="ok" /><span className="break-all">{l}</span></li>)}
          </ol>
        </aside>
      </div>
    </div>
  );
}
