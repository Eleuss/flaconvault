"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { ArrowRight, Loader2, Tag } from "lucide-react";
import { EventType, serialHash } from "@flaconvault/proof";
import { fetchCoreAsset, fetchPassportChain, passportPda } from "@/lib/flacon";
import { escrowProgram, fetchConfig, fetchOrders, escrowIx, orderPda, orderStateLabel, orderStateTone, type OrderView } from "@/lib/escrow";
import { formatUsdc, isValidSerial, orderPath, parsePriceUsdc } from "@/lib/escrow-rules";
import { api } from "@/lib/verify-api";
import { forgetPending, rememberPending } from "@/lib/pending-events";
import { sendAsV0 } from "@/lib/send-tx";
import { friendly } from "@/lib/errors";
import type { PassportListItem } from "@/lib/api";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { isTestPassport, short } from "@/lib/format";
import { GradeMark, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

/**
 * A listing that landed on chain but whose LIST event did not reach the verifier yet. It is also stored as the order's
 * pending event (lib/pending-events.ts), so after a reload the order page offers "Retry confirmation".
 */
interface PendingList { sig: string; serial: string; priceBase: string; order: string }
const listPayload = (p: PendingList) => ({ priceUsdc: Number(formatUsdc(BigInt(p.priceBase))), currency: "USDC", market: "flaconvault" });

export function MarketList() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [passports, setPassports] = useState<PassportListItem[]>([]);
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [configOk, setConfigOk] = useState<boolean | null>(null);
  const [form, setForm] = useState({ serial: "", price: "480" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingList | null>(null);
  const serialByPassport = new Map(passports.filter((p) => isValidSerial(p.serial)).map((p) => [passportPda(serialHash(p.serial)).toBase58(), p]));
  const price = parsePriceUsdc(form.price);

  const load = useCallback(async () => {
    try {
      const prog = escrowProgram(connection);
      const list = (await fetch(`${PUBLIC_VERIFY_URL}/api/passports`).then((r) => (r.ok ? r.json() : []))) as PassportListItem[];
      setPassports(list);
      setConfigOk(!!(await fetchConfig(prog)));
      setOrders(await fetchOrders(prog));
    } catch (e) { setError(friendly(e)); setOrders([]); }
  }, [connection]);
  useEffect(() => { load(); }, [load]);

  const postList = async (p: PendingList) => {
    if (!wallet.publicKey) return;
    await api.events({ serial: p.serial, type: EventType.LIST, txSig: p.sig, actor: wallet.publicKey.toBase58(), payload: { ...listPayload(p), order: p.order } });
    forgetPending(p.order, p.sig);
    setPending(null);
  };
  const retryConfirmation = async () => {
    if (!pending) return;
    setBusy(true); setError(null);
    try { await postList(pending); await load(); } catch (e) { setError(`The listing is on chain, but the history entry failed: ${friendly(e)}`); } finally { setBusy(false); }
  };

  const list = async () => {
    if (!wallet.publicKey || !form.serial) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (!isValidSerial(form.serial)) throw new Error("This serial number cannot be listed (invalid format).");
      if (price === null) throw new Error("Enter a price in USDC greater than 0, with at most 6 decimals (for example 480 or 480.50).");
      const seller = wallet.publicKey;
      const passport = passportPda(serialHash(form.serial));
      const chain = await fetchPassportChain(connection, passport);
      if (!chain) throw new Error("This passport is not on chain (yet).");
      if (chain.void || chain.grade === 4) throw new Error("This passport is VOID and cannot be listed.");
      // the program lets the owner of the Core asset list (or the issuer, when there is no Core asset)
      const core = await fetchCoreAsset(connection, chain.asset);
      const allowed = core ? core.owner.equals(seller) : chain.issuer.equals(seller);
      if (!allowed) throw new Error(core ? "Only the owner of this bottle's Core asset can list it. Connect that wallet." : "Only the issuer of this passport can list it. Connect that wallet.");
      const prog = escrowProgram(connection);
      const tx = new Transaction().add(await escrowIx.list(prog, passport, seller, price, chain.asset).instruction());
      // the Core asset goes into escrow custody and moves to the buyer on release (not possible for assets in a collection)
      const deposit = !!core && !core.inCollection;
      if (deposit) tx.add(await escrowIx.depositAsset(prog, orderPda(passport, seller), seller, chain.asset).instruction());
      const sig = await sendAsV0(wallet, connection, tx);
      const p: PendingList = { sig, serial: form.serial, priceBase: price.toString(), order: orderPda(passport, seller).toBase58() };
      setPending(p);
      rememberPending(p.order, { sig: p.sig, type: EventType.LIST, payload: listPayload(p) });
      setNotice(deposit ? "Listed. The bottle's Core asset is now held by the escrow and goes to the buyer on release." : "Listed.");
      await postList(p);
      await load();
    } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };

  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow">Market · escrow in devnet USDC</p>
      <h1 className="mt-3 font-serif text-4xl">Handover with escrow</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">Listing → reservation (USDC in the vault) → shipping scan → shipped → receipt scan → release. Money only moves when the seller’s scan before shipping and the buyer’s scan after receipt agree.</p>
      {configOk === false && <p className="mt-4 rounded-xl border border-line px-4 py-3 text-sm text-muted">The market is not set up on this network yet.</p>}
      {error && <p role="alert" className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}
      {notice && !error && <p className="mt-4 rounded-xl border border-line px-4 py-3 text-sm text-muted">{notice}</p>}
      {pending && error && (
        <p className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <button onClick={retryConfirmation} disabled={busy} className="btn-outline btn-sm">Retry confirmation</button>
          <span className="text-muted">This browser remembers it: the <Link href={orderPath(pending.order)} className="link">order page</Link> offers the retry later too.</span>
        </p>
      )}

      <section className="card mt-8 p-5">
        <p className="flex items-center gap-2 text-sm font-medium"><Tag className="h-4 w-4 text-amber" aria-hidden /> Create listing (owner of the bottle)</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
            <option value="">— Choose passport —</option>
            {passports.filter((p) => !p.void && !isTestPassport(p) && isValidSerial(p.serial)).map((p) => <option key={p.serial} value={p.serial}>{p.serial} · {p.brand} {p.name}</option>)}
          </select>
          <label className="text-sm text-muted">Price <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="decimal" aria-invalid={price === null} className="ml-1 w-24 rounded-full border border-line bg-surface px-3 py-1.5 text-sm tabular" /> USDC</label>
          {wallet.connected ? <button onClick={list} disabled={busy || !form.serial || configOk === false || price === null} className="btn btn-sm">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} List</button> : <WalletButton />}
        </div>
        {price === null && <p className="mt-2 text-xs text-bad">Price: a number greater than 0 with at most 6 decimals (dot as separator).</p>}
        <p className="mt-2 text-xs text-muted">Only the wallet that owns the bottle’s Core asset can list it.</p>
      </section>

      <section className="mt-8">
        <p className="eyebrow">Offers</p>
        {orders === null ? <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading orders …</p> : orders.length === 0 ? <p className="mt-3 text-sm text-muted">No listings yet.</p> : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {orders.map((o) => {
              const p = serialByPassport.get(o.passport.toBase58());
              const serial = p?.serial ?? short(o.passport.toBase58());
              return (
                <li key={o.pubkey.toBase58()}>
                  <Link href={orderPath(o.pubkey.toBase58())} className="flex items-center gap-4 py-4 transition hover:bg-surface">
                    <GradeMark grade={p ? (p.void ? 4 : p.grade) : null} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p ? `${p.brand} · ${p.name}` : short(o.passport.toBase58())}</p>
                      <p className="mono text-muted">{serial} · seller {short(o.seller.toBase58())}{o.buyer ? ` · buyer ${short(o.buyer.toBase58())}` : ""}</p>
                    </div>
                    <p className="tabular text-sm">{formatUsdc(o.priceBase)} USDC</p>
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
