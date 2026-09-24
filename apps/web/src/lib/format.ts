import { EventType, Grade, GradeName, Indicator, Role, Tier } from "@flaconvault/proof";
import type { PassportEvent } from "./api";
import { CLUSTER } from "./config";

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (ts: number) => dateFmt.format(new Date(ts * 1000));
export const fmtTime = (ts: number) => timeFmt.format(new Date(ts * 1000));
export const short = (s: string | null | undefined, n = 4) => (s ? `${s.slice(0, n)}…${s.slice(-n)}` : "–");
export const txUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const addrUrl = (a: string) => `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;

export const gradeLetter = (g: number | null | undefined) => (g == null ? "–" : GradeName[g] ?? "?");
export const gradeTone = (g: number | null | undefined): "ok" | "warn" | "bad" | "none" =>
  g === Grade.A || g === Grade.B ? "ok" : g === Grade.C || g === Grade.D ? "warn" : g === Grade.VOID ? "bad" : "none";
export const gradeSentence = (g: number) =>
  g === Grade.C || g === Grade.D ? "Der Indikator dokumentiert die Handhabung, nicht den Zustand des Inhalts." : null;

export const roleLabel: Record<number, string> = { [Role.OWNER]: "Besitzer", [Role.SELLER]: "Verkäufer", [Role.BUYER]: "Käufer", [Role.VAULT]: "Vault", [Role.PARTNER]: "Partner" };
export const tierLabel: Record<number, string> = { [Tier.SIGHTING]: "Sichtung", [Tier.SELF]: "Tier 1", [Tier.SELF_MEDIA]: "Tier 2", [Tier.CERTIFIED]: "zertifiziert", [Tier.BIRTH]: "Geburt" };

/** UI wording, briefing §16 — never "beschädigt", "zerstört", "NFT". */
export function indicatorText(kind: "heat" | "humidity" | "uv", code: number): { label: string; detail: string | null; tone: "ok" | "warn" | "bad" | "none" } {
  if (kind === "uv") return { label: "Licht", detail: "nicht bestückt (Rev D)", tone: "none" };
  const name = kind === "heat" ? "Hitze" : "Feuchte";
  switch (code) {
    case Indicator.INTACT: return { label: name, detail: kind === "heat" ? "unter 40 °C" : "unter 60 % rF", tone: "ok" };
    case Indicator.TRIGGERED: return kind === "heat"
      ? { label: name, detail: "über 40 °C erfasst — die Temperatur, bei der Kosmetik und Pharma beschleunigte Alterung prüfen", tone: "warn" }
      : { label: name, detail: "über 60 % rF erfasst — Grenze für Karton und Etikett", tone: "warn" };
    case Indicator.UNREADABLE: return { label: name, detail: "nicht lesbar — Prüfung empfohlen", tone: "none" };
    default: return { label: name, detail: "nicht bestückt", tone: "none" };
  }
}
export function sealStatusText(s: "INTACT" | "NO_RESPONSE" | "OPENED"): { label: string; tone: "ok" | "warn" | "bad" } {
  if (s === "INTACT") return { label: "Siegel intakt · seit der Zertifizierung nicht geöffnet", tone: "ok" };
  if (s === "NO_RESPONSE") return { label: "Siegel antwortet nicht", tone: "bad" };
  return { label: "Siegel geöffnet", tone: "bad" };
}
export function verdictText(v: string, counter: number | null): { title: string; tone: "ok" | "warn" | "bad" | "none"; hint: string } {
  switch (v) {
    case "VALID": return { title: `Siegel echt · Tap ${counter ?? "?"}`, tone: "ok", hint: "Der Chip hat sich kryptografisch ausgewiesen. Der Zähler ist der wievielte Tap dieses Siegels." };
    case "REPLAY": return { title: "Wiederholter Tap", tone: "bad", hint: "Diese Tap-Daten wurden schon einmal eingereicht. Ein echtes Siegel zählt bei jedem Antippen hoch." };
    case "INVALID": return { title: "Signatur ungültig", tone: "bad", hint: "Die Prüfsumme des Chips passt nicht. Das ist kein FlaconVault-Siegel oder die URL wurde verändert." };
    case "UNREGISTERED": return { title: `Chip echt, aber keinem Pass zugeordnet · Tap ${counter ?? "?"}`, tone: "warn", hint: "Der Chip ist ein gültiger NTAG 424 DNA, aber es gibt noch keinen Pass dazu." };
    case "NO_RESPONSE": return { title: "Siegel antwortet nicht", tone: "bad", hint: "Kein Siegel gefunden — Siegel entfernt, Antenne getrennt oder nicht in Reichweite. Ohne gültigen Scan keine Freigabe." };
    case "NONCE_INVALID": return { title: "Sitzung abgelaufen", tone: "warn", hint: "Der Scan hat länger als 90 Sekunden gedauert. Bitte neu starten." };
    default: return { title: v, tone: "none", hint: "" };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const ok = (code: unknown) => (code === Indicator.TRIGGERED ? "ausgelöst" : code === Indicator.UNREADABLE ? "nicht lesbar" : "ok");

export function eventLine(e: PassportEvent): { title: string; details: string[] } {
  const p = e.payload ?? {};
  const att = (p.attester ?? {}) as Record<string, unknown>;
  const details: string[] = [];
  switch (e.type) {
    case EventType.MINT:
      if (!e.actorLabel && str(p.issuerLabel)) details.push(`Partner „${str(p.issuerLabel)}“`);
      if (str(p.batch)) details.push(`Charge ${str(p.batch)}`);
      return { title: "Geburtsurkunde", details };
    case EventType.SEAL_ATTACH:
      details.push(`Chip ${str(p.uidTail) ?? `…${(e.sealUidHash ?? "").slice(-4).toUpperCase()}`}`);
      return { title: p.kind === 0 || p.kindName === "BOX" ? "Packungssiegel angelegt" : "Halssiegel angelegt", details };
    case EventType.SCAN: {
      const tier = typeof p.tier === "number" ? p.tier : typeof att.tier === "number" ? att.tier : null;
      const role = typeof p.role === "number" ? p.role : typeof att.role === "number" ? att.role : null;
      const ind = (p.indicators ?? {}) as Record<string, unknown>;
      let title = tier === Tier.BIRTH || p.purpose === "BIRTH" ? "Geburts-Scan" : tier === Tier.CERTIFIED ? "Zertifizierungs-Scan" : tier === Tier.SIGHTING || tier === null ? "Sichtung" : `Scan Tier ${tier}`;
      if (p.purpose === "PRE_SHIP" || p.kind === "pre_ship") title = "Versand-Scan";
      if (p.purpose === "RECEIPT" || p.kind === "receipt") title = "Empfangs-Scan";
      if (role != null && !e.actorLabel) details.push(roleLabel[role] ?? "Wallet");
      if (typeof p.counter === "number") details.push(`Zähler ${p.counter}`);
      if (tier != null && tier >= Tier.SELF) {
        details.push(`Hitze ${ok(ind.heat)}`, `Feuchte ${ok(ind.humidity)}`);
        if (typeof p.fill === "number") details.push(`Füllstand ${p.fill} %`);
      }
      if (p.match === true) details.push("übereinstimmend");
      if (p.reviewRecommended === true) details.push("Prüfung empfohlen");
      return { title, details };
    }
    case EventType.LIST: return { title: "Gelistet", details: str(p.priceUsdc ?? p.price) ? [`${str(p.priceUsdc ?? p.price)} ${str(p.currency) ?? "USDC"}`] : [] };
    case EventType.RESERVE: return { title: "Reserviert", details: [] };
    case EventType.SHIP: return { title: "Versendet", details: [str(p.carrier), typeof p.preShipScanCounter === "number" ? `Versand-Scan Zähler ${p.preShipScanCounter}` : null].filter((x): x is string => !!x) };
    case EventType.RECEIVE: return { title: "Empfangen", details: [p.match === true ? "Empfangs-Scan übereinstimmend" : p.match === false ? "Abweichung" : null, typeof p.fillDelta === "number" ? `Füllstand ±${p.fillDelta} %` : null].filter((x): x is string => !!x) };
    case EventType.RELEASE: return { title: "Freigegeben", details: [`${str(p.priceUsdc ?? p.price) ?? "?"} ${str(p.currency) ?? "USDC"} → Verkäufer`, "Pass → Käufer"] };
    case EventType.DISPUTE: return { title: "Dispute", details: str(p.reason) ? [str(p.reason)!] : [] };
    case EventType.SEAL_DEAD: return { title: "Siegel antwortet nicht", details: ["Pass VOID"] };
    default: return { title: `Event ${e.type}`, details };
  }
}
