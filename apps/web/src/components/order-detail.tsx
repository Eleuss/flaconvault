"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ArrowRight, Loader2 } from "lucide-react";
import { EventType, hexToBytes, serialHash } from "@flaconvault/proof";
import { passportPda, scanPda, sealPda } from "@/lib/flacon";
import { escrowProgram, escrowIx, fetchConfig, fetchOrders, OrderState, orderStateLabel, orderStateTone, FILL_TOLERANCE, type EscrowConfigView, type OrderView } from "@/lib/escrow";
import { api } from "@/lib/verify-api";
import type { Passport, PassportEvent } from "@/lib/api";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { fmtDate, gradeLetter, short, txUrl } from "@/lib/format";
import { GradeMark, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

const STEPS = [OrderState.LISTED, OrderState.RESERVED, OrderState.PRESHIP_SCANNED, OrderState.SHIPPED, OrderState.RECEIPT_SCANNED, OrderState.RELEASED];
interface ScanOpt { counter: number; ts: number; fill: number | null; pda: PublicKey; label: string }

export function OrderDetail({ serial }: { serial: string }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [passport, setPassport] = useState<Passport | null>(null);
  const [order, setOrder] = useState<OrderView | null | undefined>(undefined);
  const orderRef = useRef<OrderView | null | undefined>(undefined);
  useEffect(() => { orderRef.current = order; }, [order]);
  const [config, setConfig] = useState<EscrowConfigView | null>(null);
  const [scanChoice, setScanChoice] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = (await fetch(`${PUBLIC_VERIFY_URL}/api/passport/${encodeURIComponent(serial)}`).then((r) => (r.ok ? r.json() : null))) as Passport | null;
      setPassport(p);
      const prog = escrowProgram(connection);
      setConfig(await fetchConfig(prog));
      const pp = passportPda(serialHash(serial)).toBase58();
      const mine = (await fetchOrders(prog)).filter((o) => o.passport.toBase58() === pp);
      const active = mine.find((o) => o.state !== OrderState.RELEASED && o.state !== OrderState.CANCELLED && o.state !== OrderState.DISPUTE) ?? mine[0] ?? null;
      setOrder(active);
    } catch (e) { setError((e as Error).message); setOrder(null); }
  }, [connection, serial]);
  useEffect(() => { load(); }, [load]);

  const me = wallet.publicKey?.toBase58();
  const isSeller = !!(order && me && order.seller.toBase58() === me);
  const isBuyer = !!(order && me && order.buyer?.toBase58() === me);
  const isAdmin = !!(config && me && config.admin === me);
  const seal = passport?.seals[0];
  const sealKey = seal ? sealPda(hexToBytes(seal.uidHash)) : null;

  // scans by the connected wallet on this passport → ScanProof PDAs (server payload carries counter + fill)
  const myScans: ScanOpt[] = (passport?.events ?? [])
    .filter((e: PassportEvent) => e.type === EventType.SCAN && e.actor === me && typeof e.payload.counter === "number" && e.status !== "failed")
    .map((e) => ({ counter: e.payload.counter as number, ts: e.ts, fill: typeof e.payload.fill === "number" ? e.payload.fill : null, pda: scanPda(sealKey!, e.payload.counter as number), label: `Zähler ${e.payload.counter} · ${fmtDate(e.ts)}${typeof e.payload.fill === "number" ? ` · Füllstand ${e.payload.fill} %` : ""}` }))
    .reverse();

  type Ev = { type: number; payload?: Record<string, unknown> };
  const run = async (label: string, fn: () => Promise<string>, event?: Ev | ((after: OrderView | null | undefined) => Ev | null)) => {
    if (!wallet.publicKey) return;
    setBusy(label); setError(null);
    const before = order ? `${order.state}:${order.buyer?.toBase58() ?? ""}:${order.sellerScan?.toBase58() ?? ""}:${order.buyerScan?.toBase58() ?? ""}` : "";
    try {
      const sig = await fn();
      setLastTx(sig);
      // public RPCs are load-balanced: a read right after confirmation can lag — poll until the order changed
      for (let i = 0; i < 8; i++) {
        await load();
        const o = orderRef.current;
        const after = o ? `${o.state}:${o.buyer?.toBase58() ?? ""}:${o.sellerScan?.toBase58() ?? ""}:${o.buyerScan?.toBase58() ?? ""}` : "";
        if (after !== before) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const ev = typeof event === "function" ? event(orderRef.current) : event;
      if (ev) await api.events({ serial, type: ev.type, txSig: sig, actor: wallet.publicKey.toBase58(), payload: ev.payload ?? {} });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const prog = () => escrowProgram(connection, anchorWallet!);
  const chosen = myScans.find((s) => s.pda.toBase58() === scanChoice) ?? myScans[0];
  const sellerScanCounter = passport?.events.find((e) => e.type === EventType.SHIP)?.payload.preShipScanCounter as number | undefined;
  const now = Date.now() / 1000;
  const timeoutReached = !!(order && order.state === OrderState.SHIPPED && now > order.shippedAt + order.disputeAfterS);

  const act = {
    reserve: () => run("reserve", () => escrowIx.reserve(prog(), order!, wallet.publicKey!, config!.usdcMint).rpc(), { type: EventType.RESERVE, payload: { priceUsdc: order!.priceUsdc, currency: "USDC" } }),
    preShip: () => run("preShip", () => escrowIx.preShip(prog(), order!, chosen!.pda, sealKey!).rpc()),
    ship: () => run("ship", () => escrowIx.ship(prog(), order!).rpc(), { type: EventType.SHIP, payload: { carrier: "DHL", preShipScanCounter: chosen?.counter ?? sellerScanCounter ?? null } }),
    receipt: () => run("receipt", () => escrowIx.receipt(prog(), order!, chosen!.pda, sealKey!).rpc(), (after) => ({
      type: EventType.RECEIVE,
      payload: { receiptScanCounter: chosen!.counter, preShipScanCounter: sellerScanCounter ?? null, match: after?.state === OrderState.RECEIPT_SCANNED, fillDelta: null },
    })),
    release: () => run("release", () => escrowIx.release(prog(), order!, wallet.publicKey!, config!.usdcMint).rpc(), { type: EventType.RELEASE, payload: { priceUsdc: order!.priceUsdc, currency: "USDC", to: order!.seller.toBase58(), passportTo: order!.buyer?.toBase58() } }),
    dispute: () => run("dispute", () => escrowIx.dispute(prog(), order!, wallet.publicKey!, config!.usdcMint, seal?.dead && sealKey ? sealKey : null).rpc(), { type: EventType.DISPUTE, payload: { reason: seal?.dead ? "Siegel antwortet nicht" : timeoutReached ? "kein Empfangs-Scan binnen Frist" : order!.state === OrderState.MISMATCH ? "Scans weichen ab" : "Admin" } }),
    cancel: () => run("cancel", () => escrowIx.cancel(prog(), order!).rpc()),
  };

  if (order === undefined) return <div className="container-page py-16 text-sm text-muted"><Loader2 className="inline h-4 w-4 animate-spin" aria-hidden /> Lade Order …</div>;

  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow"><Link href="/market" className="hover:text-ink">Markt</Link> · {serial}</p>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-4xl">{passport ? `${passport.brand} · ${passport.name}` : serial}</h1>
          {passport && <p className="mt-2 text-sm text-muted">Grade {gradeLetter(passport.void ? 4 : passport.grade)} · {passport.stats.scanCount} Scans · Siegel {passport.sealStatus === "INTACT" ? "intakt" : passport.sealStatus === "NO_RESPONSE" ? "antwortet nicht" : "geöffnet"} · <Link href={`/p/${serial}`} className="link">Pass ansehen</Link></p>}
        </div>
        {passport && <GradeMark grade={passport.void ? 4 : passport.grade} />}
      </div>
      {error && <p className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}
      {lastTx && <p className="mt-4 text-xs text-muted">Letzte Transaktion: <a className="link" href={txUrl(lastTx)} target="_blank" rel="noreferrer">{short(lastTx, 8)}</a></p>}

      {!order ? (
        <div className="card mt-8 p-5 text-sm">
          <p className="font-medium">Kein Listing für diesen Pass.</p>
          <p className="mt-1 text-muted">Als Verkäufer im <Link href="/market" className="link">Markt</Link> listen.</p>
        </div>
      ) : (
        <>
          <section className="card mt-8 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="tabular text-2xl">{order.priceUsdc.toLocaleString("de-DE")} USDC</p>
              <Pill tone={orderStateTone(order.state)}>{orderStateLabel[order.state]}</Pill>
            </div>
            <ol className="mt-5 grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
              {STEPS.map((s) => {
                const reached = order.state >= s && order.state <= OrderState.RELEASED;
                return <li key={s} className={`rounded-lg border px-2 py-2 text-center ${reached ? "border-ink text-ink" : "border-line text-muted"}`}>{orderStateLabel[s]}</li>;
              })}
            </ol>
            <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-3">
              <div><dt>Verkäufer</dt><dd className="text-ink"><Link href={`/wallet/${order.seller.toBase58()}`} className="link">{short(order.seller.toBase58())}</Link></dd></div>
              <div><dt>Käufer</dt><dd className="text-ink">{order.buyer ? <Link href={`/wallet/${order.buyer.toBase58()}`} className="link">{short(order.buyer.toBase58())}</Link> : "–"}</dd></div>
              <div><dt>Gelistet</dt><dd className="text-ink">{fmtDate(order.listedAt)}</dd></div>
              <div><dt>Versand-Scan</dt><dd className="mono text-ink">{order.sellerScan ? short(order.sellerScan.toBase58()) : "–"}</dd></div>
              <div><dt>Empfangs-Scan</dt><dd className="mono text-ink">{order.buyerScan ? short(order.buyerScan.toBase58()) : "–"}</dd></div>
              <div><dt>Frist</dt><dd className="text-ink">{order.shippedAt ? `${fmtDate(order.shippedAt + order.disputeAfterS)}${timeoutReached ? " · abgelaufen" : ""}` : `${Math.round(order.disputeAfterS / 86400)} Tage nach Versand`}</dd></div>
            </dl>
          </section>

          <section className="card mt-6 p-5">
            <p className="text-sm font-medium">Nächster Schritt</p>
            {!wallet.connected && <div className="mt-3"><WalletButton /></div>}
            {wallet.connected && (
              <div className="mt-3 space-y-3 text-sm">
                {order.state === OrderState.LISTED && !isSeller && (
                  <div className="flex flex-wrap items-center gap-3">
                    <button onClick={act.reserve} disabled={busy !== null || !config} className="btn btn-sm">{busy === "reserve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Reservieren · {order.priceUsdc} USDC in den Vault</button>
                    <span className="text-xs text-muted">Braucht ein USDC-Konto mit Guthaben (Mint {config ? short(config.usdcMint.toBase58()) : "?"}).</span>
                  </div>
                )}
                {order.state === OrderState.LISTED && isSeller && <button onClick={act.cancel} disabled={busy !== null} className="btn-outline btn-sm">Listing zurückziehen</button>}
                {(order.state === OrderState.RESERVED && isSeller) && (
                  <div className="space-y-2">
                    <p className="text-muted">Versand-Scan (Tier 2, mit Foto) machen und dann hier erfassen. Der Scan muss von dieser Wallet stammen.</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href="/scan?role=1" className="btn-outline btn-sm">Versand-Scan machen <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                      <select value={chosen?.pda.toBase58() ?? ""} onChange={(e) => setScanChoice(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
                        {myScans.length === 0 && <option value="">— noch kein eigener Scan —</option>}
                        {myScans.map((s) => <option key={s.pda.toBase58()} value={s.pda.toBase58()}>{s.label}</option>)}
                      </select>
                      <button onClick={act.preShip} disabled={busy !== null || !chosen} className="btn btn-sm">{busy === "preShip" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Versand-Scan erfassen</button>
                    </div>
                  </div>
                )}
                {order.state === OrderState.PRESHIP_SCANNED && isSeller && <button onClick={act.ship} disabled={busy !== null} className="btn btn-sm">{busy === "ship" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Als versendet markieren</button>}
                {order.state === OrderState.SHIPPED && isBuyer && (
                  <div className="space-y-2">
                    <p className="text-muted">Nach Empfang: Scan (Tier 2, mit Foto) machen und erfassen. Freigabe, wenn Hitze und Feuchte gleich sind und der Füllstand um höchstens {FILL_TOLERANCE} % abweicht.</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href="/scan?role=2" className="btn-outline btn-sm">Empfangs-Scan machen <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                      <select value={chosen?.pda.toBase58() ?? ""} onChange={(e) => setScanChoice(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
                        {myScans.length === 0 && <option value="">— noch kein eigener Scan —</option>}
                        {myScans.map((s) => <option key={s.pda.toBase58()} value={s.pda.toBase58()}>{s.label}</option>)}
                      </select>
                      <button onClick={act.receipt} disabled={busy !== null || !chosen} className="btn btn-sm">{busy === "receipt" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Empfangs-Scan erfassen</button>
                    </div>
                  </div>
                )}
                {order.state === OrderState.RECEIPT_SCANNED && <button onClick={act.release} disabled={busy !== null || !config} className="btn btn-sm">{busy === "release" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Freigeben · USDC → Verkäufer, Pass → Käufer</button>}
                {((order.state === OrderState.MISMATCH && (isBuyer || isAdmin)) || (order.state === OrderState.SHIPPED && isBuyer && (timeoutReached || seal?.dead)) || (isAdmin && [OrderState.RESERVED, OrderState.PRESHIP_SCANNED, OrderState.SHIPPED].includes(order.state as 1 | 2 | 3)) || (isBuyer && seal?.dead && [OrderState.RESERVED, OrderState.PRESHIP_SCANNED].includes(order.state as 1 | 2))) && (
                  <button onClick={act.dispute} disabled={busy !== null || !config} className="btn-outline btn-sm text-bad">{busy === "dispute" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Dispute · USDC zurück an Käufer</button>
                )}
                {[OrderState.RELEASED, OrderState.DISPUTE, OrderState.CANCELLED].includes(order.state as 5 | 7 | 8) && <p className="text-muted">Abgeschlossen. Die Geschichte steht im <Link href={`/p/${serial}`} className="link">Pass</Link>.</p>}
                {order.state === OrderState.RESERVED && !isSeller && <p className="text-muted">Warten auf den Versand-Scan des Verkäufers.</p>}
                {order.state === OrderState.PRESHIP_SCANNED && !isSeller && <p className="text-muted">Warten auf den Versand.</p>}
                {order.state === OrderState.SHIPPED && !isBuyer && <p className="text-muted">Unterwegs. Der Käufer erfasst den Empfangs-Scan.</p>}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
