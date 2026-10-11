"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";
import { creatingSignature, sendAsV0 } from "@/lib/send-tx";
import { ArrowRight, Loader2, Printer, ShieldCheck } from "lucide-react";
import { bindingHash, bytesToHex, serialHash, uidHash } from "@flaconvault/proof";
import { flaconProgram, passportPda, registryPda, sealPda } from "@/lib/flacon";
import { api, type SimTag } from "@/lib/verify-api";
import { DEV_SIMULATOR, PROGRAM_ID, PUBLIC_VERIFY_URL, SOLANA_RPC } from "@/lib/config";
import { txUrl } from "@/lib/format";
import { cardSvgForSerial } from "@/lib/card";
import { lastTap } from "@/lib/handoff";
import { Lamp, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

interface Site { siteId: number; label: string }
interface Registry { authority: string; partners: string[]; sites: Site[] }
const labelOf = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, "");

function friendly(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/prior credit|insufficient|0x1\b/i.test(m)) return "This wallet has no SOL on devnet. Send the address (above) to the operator or press “1 SOL airdrop (test)”.";
  if (/rejected|declined|cancel|abgelehnt/i.test(m)) return "Signature rejected or cancelled in the wallet app. Press again and confirm in Phantom.";
  if (/not connected|wallet.*connect|No wallet/i.test(m)) return "Wallet is no longer connected. Reconnect above.";
  if (/ChunkLoadError|Loading chunk|dynamically imported module/i.test(m)) return "Page is outdated (new version online). Reload the page and retry.";
  if (/429|Too Many Requests/i.test(m)) return "Devnet RPC overloaded (429). Wait 10 seconds, then press again.";
  return m;
}

export function CertifyConsole() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [registry, setRegistry] = useState<Registry | null | undefined>(undefined);
  const [form, setForm] = useState({ serial: "SN-2026-000004", brand: "", name: "", batch: "", siteId: 1, kind: 1, uid: "", useCore: true });
  const [simTags, setSimTags] = useState<SimTag[]>([]);
  const [recent, setRecent] = useState<{ uid: string; counter: number | null } | null>(null);
  useEffect(() => { const t = lastTap.get(); if (t) setRecent({ uid: t.uid, counter: t.counter }); }, []);
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
    } catch (e) { setRegistry(null); setError(`Registry unreadable: ${(e as Error).message}`); }
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
      note(`Core asset ${signer.publicKey.toString()} minted`);
    } catch (e) { setError(`Core mint failed: ${friendly(e)}`); }
    finally { setBusy(null); }
  };
  const airdrop = async () => {
    if (!wallet.publicKey) return;
    setBusy("airdrop"); setError(null);
    try { const s = await connection.requestAirdrop(wallet.publicKey, 1e9); await connection.confirmTransaction(s, "confirmed"); note("1 SOL airdrop"); }
    catch (e) { setError(`Airdrop: ${(e as Error).message}`); } finally { setBusy(null); }
  };
  const usePlaceholder = () => { const k = Keypair.generate().publicKey.toBase58(); setAsset(k); note(`Placeholder asset ${k.slice(0, 8)}…`); };

  const sendViaWallet = (tx: Transaction) => sendAsV0(wallet, connection, tx);

  const mintPassport = async () => {
    if (!anchorWallet || !wallet.publicKey || !asset) return;
    setBusy("mint"); setError(null);
    try {
      if (!form.serial.trim() || !form.brand.trim() || !form.name.trim()) throw new Error("Serial number, brand and name must be filled in (they appear in the passport)");
      if (!/^[0-9A-Fa-f]{14}$/.test(form.uid)) throw new Error("UID of the first seal (7 bytes hex) is needed for the binding_hash");
      const program = flaconProgram(connection, anchorWallet);
      const sh = serialHash(form.serial), uh = uidHash(form.uid);
      let bh = bindingHash(form.serial, form.batch, uh);
      const pda = passportPda(sh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = (await (program.account as any).passport.fetchNullable(pda)) as { issuer: PublicKey; asset: PublicKey; bindingHash: number[] } | null;
      let sig: string, usedAsset = asset, recovered = false;
      if (existing) {
        // The passport is already on chain (e.g. the wallet app sent it but the answer never reached this page).
        if (existing.issuer.toBase58() !== wallet.publicKey.toBase58()) throw new Error(`Passport ${form.serial} already exists and belongs to another wallet (${existing.issuer.toBase58().slice(0, 8)}…)`);
        usedAsset = existing.asset.toBase58(); bh = Uint8Array.from(existing.bindingHash);
        sig = (await creatingSignature(connection, pda)) ?? "";
        recovered = true; setAsset(usedAsset);
      } else {
        const tx = await program.methods.mintPassport(Array.from(sh), Array.from(bh), new PublicKey(asset))
          .accountsStrict({ registry: registryPda(), passport: pda, issuer: wallet.publicKey, systemProgram: SystemProgram.programId }).transaction();
        sig = await sendViaWallet(tx);
      }
      setTxs((t) => ({ ...t, mint: sig }));
      await api.events({ serial: form.serial, type: 0, txSig: sig, actor: wallet.publicKey.toBase58(), payload: { brand: form.brand, name: form.name, batch: form.batch, asset: usedAsset, issuerLabel: site?.label ?? null, siteId: form.siteId, bindingHash: bytesToHex(bh, true) } });
      note(recovered ? `Passport ${form.serial} was already on chain · log backfilled (${sig.slice(0, 12)}…)` : `mint_passport ${form.serial} · ${sig.slice(0, 12)}…`);
    } catch (e) { setError(friendly(e)); }
    finally { setBusy(null); }
  };

  const attachSeal = async () => {
    if (!anchorWallet || !wallet.publicKey) return;
    setBusy("seal"); setError(null);
    try {
      if (!/^[0-9A-Fa-f]{14}$/.test(form.uid)) throw new Error("UID must be 7 bytes hex");
      const program = flaconProgram(connection, anchorWallet);
      const sh = serialHash(form.serial), uh = uidHash(form.uid);
      const pda = sealPda(uh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = (await (program.account as any).seal.fetchNullable(pda)) as { passport: PublicKey } | null;
      let sig: string, recovered = false;
      if (existing) {
        if (existing.passport.toBase58() !== passportPda(sh).toBase58()) throw new Error(`This seal is already attached to another passport (${existing.passport.toBase58().slice(0, 8)}…)`);
        sig = (await creatingSignature(connection, pda)) ?? ""; recovered = true;
      } else {
        const tx = await program.methods.attachSeal(Array.from(uh), form.kind)
          .accountsStrict({ registry: registryPda(), passport: passportPda(sh), seal: pda, signer: wallet.publicKey, systemProgram: SystemProgram.programId }).transaction();
        sig = await sendViaWallet(tx);
      }
      setTxs((t) => ({ ...t, seal: sig }));
      await api.events({ serial: form.serial, type: 1, txSig: sig, actor: wallet.publicKey.toBase58(), payload: { uid: form.uid.toUpperCase(), kind: form.kind, siteId: form.siteId } });
      note(recovered ? `Seal was already on chain · log backfilled (${sig.slice(0, 12)}…)` : `attach_seal ${form.uid.toUpperCase()} · ${sig.slice(0, 12)}…`);
    } catch (e) { setError(friendly(e)); }
    finally { setBusy(null); }
  };

  const newSimTag = async () => {
    setBusy("tag"); setError(null);
    try {
      const t = await fetch(`${PUBLIC_VERIFY_URL}/api/dev/tag`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: form.kind }) }).then((r) => r.json());
      setForm((f) => ({ ...f, uid: t.uid })); setSimTags((s) => [...s, t]); note(`Virtual tag ${t.uid}`);
    } catch (e) { setError(friendly(e)); } finally { setBusy(null); }
  };
  const readNfc = async () => {
    const w = window as unknown as { NDEFReader?: new () => { scan: () => Promise<void>; onreading: ((ev: { serialNumber?: string }) => void) | null } };
    if (!w.NDEFReader) { setError("WebNFC only in Android Chrome"); return; }
    const r = new w.NDEFReader(); await r.scan();
    r.onreading = (ev) => { const uid = (ev.serialNumber ?? "").replace(/:/g, "").toUpperCase(); if (uid.length === 14) setForm((f) => ({ ...f, uid })); };
    note("NFC ready — hold the chip to the phone (UID is taken over)");
  };
  const printCard = async () => {
    setBusy("print");
    try {
      const tpl = await fetch("/card-template.svg").then((r) => r.text());
      const svg = await cardSvgForSerial(tpl, form.serial);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a"); a.href = url; a.download = `Insert-card_${form.serial}.svg`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError(friendly(e)); } finally { setBusy(null); }
  };

  const field = (k: keyof typeof form, label: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label className="block text-sm"><span className="text-muted">{label}</span>
      <input value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm" />
    </label>
  );

  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Certification console · Vault / Partner</p>
      <h1 className="mt-3 font-serif text-4xl">Birth certificate</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">Create the passport, mint the Core asset, attach the seal, then the first scan at tier 4 with photo. Only wallets on the partner whitelist of the registry account.</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <WalletButton />
        {registry === undefined && wallet.connected && <span className="text-xs text-muted"><Loader2 className="inline h-3.5 w-3.5 animate-spin" aria-hidden /> Registry …</span>}
        {registry && <Pill tone={isPartner ? "ok" : "bad"}>{isPartner ? "Partner wallet confirmed" : "Wallet is not a partner"}</Pill>}
        {wallet.publicKey && <span className="mono text-xs text-muted" data-wallet={wallet.publicKey.toBase58()}>{wallet.publicKey.toBase58()}</span>}
        {registry === null && wallet.connected && <Pill tone="none">Registry not found — run scripts/seed-devnet.ts</Pill>}
        {wallet.connected && <button onClick={loadRegistry} className="btn-outline btn-sm">Reload registry</button>}
        {wallet.connected && DEV_SIMULATOR && <button onClick={airdrop} disabled={busy !== null} className="btn-outline btn-sm">1 SOL airdrop (test)</button>}
      </div>
      {error && <p className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <section className="card grid gap-4 p-5 sm:grid-cols-2">
            {field("serial", "Serial number", { placeholder: "SN-2026-000004" })}
            <label className="block text-sm"><span className="text-muted">Site (site_id)</span>
              <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: +e.target.value })} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm">
                {(registry?.sites ?? [{ siteId: 1, label: "Parfümerie X, Düsseldorf" }, { siteId: 2, label: "FlaconVault Vault, Wickede" }]).map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId} · {s.label}</option>)}
              </select>
            </label>
            {field("brand", "Brand", { placeholder: "Roja Parfums" })}
            {field("name", "Name", { placeholder: "Haute Luxe" })}
            {field("batch", "Batch", { placeholder: "4A12" })}
            <label className="block text-sm"><span className="text-muted">Seal</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: +e.target.value })} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"><option value={1}>Neck</option><option value={0}>Box</option></select>
            </label>
            <div className="sm:col-span-2">
              {field("uid", "Chip UID (7 bytes hex)", { placeholder: "04A1B2C3D4E5F6" })}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={readNfc} className="btn-outline btn-sm">Read UID via NFC</button>
                {recent && <button onClick={() => setForm({ ...form, uid: recent.uid })} className="btn-outline btn-sm">UID from the last tap: <span className="mono">{recent.uid}</span></button>}
                {DEV_SIMULATOR && <button onClick={newSimTag} disabled={busy !== null} className="btn-outline btn-sm">Create new virtual tag</button>}
                {DEV_SIMULATOR && simTags.filter((t) => !t.serial).map((t) => <button key={t.uid} onClick={() => setForm({ ...form, uid: t.uid })} className="btn-outline btn-sm mono">{t.uid}</button>)}
              </div>
            </div>
          </section>

          <section className="card p-5">
            <p className="text-sm font-medium">1 · Core asset</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={mintCore} disabled={busy !== null || !wallet.connected} className="btn btn-sm">{busy === "core" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Mint Metaplex Core</button>
              <button onClick={usePlaceholder} className="btn-outline btn-sm">Placeholder (localnet)</button>
              {asset && <span className="mono text-xs text-muted">Asset {asset.slice(0, 10)}…</span>}
            </div>
            {!wallet.connected && <p className="mt-2 text-xs text-muted">Connect the wallet above first; the button then becomes active.</p>}
            {busy === "core" && <p className="mt-2 text-xs text-muted">Waiting for confirmation in the wallet app … If Phantom does not open by itself: open the app, confirm the request, return to Chrome.</p>}
            {error && busy === null && <p className="mt-3 rounded-xl border border-bad/40 px-3 py-2 text-xs text-bad">{error}</p>}
          </section>
          <section className="card p-5">
            <p className="text-sm font-medium">2 · Create passport (mint_passport)</p>
            <p className="mt-1 text-xs text-muted">binding_hash = sha256(serial ‖ batch ‖ uid_hash of the first seal)</p>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={mintPassport} disabled={busy !== null || !isPartner || !asset} className="btn btn-sm">{busy === "mint" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Mint passport</button>
              {txs.mint && <a href={txUrl(txs.mint)} target="_blank" rel="noreferrer" className="link text-xs text-muted">tx {txs.mint.slice(0, 10)}…</a>}
            </div>
          </section>
          <section className="card p-5">
            <p className="text-sm font-medium">3 · Attach seal (attach_seal)</p>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={attachSeal} disabled={busy !== null || !isPartner} className="btn btn-sm">{busy === "seal" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Attach seal</button>
              {txs.seal && <a href={txUrl(txs.seal)} target="_blank" rel="noreferrer" className="link text-xs text-muted">tx {txs.seal.slice(0, 10)}…</a>}
            </div>
          </section>
          <section className="card p-5">
            <p className="text-sm font-medium">4 · First scan tier 4 (birth) with photo</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Link href={`/scan?role=4&tier=4&site=${form.siteId}`} className="btn btn-sm"><ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Go to scan <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
              <button onClick={printCard} disabled={busy !== null} className="btn-outline btn-sm"><Printer className="h-3.5 w-3.5" aria-hidden /> Print card with QR (SVG)</button>
              {txs.mint && <Link href={`/p/${form.serial}`} className="link text-sm">View passport</Link>}
            </div>
          </section>
        </div>
        <aside>
          <p className="eyebrow">Log</p>
          <ol className="mt-3 space-y-2 text-xs">
            {log.length === 0 && <li className="text-muted">Nothing yet.</li>}
            {log.map((l, i) => <li key={i} className="card flex items-center gap-2 p-2"><Lamp tone="ok" /><span className="break-all">{l}</span></li>)}
          </ol>
        </aside>
      </div>
    </div>
  );
}
