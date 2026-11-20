/**
 * The public record (spec docs/public-record.md §10): every user-facing string of the consumer path in one place, and
 * the pure rules behind them (record state → line, scanBy → label, polling, the test-phase notice).
 *
 * Words: the consumer path says "public record". public-record.test.ts checks that no string here says blockchain,
 * wallet, NFT, token, crypto, guaranteed or trustless; the one line of the Advanced disclosure that names the wallet
 * lives with the wallet flow (lib/scan-steps.ts ADVANCED_INTRO).
 */
import type { ClusterName } from "./config";

// ---- strings (spec §10.2; `…` U+2026, `✓` U+2713, `·` U+00B7) --------------------------------------------------

export const TAP_GATE_UNAVAILABLE = "Seal check unavailable right now. Try again in a minute.";
/** Under the fallback: the tap never reached the verifier, so the reload checks the very same tap. */
export const TAP_GATE_NOT_USED = "Nothing is lost: trying again checks this same tap.";
export const TRY_AGAIN = "Try again";

export const SAVE_BUTTON = "Save to the public record";
export const SAVING = "Saving…";
export const SAVING_TAP_SOON = "Saving to the public record within about 3 minutes.";
export const SAVED = "Saved to the public record ✓";
export const VIEW_RECORD = "view record";
/** over_cap with reason `seal_daily` only: the visitor cap of this seal (any other reason, e.g. the daily fee budget,
 *  says nothing about the seal and reads NOT_SAVED). */
export const OVER_CAP = "Kept by FlaconVault only: this seal already has its public entries for the last 24 hours.";
export const NOT_SAVED = "Not saved to the public record this time. FlaconVault keeps the check.";

export const ADVANCED = "Advanced";
/** Seller and buyer: an order's shipping or receipt scan is the one signed under Advanced (the order needs it). */
export const ORDER_SCAN_NOTE = "Shipping or receipt scan for an order? Use Advanced: the order needs a scan you sign yourself.";
/** The place field on the consumer path: only the country is in the signed public record (v2 bundle). */
export const PLACE_NOTE = "Optional. No GPS. The signed public record keeps only the country; the place stays in FlaconVault's own database.";

export const SCAN_BY_LABEL = { VISITOR: "Visitor", HOLDER: "Holder", PARTNER: "Partner", RECIPIENT: "Recipient" } as const;
export type ScanBy = keyof typeof SCAN_BY_LABEL;
/** The history link of a recorded scan (it was "tx"). */
export const PUBLIC_RECORD_LINK = "Public record";

export const DRAWER_TITLE = "How this record is checked";
export const DRAWER_TEXT = "Public record signed by FlaconVault. Anyone can check our signature and that this list is complete; the seal's secret check itself can only be done by FlaconVault.";

export const TEST_PHASE_NOTICE = "Test phase: records are saved on Solana's test network until launch.";

/** The /p header pill (`stats.attesterCount` distinct verified signers, `certifiedCount` of them certified). */
export const witnessedBy = (n: number, m: number): string => `Witnessed by ${n} ${n === 1 ? "signer" : "signers"}, ${m} of them certified`;
/** The /p footer. */
export const PASSPORT_PUBLIC = "This passport is publicly readable, without an account and without login.";

/** Verifier codes of the public-record path (lib/errors.ts CODES takes them over). */
export const RECORD_ERRORS = {
  purpose_invalid: "This kind of scan is not available here. Reload the page and start the scan again.",
  ticket_invalid: "This kind of scan needs a FlaconVault account. It is not available yet.",
  ticket_required: "This kind of scan needs a FlaconVault account. It is not available yet.",
  relay_not_for_certified: "Certified scans are signed by the partner (Advanced).",
  wallet_anchor_not_allowed: "This pass is held in a FlaconVault account. Use \"Save to the public record\".",
  record_not_found: "The public record status of this scan is not available.",
  // the readings break a public-record rule (§3.4, e.g. a reading on a sighting); the tap is not used
  scan_fields_invalid: "This scan cannot be saved to the public record with these readings. Start a new scan.",
} as const;

// ---- the record object (spec §9.9) -----------------------------------------------------------------------------

export type RecordState = "pending" | "recorded" | "over_cap" | "failed";
/** `dueAt` only while pending, `txSig` only when recorded, `reason` only for over_cap / failed. */
export interface PublicRecord {
  state: RecordState;
  purpose: string;
  eventId: number | null;
  dueAt?: number | null;
  txSig?: string | null;
  reason?: string | null;
  cluster?: string | null;
}

const STATES: readonly RecordState[] = ["pending", "recorded", "over_cap", "failed"];
/** A record object as the verifier sends it, or null for anything else (an older verifier sends no `record`). */
export function asRecord(v: unknown): PublicRecord | null {
  const r = v as PublicRecord | null | undefined;
  return r && typeof r === "object" && (STATES as readonly string[]).includes(r.state) ? r : null;
}
export const isTerminalRecord = (r: Pick<PublicRecord, "state">): boolean => r.state !== "pending";

/** Where "view record" leads: the scan's row in the passport history. */
export const recordHref = (serial: string, eventId: number) => `/p/${encodeURIComponent(serial)}#e${eventId}`;

/**
 * When the verifier sends a TAP: tap ts + 185 s (apps/verify fv/relayer.py TAP_DUE_DELAY_S = ADOPT_WINDOW_S + 5), once
 * no scan session can adopt the tap any more.
 */
export const TAP_SEND_DELAY_S = 185;

/**
 * Whether the /t line of a pending TAP still says "within about 3 minutes": until tap ts + TAP_SEND_DELAY_S on the
 * server's clock (`tapTs` and `nowS` in unix s). Decided from the tap's own time, never from `dueAt`, which the relayer
 * also moves for its retry pauses; and one way: `left` (the line has already left it) keeps it off for good.
 */
export function tapSendsSoon(r: Pick<PublicRecord, "state" | "purpose"> | null, tapTs: number | null | undefined, nowS: number, left = false): boolean {
  return !left && !!r && r.state === "pending" && r.purpose === "TAP" && typeof tapTs === "number" && nowS < tapTs + TAP_SEND_DELAY_S;
}

export type RecordLine =
  | { kind: "pending"; text: string; soon: boolean }
  | { kind: "recorded"; text: string; link: { label: string; href: string } | null }
  | { kind: "over_cap" | "failed"; text: string };
/**
 * The line under a scan result. A pending TAP says "within about 3 minutes" while `soon` (tapSendsSoon: the /t page,
 * which knows the tap's time); then, and for every other purpose, "Saving…". `serial` links "view record" to the
 * history row (no link without serial or event).
 */
export function recordLine(r: PublicRecord, serial: string | null | undefined, soon = false): RecordLine {
  switch (r.state) {
    case "recorded":
      return { kind: "recorded", text: SAVED, link: serial && r.eventId != null ? { label: VIEW_RECORD, href: recordHref(serial, r.eventId) } : null };
    // only the seal's own visitor cap says "this seal already has its public entries"; the daily fee budget (or an
    // unknown reason) says nothing about the seal
    case "over_cap": return { kind: "over_cap", text: r.reason === "seal_daily" ? OVER_CAP : NOT_SAVED };
    case "failed": return { kind: "failed", text: NOT_SAVED };
    default: {
      const tapSoon = soon && r.purpose === "TAP";
      return { kind: "pending", text: tapSoon ? SAVING_TAP_SOON : SAVING, soon: tapSoon };
    }
  }
}

// ---- polling (spec §10.3) --------------------------------------------------------------------------------------

const MIN = 60_000;
/** The scan page: every 2 s for 2 minutes, then every 10 s up to 10 minutes, then it stops (null). */
export const scanRecordPollDelay = (elapsedMs: number): number | null => (elapsedMs < 2 * MIN ? 2000 : elapsedMs < 10 * MIN ? 10_000 : null);
/** The /t result: every 5 s, at most 10 minutes. */
export const tapRecordPollDelay = (elapsedMs: number): number | null => (elapsedMs < 10 * MIN ? 5000 : null);

/**
 * How polling ended without a terminal record: `gone` — the record is null (none any more, e.g. a TAP replaced when a
 * wallet scan adopted its tap); `timeout` — the schedule ran out while the record was still pending or unreadable;
 * `stopped` — an error `stopOn` accepts (e.g. 404).
 */
export type PollEnd = "gone" | "timeout" | "stopped";

export interface RecordPoll {
  /** the current record, or null when there is none (stop) */
  load: () => Promise<PublicRecord | null>;
  /** the pause before the next request after `elapsedMs` of polling, null to stop */
  delay: (elapsedMs: number) => number | null;
  onRecord: (r: PublicRecord) => void;
  /** an error that ends polling (e.g. 404 record_not_found); any other error is retried on the schedule */
  stopOn?: (e: unknown) => boolean;
  /**
   * Polling ended without a terminal record (with `stopOn`'s error for `stopped`). Not called after a terminal record
   * (onRecord has it) nor after cancel.
   */
  onEnd?: (end: PollEnd, error?: unknown) => void;
  now?: () => number;
}
/** Polls until the record is terminal, missing, `stopOn` hits or the schedule ends. Returns the cancel function. */
export function startRecordPoll(o: RecordPoll): () => void {
  const now = o.now ?? (() => Date.now());
  const started = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (why: PollEnd, e?: unknown) => { stopped = true; o.onEnd?.(why, e); };
  const schedule = () => {
    if (stopped) return;
    const wait = o.delay(now() - started);
    if (wait == null) end("timeout");
    else timer = setTimeout(run, wait);
  };
  const run = async () => {
    try {
      const r = await o.load();
      if (stopped) return;
      if (!r) { end("gone"); return; }
      o.onRecord(r);
      if (isTerminalRecord(r)) { stopped = true; return; }
    } catch (e) {
      if (stopped) return;
      if (o.stopOn?.(e)) { end("stopped", e); return; }
    }
    schedule();
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/** The /t record line: its record and whether it is still being asked for (the spinner of a pending line). */
export interface TapLine { record: PublicRecord; live: boolean }
/**
 * The /t record line of a tap whose record is pending (components/tap-record.tsx): asks `load` every 5 s for at most
 * 10 minutes (spec §10.3). The record gone — `record: null` or `isGone` (the tap's 404) — hides the line
 * (`show(null)`); a terminal record ends it. When the schedule runs out the line stays without its spinner, and each
 * time the tab becomes visible again (`onVisible`) it is loaded once more. Returns the cleanup.
 */
export function watchTapRecord(o: {
  initial: PublicRecord;
  load: () => Promise<PublicRecord | null>;
  isGone: (e: unknown) => boolean;
  show: (line: TapLine | null) => void;
  /** subscribes to "the tab became visible again"; returns the unsubscribe */
  onVisible: (cb: () => void) => () => void;
  delay?: (elapsedMs: number) => number | null;
  now?: () => number;
}): () => void {
  if (isTerminalRecord(o.initial)) return () => {};
  let last = o.initial, closed = false, loading = false;
  let unsubscribe: (() => void) | null = null;
  const stopListening = () => { unsubscribe?.(); unsubscribe = null; };
  const reloadOnce = async () => {
    if (closed || loading) return;
    loading = true;
    try {
      const r = await o.load();
      if (closed) return;
      if (!r) { stopListening(); o.show(null); return; }
      if (isTerminalRecord(r)) stopListening();
      o.show({ record: r, live: false });
    } catch (e) {
      if (!closed && o.isGone(e)) { stopListening(); o.show(null); }
    } finally { loading = false; }
  };
  const stopPoll = startRecordPoll({
    load: o.load, delay: o.delay ?? tapRecordPollDelay, now: o.now, stopOn: o.isGone,
    onRecord: (r) => { last = r; o.show({ record: r, live: !isTerminalRecord(r) }); },
    onEnd: (end) => {
      if (end !== "timeout") { o.show(null); return; }
      o.show({ record: last, live: false });
      if (!closed) unsubscribe = o.onVisible(() => { void reloadOnce(); });
    },
  });
  return () => { closed = true; stopPoll(); stopListening(); };
}

// ---- history and notice ----------------------------------------------------------------------------------------

/** The history label of a SCAN row from the verifier's `scanBy`; null when absent (an older verifier) or unknown. */
export function scanByLabel(scanBy: unknown): string | null {
  return typeof scanBy === "string" && Object.prototype.hasOwnProperty.call(SCAN_BY_LABEL, scanBy) ? SCAN_BY_LABEL[scanBy as ScanBy] : null;
}

/** The test-phase notice shows on every cluster but mainnet. */
export const showTestNotice = (cluster: ClusterName): boolean => cluster !== "mainnet";
