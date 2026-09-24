"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ArrowRight, Loader2, Tag } from "lucide-react";
import { serialHash } from "@flaconvault/proof";
import { passportPda } from "@/lib/flacon";
import { escrowProgram, fetchConfig, fetchOrders, escrowIx, orderStateLabel, orderStateTone, type OrderView } from "@/lib/escrow";
import { api } from "@/lib/verify-api";
import type { PassportListItem } from "@/lib/api";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { short } from "@/lib/format";
import { GradeMark, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

export function MarketList() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [passports, setPassports] = useState<PassportListItem[]>([]);
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [configOk, setConfigOk] = useState<boolean | null>(null);
  const [form, setForm] = useState({ serial: "", price: "480" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serialByPassport = new Map(passports.map((p) => [passportPda(serialHash(p.serial)).toBase58(), p]));

  const load = useCallback(async () => {
    try {
      const [ps, prog] = [await fetch(`${PUBLIC_VERIFY_URL}/api/passports`).then((r) => r.json()) as Promise<PassportListItem[]>, escrowProgram(connection)];
      const list = await ps; setPassports(list);
      setConfigOk(!!(await fetchConfig(prog)));
      setOrders(await fetchOrders(prog));
    } catch (e) { setError((e as Error).message); setOrders([]); }
  }, [connection]);
  useEffect(() => { load(); }, [load]);

  const list = async () => {
    if (!anchorWallet || !wallet.publicKey || !form.serial) return;
    setBusy(true); setError(null);
    try {
      const prog = escrowProgram(connection, anchorWallet);
      const passport = passportPda(serialHash(form.serial));
      const sig = await escrowIx.list(prog, passport, wallet.publicKey, Number(form.price)).rpc();
      await api.events({ serial: form.serial, type: 3, txSig: sig, actor: wallet.publicKey.toBase58(), payload: { priceUsdc: Number(form.price), currency: "USDC", market: "flaconvault" } });
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Markt · Escrow auf Devnet-USDC</p>
      <h1 className="mt-3 font-serif text-4xl">Handover mit Escrow</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">Listing → Reservierung (USDC im Vault) → Versand-Scan → Versand → Empfangs-Scan → Freigabe. Geld fließt erst, wenn Verkäufer-Scan vor Versand und Käufer-Scan nach Empfang übereinstimmen.</p>
      {configOk === false && <p className="mt-4 rounded-xl border border-line px-4 py-3 text-sm text-muted">Escrow-Konfiguration fehlt auf dieser Cluster — <code className="mono">scripts/seed-escrow.ts</code> ausführen.</p>}
      {error && <p className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}

      <section className="card mt-8 p-5">
        <p className="flex items-center gap-2 text-sm font-medium"><Tag className="h-4 w-4 text-amber" aria-hidden /> Listing anlegen (Verkäufer)</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
            <option value="">— Pass wählen —</option>
            {passports.filter((p) => !p.void).map((p) => <option key={p.serial} value={p.serial}>{p.serial} · {p.brand} {p.name}</option>)}
          </select>
          <label className="text-sm text-muted">Preis <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="decimal" className="ml-1 w-24 rounded-full border border-line bg-surface px-3 py-1.5 text-sm tabular" /> USDC</label>
          {wallet.connected ? <button onClick={list} disabled={busy || !form.serial || configOk === false} className="btn btn-sm">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Listen</button> : <WalletButton />}
        </div>
      </section>

      <section className="mt-8">
        <p className="eyebrow">Angebote</p>
        {orders === null ? <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Lade Orders …</p> : orders.length === 0 ? <p className="mt-3 text-sm text-muted">Noch keine Listings.</p> : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {orders.map((o) => {
              const p = serialByPassport.get(o.passport.toBase58());
              const serial = p?.serial ?? o.passport.toBase58();
              return (
                <li key={o.pubkey.toBase58()}>
                  <Link href={`/market/${serial}`} className="flex items-center gap-4 py-4 transition hover:bg-surface">
                    <GradeMark grade={p ? (p.void ? 4 : p.grade) : null} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p ? `${p.brand} · ${p.name}` : short(o.passport.toBase58())}</p>
                      <p className="mono text-muted">{serial} · Verkäufer {short(o.seller.toBase58())}{o.buyer ? ` · Käufer ${short(o.buyer.toBase58())}` : ""}</p>
                    </div>
                    <p className="tabular text-sm">{o.priceUsdc.toLocaleString("de-DE")} USDC</p>
                    <Pill tone={orderStateTone(o.state)}>{orderStateLabel[o.state]}</Pill>
                    <ArrowRight className="h-4 w-4 text-muted" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
