/**
 * Pure escrow / market rules for the web app (no Solana or React imports, so tests/web-escrow-rules.ts can run them
 * under plain Node). They mirror programs/escrow/src/rules.rs: keep both in sync.
 */

/** Order states (programs/escrow/src/constants.rs ORDER_STATE_*). */
export const OrderState = { LISTED: 0, RESERVED: 1, PRESHIP_SCANNED: 2, SHIPPED: 3, RECEIPT_SCANNED: 4, RELEASED: 5, MISMATCH: 6, DISPUTE: 7, CANCELLED: 8 } as const;
/** Dispute window bounds (MIN_DISPUTE_AFTER_S / MAX_DISPUTE_AFTER_S). */
export const MIN_DISPUTE_AFTER_S = 60 * 60;
export const MAX_DISPUTE_AFTER_S = 60 * 24 * 60 * 60;
/** flacon MAX_SCAN_TS_SKEW_S: how far a server-signed scan ts may lie before the order step it stands for. */
export const SCAN_TS_SKEW_S = 600;
// BigInt() instead of literals: the web tsconfig has no ES2020 target
const MICRO = BigInt(1_000_000);
const ZERO = BigInt(0);
const U64_MAX = BigInt("18446744073709551615");

/** Serial numbers as the verifier accepts them: 3–64 characters, letters/digits first, then `.`, `_`, `-`. */
export const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
export const normalizeSerial = (s: string) => s.trim();
export const isValidSerial = (s: string) => SERIAL_RE.test(s);

/** App paths with the dynamic part encoded. */
export const passportPath = (serial: string) => `/p/${encodeURIComponent(serial)}`;
export const marketPassportPath = (serial: string) => `/market/${encodeURIComponent(serial)}`;
export const orderPath = (orderPda: string) => `/market/o/${encodeURIComponent(orderPda)}`;
/** Metaplex Core `uri` of a passport's asset: the verifier's metadata JSON (GET /api/passport/<serial>/metadata.json). */
export const coreAssetUri = (verifyUrl: string, serial: string) => `${verifyUrl.replace(/\/+$/, "")}/api/passport/${encodeURIComponent(serial)}/metadata.json`;

/**
 * Parses a USDC amount typed by a person into base units (6 decimals). Accepts "480", "480.5", "0.000001";
 * rejects negatives, zero, commas, exponents, more than 6 decimals and anything above u64.
 */
export function parsePriceUsdc(input: string): bigint | null {
  const t = input.trim();
  const m = /^(\d{1,13})(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return null;
  const base = BigInt(m[1]) * MICRO + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (base <= ZERO || base > U64_MAX) return null;
  return base;
}
/** Base units → "480" / "480.5" (no float rounding). */
export function formatUsdc(base: bigint): string {
  const whole = base / MICRO, frac = base % MICRO;
  return frac === ZERO ? whole.toString() : `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

export const effectiveWindow = (disputeAfterS: number) => Math.min(Math.max(disputeAfterS, MIN_DISPUTE_AFTER_S), MAX_DISPUTE_AFTER_S);
export const isTerminal = (state: number) => state === OrderState.RELEASED || state === OrderState.DISPUTE || state === OrderState.CANCELLED;

export interface OrderLike { state: number; reservedAt: number; shippedAt: number; disputeAfterS: number; assetDeposited: boolean }
export interface Viewer { isSeller: boolean; isBuyer: boolean; isAdmin: boolean; sealDead: boolean }

/** Deadline for the seller to ship (unix s) — after it the buyer may take the USDC back. */
export const shipDeadline = (o: OrderLike) => o.reservedAt + effectiveWindow(o.disputeAfterS);
/** Deadline for the buyer's receipt scan (unix s) — after it anyone may release the USDC to the seller. */
export const receiptDeadline = (o: OrderLike) => o.shippedAt + effectiveWindow(o.disputeAfterS);

export type EscrowAction =
  | "reserve" | "cancel" | "preShip" | "ship" | "receipt" | "release"
  | "refundNotShipped" | "releaseAfterTimeout" | "disputeSealDead" | "adminRefund" | "resolve" | "close";

/**
 * Whether a scan (its signed `ts`, unix s) may stand for an order step: the shipping scan must not predate the
 * reservation and the receipt scan must not predate shipping (programs/escrow rules.rs check_scan_not_before, with the
 * same clock-skew allowance). Older scans would be refused with ScanBeforeOrderStep.
 */
export function scanFitsStep(o: OrderLike, step: "preShip" | "receipt", scanTs: number): boolean {
  const stepAt = step === "preShip" ? o.reservedAt : o.shippedAt;
  return scanTs >= stepAt - SCAN_TS_SKEW_S;
}

/** Indicator codes (proof enums Indicator): what a heat or humidity reading of a signed scan can be. */
const INDICATOR = { INTACT: 0, TRIGGERED: 1, UNREADABLE: 2, MISSING: 3 } as const;
const indicatorProblem = (name: string, code: unknown): string | null =>
  code === INDICATOR.INTACT || code === INDICATOR.TRIGGERED ? null
  : code === INDICATOR.UNREADABLE ? `${name} unreadable`
  : `${name} not read`;

/**
 * Whether an anchored scan may be recorded as an order's shipping or receipt scan, judged by its signed indicators.
 * The program compares the codes of the receipt scan with those of the shipping scan (heat equal, humidity equal, fill
 * within the tolerance → release, anything else → MISMATCH). An UNREADABLE or MISSING heat or humidity would therefore
 * either push the order into MISMATCH or "match" another unread scan without checking anything, so only scans with
 * both indicators decided (INTACT or TRIGGERED) are offered. `reason` names what is missing, e.g. "heat unreadable".
 */
export function scanUsableForOrder(indicators: { heat?: unknown; humidity?: unknown } | null | undefined): { ok: true } | { ok: false; reason: string } {
  const problems = [indicatorProblem("heat", indicators?.heat), indicatorProblem("humidity", indicators?.humidity)].filter((p): p is string => p !== null);
  return problems.length ? { ok: false, reason: problems.join(", ") } : { ok: true };
}

/**
 * The scans the order page offers for a step, and the one it would record. Only scans made after the step count
 * (scanFitsStep; `olderHidden` of the wallet's scans are left out); of those, a scan with `unusable` set (heat or
 * humidity not decided, scanUsableForOrder) is listed but can never be chosen. `choice` (a key) keeps the user's pick
 * while it is selectable; otherwise the first selectable scan is chosen, or none.
 */
export function stepScanChoice<T extends { key: string; ts: number; unusable: string | null }>(
  o: OrderLike | null | undefined, step: "preShip" | "receipt" | null, scans: T[], choice: string,
): { offered: T[]; chosen: T | undefined; olderHidden: number; undecided: number } {
  const offered = o && step ? scans.filter((s) => scanFitsStep(o, step, s.ts)) : [];
  const usable = offered.filter((s) => s.unusable === null);
  return {
    offered,
    chosen: usable.find((s) => s.key === choice) ?? usable[0],
    olderHidden: scans.length - offered.length,
    undecided: offered.length - usable.length,
  };
}

/**
 * What only the escrow admin can settle for the buyer of a SHIPPED order: the parcel did not arrive (the buyer cannot
 * record a receipt scan without the bottle, and after the receipt deadline anyone may pay the seller), or the seal
 * stopped answering after shipping (the program leaves that to the admin). `before` is the receipt deadline.
 */
export function buyerNeedsAdmin(o: OrderLike, v: Viewer): { reason: "notReceived" | "sealDead"; before: number } | null {
  if (o.state !== OrderState.SHIPPED || !v.isBuyer) return null;
  return { reason: v.sealDead ? "sealDead" : "notReceived", before: receiptDeadline(o) };
}

/** The actions the program would accept from this viewer right now (`now` in unix seconds). */
export function availableActions(o: OrderLike, v: Viewer, now: number): EscrowAction[] {
  const a: EscrowAction[] = [];
  const preShipping = o.state === OrderState.RESERVED || o.state === OrderState.PRESHIP_SCANNED;
  const refundable = preShipping || o.state === OrderState.SHIPPED;
  if (o.state === OrderState.LISTED) a.push(v.isSeller ? "cancel" : "reserve");
  if (o.state === OrderState.RESERVED && v.isSeller) a.push("preShip");
  if (o.state === OrderState.PRESHIP_SCANNED && v.isSeller) a.push("ship");
  if (o.state === OrderState.SHIPPED && v.isBuyer) a.push("receipt");
  if (o.state === OrderState.RECEIPT_SCANNED) a.push("release");
  if (preShipping && v.isBuyer && now > shipDeadline(o)) a.push("refundNotShipped");
  if (o.state === OrderState.SHIPPED && now > receiptDeadline(o)) a.push("releaseAfterTimeout");
  // after shipping a dead seal is the admin's call (DeadSealAfterShipping): see buyerNeedsAdmin
  if (preShipping && v.isBuyer && v.sealDead) a.push("disputeSealDead");
  if (refundable && v.isAdmin) a.push("adminRefund");
  if (o.state === OrderState.MISMATCH && v.isAdmin) a.push("resolve");
  if (isTerminal(o.state) && v.isSeller) a.push("close");
  return a;
}
