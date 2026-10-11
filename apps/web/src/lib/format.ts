import { EventType, Grade, GradeName, Indicator, Role, Tier } from "@flaconvault/proof";
import type { PassportEvent } from "./api";
import { CLUSTER } from "./config";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (ts: number) => dateFmt.format(new Date(ts * 1000));
export const fmtTime = (ts: number) => timeFmt.format(new Date(ts * 1000));
export const short = (s: string | null | undefined, n = 4) => (s ? `${s.slice(0, n)}…${s.slice(-n)}` : "–");
export const txUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const addrUrl = (a: string) => `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;

export const gradeLetter = (g: number | null | undefined) => (g == null ? "–" : GradeName[g] ?? "?");
export const gradeTone = (g: number | null | undefined): "ok" | "warn" | "bad" | "none" =>
  g === Grade.A || g === Grade.B ? "ok" : g === Grade.C || g === Grade.D ? "warn" : g === Grade.VOID ? "bad" : "none";
export const gradeSentence = (g: number) =>
  g === Grade.C || g === Grade.D ? "The indicator documents the handling, not the condition of the contents." : null;

export const roleLabel: Record<number, string> = { [Role.OWNER]: "Owner", [Role.SELLER]: "Seller", [Role.BUYER]: "Buyer", [Role.VAULT]: "Vault", [Role.PARTNER]: "Partner" };
export const tierLabel: Record<number, string> = { [Tier.SIGHTING]: "Sighting", [Tier.SELF]: "Tier 1", [Tier.SELF_MEDIA]: "Tier 2", [Tier.CERTIFIED]: "certified", [Tier.BIRTH]: "Birth" };

/** UI wording, briefing §16 — never "beschädigt", "zerstört", "NFT". */
export function indicatorText(kind: "heat" | "humidity" | "uv", code: number): { label: string; detail: string | null; tone: "ok" | "warn" | "bad" | "none" } {
  if (kind === "uv") {
    switch (code) {
      case Indicator.INTACT: return { label: "Light", detail: "no UV exposure recorded", tone: "ok" };
      case Indicator.TRIGGERED: return { label: "Light", detail: "UV exposure recorded — fragrance compounds age under light", tone: "warn" };
      case Indicator.UNREADABLE: return { label: "Light", detail: "unreadable — review recommended", tone: "none" };
      default: return { label: "Light", detail: "not fitted", tone: "none" };
    }
  }
  const name = kind === "heat" ? "Heat" : "Humidity";
  switch (code) {
    case Indicator.INTACT: return { label: name, detail: kind === "heat" ? "below 40 °C" : "below 60 % RH", tone: "ok" };
    case Indicator.TRIGGERED: return kind === "heat"
      ? { label: name, detail: "above 40 °C recorded — the temperature at which cosmetics and pharma test for accelerated ageing", tone: "warn" }
      : { label: name, detail: "above 60 % RH recorded — the limit for carton and label", tone: "warn" };
    case Indicator.UNREADABLE: return { label: name, detail: "unreadable — review recommended", tone: "none" };
    default: return { label: name, detail: "not fitted", tone: "none" };
  }
}
export function sealStatusText(s: "INTACT" | "NO_RESPONSE" | "OPENED"): { label: string; tone: "ok" | "warn" | "bad" } {
  if (s === "INTACT") return { label: "Seal intact · not opened since certification", tone: "ok" };
  if (s === "NO_RESPONSE") return { label: "Seal not responding", tone: "bad" };
  return { label: "Seal opened", tone: "bad" };
}
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
const ok = (code: unknown) => (code === Indicator.TRIGGERED ? "triggered" : code === Indicator.UNREADABLE ? "unreadable" : "ok");

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
        details.push(`Heat ${ok(ind.heat)}`, `Humidity ${ok(ind.humidity)}`);
        if (typeof p.fill === "number") details.push(`Fill level ${p.fill} %`);
      }
      if (p.match === true) details.push("matching");
      if (p.reviewRecommended === true) details.push("Review recommended");
      return { title, details };
    }
    case EventType.LIST: return { title: "Listed", details: str(p.priceUsdc ?? p.price) ? [`${str(p.priceUsdc ?? p.price)} ${str(p.currency) ?? "USDC"}`] : [] };
    case EventType.RESERVE: return { title: "Reserved", details: [] };
    case EventType.SHIP: return { title: "Shipped", details: [str(p.carrier), typeof p.preShipScanCounter === "number" ? `Shipping scan counter ${p.preShipScanCounter}` : null].filter((x): x is string => !!x) };
    case EventType.RECEIVE: return { title: "Received", details: [p.match === true ? "Receipt scan matching" : p.match === false ? "Mismatch" : null, typeof p.fillDelta === "number" ? `Fill level ±${p.fillDelta} %` : null].filter((x): x is string => !!x) };
    case EventType.RELEASE: return { title: "Released", details: [`${str(p.priceUsdc ?? p.price) ?? "?"} ${str(p.currency) ?? "USDC"} → seller`, "Passport → buyer"] };
    case EventType.DISPUTE: return { title: "Dispute", details: str(p.reason) ? [str(p.reason)!] : [] };
    case EventType.SEAL_DEAD: return { title: "Seal not responding", details: ["Passport VOID"] };
    default: return { title: `Event ${e.type}`, details };
  }
}
