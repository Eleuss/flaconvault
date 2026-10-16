"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type Transaction } from "@solana/web3.js";
import { ArrowRight, Loader2 } from "lucide-react";
import { EventType, hexToBytes, serialHash } from "@flaconvault/proof";
import { fetchSealStates, passportPda, scanPda, sealPda } from "@/lib/flacon";
import { escrowProgram, escrowIx, fetchConfig, fetchOrder, fetchOrders, OrderState, orderStateLabel, orderStateTone, FILL_TOLERANCE, type EscrowConfigView, type OrderView } from "@/lib/escrow";
import { availableActions, buyerNeedsAdmin, formatUsdc, isTerminal, isValidSerial, marketPassportPath, orderPath, passportPath, receiptDeadline, scanUsableForOrder, shipDeadline, stepScanChoice, type EscrowAction } from "@/lib/escrow-rules";
import { flushPending, loadPending, rememberPending, savePending, type PendingEvent } from "@/lib/pending-events";
import { api } from "@/lib/verify-api";
import { sendAsV0 } from "@/lib/send-tx";
import { ApiError, friendly } from "@/lib/errors";
import type { Passport, PassportEvent, PassportListItem } from "@/lib/api";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { fmtDate, gradeLetter, short, txUrl } from "@/lib/format";
import { GradeMark, Pill } from "./badges";
import { WalletButton } from "./wallet-button";

const STEPS = [OrderState.LISTED, OrderState.RESERVED, OrderState.PRESHIP_SCANNED, OrderState.SHIPPED, OrderState.RECEIPT_SCANNED, OrderState.RELEASED];
/** `unusable`: why the scan cannot stand for an order step (heat or humidity not decided), null when it can. */
interface ScanOpt { key: string; counter: number; ts: number; fill: number | null; pda: PublicKey; seal: PublicKey; label: string; unusable: string | null }
type Ev = { type: number; payload?: Record<string, unknown> };
/** The verifier already holds this entry (with another transaction): nothing left to retry. */
const alreadyRecorded = (e: unknown) => e instanceof ApiError && e.code === "event_confirmed";
/**
 * How a buyer reaches the escrow admin (who alone can refund a SHIPPED order): a mailto: or https: link from
 * NEXT_PUBLIC_ESCROW_ADMIN_CONTACT; without one the page shows the admin wallet only.
 */
const ADMIN_CONTACT = /^(mailto:|https:\/\/)/.test(process.env.NEXT_PUBLIC_ESCROW_ADMIN_CONTACT ?? "") ? process.env.NEXT_PUBLIC_ESCROW_ADMIN_CONTACT! : null;
const adminContactHref = (orderPda: string) =>
  ADMIN_CONTACT && ADMIN_CONTACT.startsWith("mailto:") && !ADMIN_CONTACT.includes("?") ? `${ADMIN_CONTACT}?subject=${encodeURIComponent(`FlaconVault order ${orderPda}`)}` : ADMIN_CONTACT;

async function passportFor(passport: PublicKey): Promise<{ serial: string; passport: Passport | null } | null> {
  const list = (await fetch(`${PUBLIC_VERIFY_URL}/api/passports`).then((r) => (r.ok ? r.json() : []))) as PassportListItem[];
  const hit = list.find((p) => isValidSerial(p.serial) && passportPda(serialHash(p.serial)).equals(passport));
  if (!hit) return null;
  const p = (await fetch(`${PUBLIC_VERIFY_URL}/api/passport/${encodeURIComponent(hit.serial)}`).then((r) => (r.ok ? r.json() : null))) as Passport | null;
  return { serial: hit.serial, passport: p };
}

/** /market/<serial>: the passport's orders. One open order is shown directly; several are listed (each has its own page). */
export function PassportOrders({ serial }: { serial: string }) {
  const { connection } = useConnection();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isValidSerial(serial)) { setOrders([]); return; }
    fetchOrders(escrowProgram(connection), { passport: passportPda(serialHash(serial)) }).then(setOrders).catch((e) => { setError(friendly(e)); setOrders([]); });
  }, [connection, serial]);
  if (orders === null) return <div className="container-page py-16 text-sm text-muted"><Loader2 className="inline h-4 w-4 animate-spin" aria-hidden /> Loading orders …</div>;
  const open = orders.filter((o) => !isTerminal(o.state));
  if (open.length === 1) return <OrderDetail orderPda={open[0].pubkey.toBase58()} />;
  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow"><Link href="/market" className="hover:text-ink">Market</Link> · {serial}</p>
      <h1 className="mt-3 font-serif text-4xl">Orders for {serial}</h1>
      {error && <p role="alert" className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}
      {orders.length === 0 ? (
        <div className="card mt-8 p-5 text-sm">
          <p className="font-medium">No listing for this passport.</p>
          <p className="mt-1 text-muted">The owner of the bottle can list it in the <Link href="/market" className="link">market</Link>. <Link href={passportPath(serial)} className="link">View passport</Link></p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {orders.map((o) => (
            <li key={o.pubkey.toBase58()}>
              <Link href={orderPath(o.pubkey.toBase58())} className="flex items-center gap-4 py-4 transition hover:bg-surface">
                <p className="mono min-w-0 flex-1 text-sm text-muted">seller {short(o.seller.toBase58())} · listed {fmtDate(o.listedAt)}</p>
                <p className="tabular text-sm">{formatUsdc(o.priceBase)} USDC</p>
                <Pill tone={orderStateTone(o.state)}>{orderStateLabel[o.state]}</Pill>
                <ArrowRight className="h-4 w-4 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** /market/o/<orderPda>: one order, addressed by its PDA (never "the newest order of this passport"). */
export function OrderDetail({ orderPda }: { orderPda: string }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const orderKey = useMemo(() => { try { return new PublicKey(orderPda); } catch { return null; } }, [orderPda]);
  const [serial, setSerial] = useState<string | null>(null);
  const [passport, setPassport] = useState<Passport | null>(null);
  const [order, setOrder] = useState<OrderView | null | undefined>(undefined);
  const orderRef = useRef<OrderView | null | undefined>(undefined);
  useEffect(() => { orderRef.current = order; }, [order]);
  const [config, setConfig] = useState<EscrowConfigView | null>(null);
  const [deadSeal, setDeadSeal] = useState<PublicKey | null>(null);
  const [scanChoice, setScanChoice] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  // every landed transaction whose history entry has not reached the verifier yet (oldest first, kept across reloads)
  const [pending, setPending] = useState<PendingEvent[]>([]);
  useEffect(() => { setPending(loadPending(orderPda)); }, [orderPda]);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), 30_000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    if (!orderKey) { setOrder(null); return; }
    try {
      const prog = escrowProgram(connection);
      const [cfg, o] = await Promise.all([fetchConfig(prog), fetchOrder(prog, orderKey)]);
      setConfig(cfg);
      setOrder(o);
      if (!o) return;
      const found = await passportFor(o.passport);
      setSerial(found?.serial ?? null);
      setPassport(found?.passport ?? null);
      // dead seals as the program sees them (the verifier's SEAL_DEAD reports do not count)
      const seals = found?.passport?.seals ?? [];
      const states = await fetchSealStates(connection, seals.map((s) => s.uidHash));
      setDeadSeal(states.find((s) => s.dead && s.passport?.equals(o.passport))?.pda ?? null);
    } catch (e) { setError(friendly(e)); setOrder((cur) => cur ?? null); }
  }, [connection, orderKey]);
  useEffect(() => { load(); }, [load]);

  const me = wallet.publicKey?.toBase58();
  const isSeller = !!(order && me && order.seller.toBase58() === me);
  const isBuyer = !!(order && me && order.buyer?.toBase58() === me);
  const isAdmin = !!(config && me && config.admin === me);

  // the connected wallet's anchored scans on this passport → ScanProof PDAs on the seal each scan was made on
  const myScans: ScanOpt[] = (passport?.events ?? [])
    .filter((e: PassportEvent) => e.type === EventType.SCAN && e.actor === me && e.status === "confirmed" && typeof e.payload.counter === "number" && !!e.sealUidHash)
    .map((e) => {
      const seal = sealPda(hexToBytes(e.sealUidHash!));
      const counter = e.payload.counter as number;
      const fill = typeof e.payload.fill === "number" ? e.payload.fill : null;
      const usable = scanUsableForOrder(e.payload.indicators as { heat?: unknown; humidity?: unknown } | undefined);
      const unusable = usable.ok ? null : usable.reason;
      const pda = scanPda(seal, counter);
      return { key: pda.toBase58(), counter, ts: e.ts, fill, seal, pda, unusable, label: `Counter ${counter} · ${fmtDate(e.ts)}${fill !== null ? ` · fill level ${fill} %` : ""}${unusable ? ` · ${unusable}, cannot be recorded` : ""}` };
    })
    .reverse();

  const postEvent = async (p: PendingEvent) => {
    if (!wallet.publicKey || !serial) throw new Error("The passport of this order is unknown to the verifier.");
    await api.events({ serial, type: p.type, txSig: p.sig, actor: wallet.publicKey.toBase58(), payload: { ...p.payload, order: orderPda } });
  };
  /** Posts every pending entry (oldest first) and keeps what failed; throws the first error after all were tried. */
  const postAllPending = async () => {
    const { left, error } = await flushPending(loadPending(orderPda), postEvent, alreadyRecorded);
    savePending(orderPda, left);
    setPending(left);
    if (error !== null) throw error;
  };
  const retryConfirmation = async () => {
    if (!pending.length) return;
    setBusy("retry"); setError(null);
    try { await postAllPending(); await load(); }
    catch (e) { setError(`The transaction is on chain, but the history entry failed again: ${friendly(e)}`); }
    finally { setBusy(null); }
  };

  const run = async (label: string, fn: () => Promise<string>, event?: Ev | ((after: OrderView | null | undefined) => Ev | null)) => {
    if (!wallet.publicKey) return;
    setBusy(label); setError(null);
    const before = order ? `${order.state}:${order.buyer?.toBase58() ?? ""}:${order.sellerScan?.toBase58() ?? ""}:${order.buyerScan?.toBase58() ?? ""}` : "";
    let landed: PendingEvent | null = null;
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
      if (ev) {
        // keep the landed transaction + planned event until the verifier has it, so it can be retried without
        // repeating the (now impossible) on-chain action; earlier unposted entries stay and are posted first
        landed = { sig, type: ev.type, payload: ev.payload ?? {} };
        setPending(rememberPending(orderPda, landed));
        await postAllPending();
      }
    } catch (e) {
      setError(landed ? `The transaction is on chain, but the history entry failed: ${friendly(e)}` : friendly(e));
    } finally { setBusy(null); }
  };
  // build with the read-only program (accountsStrict needs no provider wallet), then the wallet signs a v0 tx —
  // Anchor's .rpc() sends a legacy tx, which mobile wallets (MWA) return unsigned
  const prog = () => escrowProgram(connection);
  const send = async (b: { transaction(): Promise<Transaction> }) => sendAsV0(wallet, connection, await b.transaction());
  // only scans made after the step they stand for count (ScanBeforeOrderStep): after the reservation for the shipping
  // scan, after shipping for the receipt scan — an older scan (for example from when the seller bought the bottle) is
  // never offered
  const step = order?.state === OrderState.RESERVED ? "preShip" : order?.state === OrderState.SHIPPED ? "receipt" : null;
  // a scan with heat or humidity not decided (UNREADABLE / MISSING) is listed but cannot be chosen (stepScanChoice)
  const { offered: stepScans, chosen, olderHidden, undecided } = stepScanChoice(order, step, myScans, scanChoice);
  const noScanLabel = undecided > 0 ? "— no scan with heat and humidity read —"
    : olderHidden > 0 ? `— no scan of this wallet after the ${step === "receipt" ? "shipping" : "reservation"} yet —` : "— no anchored scan of this wallet yet —";
  const undecidedNote = undecided > 0
    ? `${undecided === 1 ? "One scan" : `${undecided} scans`} of this wallet cannot be recorded: heat and humidity must both be read (intact or triggered). The escrow compares them between the shipping and the receipt scan, and an unreadable or missing value cannot be compared. Do a new scan with a sharp, glare-free photo of the card.`
    : null;
  const sellerScanCounter = passport?.events.find((e) => e.type === EventType.SHIP && (e.payload.order === orderPda || e.payload.order === undefined))?.payload.preShipScanCounter as number | undefined;
  const viewer = { isSeller, isBuyer, isAdmin, sealDead: !!deadSeal };
  const actions: EscrowAction[] = order ? availableActions(order, viewer, now) : [];
  const askAdmin = order ? buyerNeedsAdmin(order, viewer) : null;
  const can = (a: EscrowAction) => actions.includes(a);
  const amount = order ? `${formatUsdc(order.priceBase)} USDC` : "";
  const assetNote = order?.assetDeposited ? ", Core asset → buyer" : "";

  const act = {
    reserve: () => run("reserve", () => send(escrowIx.reserve(prog(), order!, wallet.publicKey!, config!.usdcMint)), { type: EventType.RESERVE, payload: { priceUsdc: order!.priceUsdc, currency: "USDC" } }),
    preShip: () => run("preShip", () => send(escrowIx.preShip(prog(), order!, chosen!.pda, chosen!.seal))),
    ship: () => run("ship", () => send(escrowIx.ship(prog(), order!)), (after) => ({ type: EventType.SHIP, payload: { carrier: "DHL", preShipScanCounter: myScans.find((s) => after?.sellerScan && s.pda.equals(after.sellerScan))?.counter ?? sellerScanCounter ?? null } })),
    receipt: () => run("receipt", () => send(escrowIx.receipt(prog(), order!, chosen!.pda, chosen!.seal)), (after) => ({
      type: EventType.RECEIVE,
      payload: { receiptScanCounter: chosen!.counter, preShipScanCounter: sellerScanCounter ?? null, match: after?.state === OrderState.RECEIPT_SCANNED, fillDelta: null },
    })),
    release: () => run("release", () => send(escrowIx.release(prog(), order!, wallet.publicKey!, config!.usdcMint)), { type: EventType.RELEASE, payload: { priceUsdc: order!.priceUsdc, currency: "USDC", to: order!.seller.toBase58(), ...(order!.assetDeposited ? { passportTo: order!.buyer?.toBase58() } : {}) } }),
    releaseAfterTimeout: () => run("releaseAfterTimeout", () => send(escrowIx.releaseAfterTimeout(prog(), order!, wallet.publicKey!, config!.usdcMint)), { type: EventType.RELEASE, payload: { priceUsdc: order!.priceUsdc, currency: "USDC", to: order!.seller.toBase58(), reason: "no receipt scan within the deadline", ...(order!.assetDeposited ? { passportTo: order!.buyer?.toBase58() } : {}) } }),
    refundNotShipped: () => run("refundNotShipped", () => send(escrowIx.dispute(prog(), order!, wallet.publicKey!, config!.usdcMint, null)), { type: EventType.DISPUTE, payload: { reason: "not shipped within the deadline" } }),
    disputeSealDead: () => run("disputeSealDead", () => send(escrowIx.dispute(prog(), order!, wallet.publicKey!, config!.usdcMint, deadSeal)), { type: EventType.DISPUTE, payload: { reason: "Seal not responding" } }),
    adminRefund: () => run("adminRefund", () => send(escrowIx.dispute(prog(), order!, wallet.publicKey!, config!.usdcMint, null)), { type: EventType.DISPUTE, payload: { reason: "admin" } }),
    resolve: (toSeller: boolean) => run(toSeller ? "resolveSeller" : "resolveBuyer", () => send(escrowIx.resolve(prog(), order!, wallet.publicKey!, config!.usdcMint, toSeller)),
      toSeller
        ? { type: EventType.RELEASE, payload: { priceUsdc: order!.priceUsdc, currency: "USDC", to: order!.seller.toBase58(), reason: "scans disagree · resolved by the escrow admin", ...(order!.assetDeposited ? { passportTo: order!.buyer?.toBase58() } : {}) } }
        : { type: EventType.DISPUTE, payload: { reason: "scans disagree · refunded by the escrow admin" } }),
    cancel: () => run("cancel", () => send(escrowIx.cancel(prog(), order!))),
    close: () => run("close", () => send(escrowIx.closeOrder(prog(), order!))),
  };
  const spin = (k: string) => (busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null);

  if (order === undefined) return <div className="container-page py-16 text-sm text-muted"><Loader2 className="inline h-4 w-4 animate-spin" aria-hidden /> Loading order …</div>;
  const title = passport ? `${passport.brand} · ${passport.name}` : serial ?? "Order";

  return (
    <div className="page-in container-page py-10">
      <p className="eyebrow"><Link href="/market" className="hover:text-ink">Market</Link>{serial ? <> · <Link href={marketPassportPath(serial)} className="hover:text-ink">{serial}</Link></> : null} · order {short(orderPda)}</p>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-4xl">{title}</h1>
          {passport && serial && <p className="mt-2 text-sm text-muted">Grade {gradeLetter(passport.void ? 4 : passport.grade)} · {passport.stats.scanCount} scans · seal {passport.sealStatus === "INTACT" ? "responding" : passport.sealStatus === "NO_RESPONSE" ? "not responding" : "opened"} · <Link href={passportPath(serial)} className="link">View passport</Link></p>}
        </div>
        {passport && <GradeMark grade={passport.void ? 4 : passport.grade} />}
      </div>
      {error && <p role="alert" className="mt-4 rounded-xl border border-bad/40 px-4 py-3 text-sm text-bad">{error}</p>}
      {pending.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">{pending.length === 1
            ? <>A transaction on chain ({short(pending[0].sig, 8)}) is not in the passport history yet.</>
            : <>{pending.length} transactions on chain ({pending.map((p) => short(p.sig, 6)).join(", ")}) are not in the passport history yet.</>}</span>
          <button onClick={retryConfirmation} disabled={busy !== null || !wallet.connected} className="btn-outline btn-sm">{spin("retry")} Retry confirmation</button>
        </div>
      )}
      {lastTx && <p className="mt-4 text-xs text-muted">Last transaction: <a className="link" href={txUrl(lastTx)} target="_blank" rel="noreferrer">{short(lastTx, 8)}</a></p>}

      {!order ? (
        <div className="card mt-8 p-5 text-sm">
          <p className="font-medium">This order does not exist (any more).</p>
          <p className="mt-1 text-muted">Back to the <Link href="/market" className="link">market</Link>.</p>
        </div>
      ) : (
        <>
          <section className="card mt-8 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="tabular text-2xl">{amount}</p>
              <Pill tone={orderStateTone(order.state)}>{orderStateLabel[order.state]}</Pill>
            </div>
            <ol className="mt-5 grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
              {STEPS.map((s) => {
                const reached = order.state >= s && order.state <= OrderState.RELEASED;
                return <li key={s} className={`rounded-lg border px-2 py-2 text-center ${reached ? "border-ink text-ink" : "border-line text-muted"}`}>{orderStateLabel[s]}</li>;
              })}
            </ol>
            <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-3">
              <div><dt>Seller</dt><dd className="text-ink"><Link href={`/wallet/${encodeURIComponent(order.seller.toBase58())}`} className="link">{short(order.seller.toBase58())}</Link></dd></div>
              <div><dt>Buyer</dt><dd className="text-ink">{order.buyer ? <Link href={`/wallet/${encodeURIComponent(order.buyer.toBase58())}`} className="link">{short(order.buyer.toBase58())}</Link> : "–"}</dd></div>
              <div><dt>Listed</dt><dd className="text-ink">{fmtDate(order.listedAt)}</dd></div>
              <div><dt>Shipping scan</dt><dd className="mono text-ink">{order.sellerScan ? short(order.sellerScan.toBase58()) : "–"}</dd></div>
              <div><dt>Receipt scan</dt><dd className="mono text-ink">{order.buyerScan ? short(order.buyerScan.toBase58()) : "–"}</dd></div>
              <div><dt>Deadline</dt><dd className="text-ink">{
                order.state === OrderState.SHIPPED ? `Receipt scan by ${fmtDate(receiptDeadline(order))}${now > receiptDeadline(order) ? " · expired" : ""}`
                : order.state === OrderState.RESERVED || order.state === OrderState.PRESHIP_SCANNED ? `Shipping by ${fmtDate(shipDeadline(order))}${now > shipDeadline(order) ? " · expired" : ""}`
                : `${Math.round(order.disputeAfterS / 3600) >= 48 ? `${Math.round(order.disputeAfterS / 86400)} days` : `${Math.round(order.disputeAfterS / 3600)} h`} to ship, then to scan on receipt`
              }</dd></div>
              <div><dt>Core asset</dt><dd className="text-ink">{order.assetDeposited ? "held by the escrow, goes to the buyer on release" : "not in escrow custody"}</dd></div>
            </dl>
          </section>

          <section className="card mt-6 p-5">
            <p className="text-sm font-medium">Next step</p>
            {!wallet.connected && <div className="mt-3"><WalletButton /></div>}
            {wallet.connected && (
              <div className="mt-3 space-y-3 text-sm">
                {can("reserve") && (
                  <div className="flex flex-wrap items-center gap-3">
                    <button onClick={act.reserve} disabled={busy !== null || !config} className="btn btn-sm">{spin("reserve")} Reserve · {amount} into the vault</button>
                    <span className="text-xs text-muted">Needs a funded USDC account (mint {config ? short(config.usdcMint.toBase58()) : "?"}). The seller then has until the deadline to ship, otherwise you can take the USDC back.</span>
                  </div>
                )}
                {can("cancel") && <button onClick={act.cancel} disabled={busy !== null} className="btn-outline btn-sm">{spin("cancel")} Withdraw listing</button>}
                {can("preShip") && (
                  <div className="space-y-2">
                    <p className="text-muted">Do the shipping scan (tier 2, with photo), then record it here. The scan must come from this wallet, be anchored on chain and be made after the reservation{olderHidden > 0 ? ` (${olderHidden} older scan${olderHidden === 1 ? " is" : "s are"} not offered)` : ""}.</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href="/scan?role=1" className="btn-outline btn-sm">Do shipping scan <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                      <select value={chosen?.key ?? ""} onChange={(e) => setScanChoice(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
                        {!chosen && <option value="">{noScanLabel}</option>}
                        {stepScans.map((s) => <option key={s.key} value={s.key} disabled={s.unusable !== null}>{s.label}</option>)}
                      </select>
                      <button onClick={act.preShip} disabled={busy !== null || !chosen} className="btn btn-sm">{spin("preShip")} Record shipping scan</button>
                    </div>
                    {undecidedNote && <p role="note" className="text-xs text-warn">{undecidedNote}</p>}
                  </div>
                )}
                {can("ship") && <button onClick={act.ship} disabled={busy !== null} className="btn btn-sm">{spin("ship")} Mark as shipped</button>}
                {can("receipt") && (
                  <div className="space-y-2">
                    <p className="text-muted">After receipt: do a scan (tier 2, with photo) and record it before {fmtDate(receiptDeadline(order))}. Only scans made after shipping count{olderHidden > 0 ? ` (${olderHidden} older scan${olderHidden === 1 ? " is" : "s are"} not offered)` : ""}. Release happens when heat and humidity match and the fill level differs by at most {FILL_TOLERANCE} %. Without a receipt scan by the deadline the USDC goes to the seller.</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href="/scan?role=2" className="btn-outline btn-sm">Do receipt scan <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                      <select value={chosen?.key ?? ""} onChange={(e) => setScanChoice(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
                        {!chosen && <option value="">{noScanLabel}</option>}
                        {stepScans.map((s) => <option key={s.key} value={s.key} disabled={s.unusable !== null}>{s.label}</option>)}
                      </select>
                      <button onClick={act.receipt} disabled={busy !== null || !chosen} className="btn btn-sm">{spin("receipt")} Record receipt scan</button>
                    </div>
                    {undecidedNote && <p role="note" className="text-xs text-warn">{undecidedNote}</p>}
                  </div>
                )}
                {askAdmin && (
                  <div role="note" className="rounded-xl border border-line px-4 py-3">
                    <p className="font-medium">{askAdmin.reason === "sealDead" ? "The seal stopped responding after shipping." : "Not received?"}</p>
                    <p className="mt-1 text-muted">
                      {askAdmin.reason === "sealDead"
                        ? <>After shipping only the escrow admin can refund this order. Contact the admin before {fmtDate(askAdmin.before)}{now > askAdmin.before ? " (the deadline has passed: contact the admin at once)" : ""}.</>
                        : <>Without the bottle you cannot record a receipt scan, and after {fmtDate(askAdmin.before)} anyone can release the USDC to the seller. Contact the escrow admin before then{now > askAdmin.before ? " (the deadline has passed: contact the admin at once)" : ""}: the admin can refund a shipped order.</>}
                      {" "}Escrow admin: {config ? <Link href={`/wallet/${encodeURIComponent(config.admin)}`} className="link mono">{short(config.admin)}</Link> : "–"}.
                    </p>
                    {adminContactHref(orderPda) && <a href={adminContactHref(orderPda)!} className="btn-outline btn-sm mt-2" target={ADMIN_CONTACT!.startsWith("https://") ? "_blank" : undefined} rel="noreferrer">Contact the escrow admin</a>}
                  </div>
                )}
                {can("release") && <button onClick={act.release} disabled={busy !== null || !config} className="btn btn-sm">{spin("release")} Release · USDC → seller{assetNote}</button>}
                {can("releaseAfterTimeout") && (
                  <div className="flex flex-wrap items-center gap-3">
                    <button onClick={act.releaseAfterTimeout} disabled={busy !== null || !config} className="btn btn-sm">{spin("releaseAfterTimeout")} Release to the seller (no receipt scan in time)</button>
                  </div>
                )}
                {can("refundNotShipped") && <button onClick={act.refundNotShipped} disabled={busy !== null || !config} className="btn-outline btn-sm text-bad">{spin("refundNotShipped")} Not shipped in time · USDC back to me</button>}
                {can("disputeSealDead") && <button onClick={act.disputeSealDead} disabled={busy !== null || !config} className="btn-outline btn-sm text-bad">{spin("disputeSealDead")} Seal not responding · USDC back to me</button>}
                {can("adminRefund") && <button onClick={act.adminRefund} disabled={busy !== null || !config} className="btn-outline btn-sm text-bad">{spin("adminRefund")} Admin refund · USDC back to buyer</button>}
                {order.state === OrderState.MISMATCH && (can("resolve") ? (
                  <div className="space-y-2">
                    <p className="text-muted">The receipt scan does not match the shipping scan. Decide after reviewing both scans:</p>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => act.resolve(false)} disabled={busy !== null || !config} className="btn-outline btn-sm text-bad">{spin("resolveBuyer")} Refund the buyer</button>
                      <button onClick={() => act.resolve(true)} disabled={busy !== null || !config} className="btn btn-sm">{spin("resolveSeller")} Pay the seller</button>
                    </div>
                  </div>
                ) : <p className="text-muted">The scans disagree. The escrow admin reviews both scans and settles the order.</p>)}
                {can("close") && <button onClick={act.close} disabled={busy !== null} className="btn-outline btn-sm">{spin("close")} Close order (reclaim rent, allows listing again)</button>}
                {isTerminal(order.state) && <p className="text-muted">Completed.{serial ? <> The history is on the <Link href={passportPath(serial)} className="link">passport</Link>.</> : null}</p>}
                {(order.state === OrderState.RESERVED || order.state === OrderState.PRESHIP_SCANNED) && !isSeller && !can("refundNotShipped") && <p className="text-muted">Waiting for the seller to ship (deadline {fmtDate(shipDeadline(order))}).</p>}
                {order.state === OrderState.SHIPPED && !isBuyer && !can("releaseAfterTimeout") && <p className="text-muted">In transit. The buyer records the receipt scan by {fmtDate(receiptDeadline(order))}.</p>}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
