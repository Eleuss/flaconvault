import { EventType, Grade, GradeName, Indicator, Role, Tier } from "@flaconvault/proof";
import type { PassportEvent } from "./api";
import { CLUSTER } from "./config";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
export const fmtDate = (ts: number) => dateFmt.format(new Date(ts * 1000));
export const short = (s: string | null | undefined, n = 4) => (s ? `${s.slice(0, n)}…${s.slice(-n)}` : "–");
export const txUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const addrUrl = (a: string) => `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;

/** Test passports (brand "Test", any case) stay reachable by URL but are kept out of public lists. */
export const isTestPassport = (p: { brand?: string | null }) => (p.brand ?? "").trim().toLowerCase() === "test";

export const gradeLetter = (g: number | null | undefined) => (g == null ? "–" : GradeName[g] ?? "?");
export const gradeTone = (g: number | null | undefined): "ok" | "warn" | "bad" | "none" =>
  g === Grade.A || g === Grade.B ? "ok" : g === Grade.C || g === Grade.D ? "warn" : g === Grade.VOID ? "bad" : "none";
export const gradeSentence = (g: number) =>
  g === Grade.C || g === Grade.D ? "The indicator documents the handling, not the condition of the contents." : null;

export const roleLabel: Record<number, string> = { [Role.OWNER]: "Owner", [Role.SELLER]: "Seller", [Role.BUYER]: "Buyer", [Role.VAULT]: "Vault", [Role.PARTNER]: "Partner" };

/** Link to a passport page; the serial is always URL-encoded ('#', '%', '/' or spaces must not break the path). */
export const passportHref = (serial: string) => `/p/${encodeURIComponent(serial)}`;

/** UI wording, briefing §16 — never "beschädigt", "zerstört", "NFT". */
export function indicatorText(kind: "heat" | "humidity" | "uv", code: number): { label: string; detail: string | null; tone: "ok" | "warn" | "bad" | "none" } {
  if (kind === "uv") {
    switch (code) {
      case Indicator.INTACT: return { label: "Light", detail: "no UV exposure recorded", tone: "ok" };
      case Indicator.TRIGGERED: return { label: "Light", detail: "UV exposure recorded — fragrance compounds age under light", tone: "warn" };
      case Indicator.UNREADABLE: return { label: "Light", detail: "unreadable — review recommended", tone: "none" };
      default: return { label: "Light", detail: "no reading yet", tone: "none" };
    }
  }
  const name = kind === "heat" ? "Heat" : "Humidity";
  switch (code) {
    case Indicator.INTACT: return { label: name, detail: kind === "heat" ? "below 40 °C" : "below 60 % RH", tone: "ok" };
    case Indicator.TRIGGERED: return kind === "heat"
      ? { label: name, detail: "above 40 °C recorded — the temperature at which cosmetics and pharma test for accelerated ageing", tone: "warn" }
      : { label: name, detail: "above 60 % RH recorded — the limit for carton and label", tone: "warn" };
    case Indicator.UNREADABLE: return { label: name, detail: "unreadable — review recommended", tone: "none" };
    default: return { label: name, detail: "no reading yet", tone: "none" };
  }
}
export function sealStatusText(s: "INTACT" | "NO_RESPONSE" | "OPENED"): { label: string; tone: "ok" | "warn" | "bad" } {
  if (s === "INTACT") return { label: "Seal responding · no break recorded", tone: "ok" };
  if (s === "NO_RESPONSE") return { label: "Seal not responding", tone: "bad" };
  return { label: "Seal opened", tone: "bad" };
}
/** A VALID tap on a seal that is recorded as dead counts as a seal that does not respond — never "Seal genuine". */
export const effectiveVerdict = (t: { verdict: string; sealDead?: boolean | null }): string => (t.verdict === "VALID" && t.sealDead ? "NO_RESPONSE" : t.verdict);

export function verdictText(v: string, counter: number | null): { title: string; tone: "ok" | "warn" | "bad" | "none"; hint: string } {
  switch (v) {
    case "VALID": return { title: `Seal genuine · Tap ${counter ?? "?"}`, tone: "ok", hint: "The chip has authenticated itself cryptographically. The counter is the number of taps this seal has seen." };
    case "REPLAY": return { title: "Repeated tap", tone: "bad", hint: "This tap data has been submitted before. A genuine seal counts up on every tap." };
    case "INVALID": return { title: "Signature invalid", tone: "bad", hint: "The chip's checksum does not match. This is not a FlaconVault seal, or the URL was altered." };
    case "UNREGISTERED": return { title: `Chip genuine, but not assigned to a passport · Tap ${counter ?? "?"}`, tone: "warn", hint: "The chip is a valid NTAG 424 DNA, but there is no passport for it yet." };
    case "NO_RESPONSE": return { title: "Seal not responding", tone: "bad", hint: "No seal found — seal removed, antenna separated or out of range. No release without a valid scan." };
    case "NONCE_INVALID": return { title: "Session expired", tone: "warn", hint: "The scan took longer than 90 seconds. Please start again." };
    default: return { title: v, tone: "none", hint: "" };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
/** Detail word for a heat/humidity indicator code; null for MISSING (scan without photo) or anything unknown — never "ok". */
const indicatorWord = (code: unknown): string | null =>
  code === Indicator.INTACT ? "ok" : code === Indicator.TRIGGERED ? "triggered" : code === Indicator.UNREADABLE ? "unreadable" : null;

export function eventLine(e: PassportEvent): { title: string; details: string[] } {
  const p = e.payload ?? {};
  const att = (p.attester ?? {}) as Record<string, unknown>;
  const details: string[] = [];
  switch (e.type) {
    case EventType.MINT:
      if (!e.actorLabel && str(p.issuerLabel)) details.push(`Partner “${str(p.issuerLabel)}”`);
      if (str(p.batch)) details.push(`Batch ${str(p.batch)}`);
      return { title: "Birth certificate", details };
    case EventType.SEAL_ATTACH:
      details.push(`Chip ${str(p.uidTail) ?? `…${(e.sealUidHash ?? "").slice(-4).toUpperCase()}`}`);
      return { title: p.kind === 0 || p.kindName === "BOX" ? "Box seal attached" : "Neck seal attached", details };
    case EventType.SCAN: {
      const tier = typeof p.tier === "number" ? p.tier : typeof att.tier === "number" ? att.tier : null;
      const role = typeof p.role === "number" ? p.role : typeof att.role === "number" ? att.role : null;
      const ind = (p.indicators ?? {}) as Record<string, unknown>;
      let title = tier === Tier.BIRTH || p.purpose === "BIRTH" ? "Birth scan" : tier === Tier.CERTIFIED ? "Certification scan" : tier === Tier.SIGHTING || tier === null ? "Sighting" : `Scan tier ${tier}`;
      if (p.purpose === "PRE_SHIP" || p.kind === "pre_ship") title = "Shipping scan";
      if (p.purpose === "RECEIPT" || p.kind === "receipt") title = "Receipt scan";
      if (role != null && !e.actorLabel) details.push(roleLabel[role] ?? "Wallet");
      if (typeof p.counter === "number") details.push(`Counter ${p.counter}`);
      if (tier != null && tier >= Tier.SELF) {
        const heat = indicatorWord(ind.heat), humidity = indicatorWord(ind.humidity);
        if (heat) details.push(`Heat ${heat}`);
        if (humidity) details.push(`Humidity ${humidity}`);
        if (typeof p.fill === "number") details.push(`Fill level ${p.fill} %`);
      }
      if (p.match === true) details.push("matching");
      if (p.reviewRecommended === true) details.push("Review recommended");
      return { title, details };
    }
    case EventType.LIST: return { title: "Listed", details: str(p.priceUsdc ?? p.price) ? [`${str(p.priceUsdc ?? p.price)} ${str(p.currency) ?? "USDC"}`] : [] };
    case EventType.RESERVE: return { title: "Reserved", details: str(p.priceUsdc ?? p.price) ? [`${str(p.priceUsdc ?? p.price)} ${str(p.currency) ?? "USDC"} in escrow`] : [] };
    case EventType.SHIP: return { title: "Shipped", details: [str(p.carrier), typeof p.preShipScanCounter === "number" ? `Shipping scan counter ${p.preShipScanCounter}` : null].filter((x): x is string => !!x) };
    case EventType.RECEIVE: return { title: "Received", details: [p.match === true ? "Receipt scan matching" : p.match === false ? "Mismatch" : null, typeof p.fillDelta === "number" ? `Fill level ±${p.fillDelta} %` : null].filter((x): x is string => !!x) };
    // "Passport → buyer" only when the Core asset really moved out of escrow custody (payload.passportTo)
    case EventType.RELEASE: return { title: "Released", details: [`${str(p.priceUsdc ?? p.price) ?? "?"} ${str(p.currency) ?? "USDC"} → seller`, str(p.passportTo) ? "Passport → buyer" : null, str(p.reason)].filter((x): x is string => !!x) };
    case EventType.DISPUTE: return { title: "Dispute", details: str(p.reason) ? [str(p.reason)!] : [] };
    // only a confirmed SEAL_DEAD (a partner's mark_seal_dead transaction) voids the passport; a report changes nothing
    case EventType.SEAL_DEAD: return e.status === "confirmed"
      ? { title: "Seal not responding", details: ["Passport VOID"] }
      : { title: "Seal reported as not responding", details: ["report only, the passport is unchanged"] };
    default: return { title: `Event ${e.type}`, details };
  }
}

/** Unverified reports listed in a passport's history at most (the newest ones). */
export const MAX_REPORTS_SHOWN = 3;
/** Timeline entries: without failed attempts, and with only the newest MAX_REPORTS_SHOWN unverified reports. */
export function visibleEvents(events: PassportEvent[]): { shown: PassportEvent[]; failed: number; reportsHidden: number } {
  const reports = events.filter((e) => e.status === "reported").sort((a, b) => b.ts - a.ts || b.id - a.id);
  const keep = new Set(reports.slice(0, MAX_REPORTS_SHOWN).map((e) => e.id));
  const shown = events.filter((e) => e.status !== "failed" && (e.status !== "reported" || keep.has(e.id)));
  return { shown, failed: events.filter((e) => e.status === "failed").length, reportsHidden: reports.length - keep.size };
}

// ---- live on-chain check ---------------------------------------------------------------------------------------

/** Anchor discriminator of flacon's Passport account (sha256("account:Passport")[0..8], as in the IDL). */
export const PASSPORT_DISCRIMINATOR = [18, 61, 245, 239, 6, 15, 18, 34];
export interface ChainPassport { grade: number; scanCount: number; sealCount: number; void: boolean; createdAt: number }

/** Passport account: 8-byte discriminator, serial_hash[32], binding_hash[32], asset[32], issuer[32], grade u8, scan_count u32, seal_count u8, void bool, created_at i64. */
export function decodePassportAccount(data: Uint8Array): ChainPassport | null {
  if (data.length < 8 + 32 * 4 + 15 || PASSPORT_DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32 * 4;
  const grade = dv.getUint8(o); o += 1;
  const scanCount = dv.getUint32(o, true); o += 4;
  const sealCount = dv.getUint8(o); o += 1;
  const isVoid = dv.getUint8(o) === 1; o += 1;
  const createdAt = Number(dv.getBigInt64(o, true));
  return { grade, scanCount, sealCount, void: isVoid, createdAt };
}

/**
 * Chain passport vs. the verifier: the effective grade (VOID when void) and passport.scan_count against the server's
 * count of confirmed, anchored scans the program counted (stats.onChainScanCount). Tier-0 sightings and pending scans
 * never reach the chain, so the server's total scanCount is not comparable.
 */
export function liveCheckVerdict(chain: ChainPassport, server: { grade: number; onChainScanCount?: number | null }): { matches: boolean; text: string } {
  const chainGrade = chain.void ? Grade.VOID : chain.grade;
  const diffs: string[] = [];
  if (chainGrade !== server.grade) diffs.push(`grade ${gradeLetter(chainGrade)} on chain, ${gradeLetter(server.grade)} on the server`);
  if (server.onChainScanCount != null && chain.scanCount !== server.onChainScanCount) {
    diffs.push(`${chain.scanCount} anchored ${chain.scanCount === 1 ? "scan" : "scans"} on chain, ${server.onChainScanCount} on the server`);
  }
  if (diffs.length) return { matches: false, text: `differs from the server: ${diffs.join("; ")}` };
  return server.onChainScanCount == null
    ? { matches: true, text: "grade matches the server (the server reports no anchored-scan count)" }
    : { matches: true, text: "matches the server" };
}
