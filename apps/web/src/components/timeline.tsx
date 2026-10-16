import Link from "next/link";
import { EventType } from "@flaconvault/proof";
import { Award, Camera, Coins, ExternalLink, FileCheck2, PackageCheck, Scan, ShieldOff, Stamp, Truck, Unlock, type LucideIcon } from "lucide-react";
import type { PassportEvent } from "@/lib/api";
import { eventLine, fmtDate, txUrl, visibleEvents } from "@/lib/format";
import { GradeMark } from "./badges";

/** ar://<id> → a gateway URL a browser can open (Irys devnet data is served by the Irys gateway). */
const arUrl = (s: string) => (s.startsWith("ar://") ? `https://gateway.irys.xyz/${s.slice(5)}` : s);

const icons: Record<number, LucideIcon> = {
  [EventType.MINT]: Award, [EventType.SEAL_ATTACH]: Stamp, [EventType.SCAN]: Scan, [EventType.LIST]: Coins,
  [EventType.RESERVE]: FileCheck2, [EventType.SHIP]: Truck, [EventType.RECEIVE]: PackageCheck,
  [EventType.RELEASE]: Unlock, [EventType.DISPUTE]: ShieldOff, [EventType.SEAL_DEAD]: ShieldOff,
};

/** "reported" is an unverified SEAL_DEAD report from a buyer: shown, but it changes nothing (see eventLine). */
const statusBadge = (s: PassportEvent["status"]): string | null =>
  s === "pending" ? "awaiting confirmation" : s === "reported" ? "reported · unverified" : null;

export function Timeline({ events }: { events: PassportEvent[] }) {
  // failed attempts never landed on-chain — they are not part of the public history; of the unverified reports only
  // the newest few are listed, so anonymous reports cannot bury the history
  const { shown, failed, reportsHidden } = visibleEvents(events);
  const hiddenNote = (failed > 0 || reportsHidden > 0) && (
    <p className="mt-4 text-xs text-muted">
      {[failed > 0 && `${failed} failed ${failed === 1 ? "attempt" : "attempts"}`, reportsHidden > 0 && `${reportsHidden} older unverified ${reportsHidden === 1 ? "report" : "reports"}`].filter(Boolean).join(" and ")} not shown
    </p>
  );
  if (shown.length === 0) return <><p className="text-sm text-muted">No entries yet.</p>{hiddenNote}</>;
  return (
    <>
      <ol className="relative border-l border-line pl-6">
        {shown.map((e) => {
          const Icon = icons[e.type] ?? Scan;
          const { title, details } = eventLine(e);
          const loc = e.location?.city ?? e.location?.country ?? null;
          return (
            <li key={e.id} className="relative pb-7 last:pb-0">
              <span className="absolute -left-[31px] top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface">
                <Icon className="h-3 w-3 text-muted" aria-hidden />
              </span>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="tabular text-xs text-muted">{fmtDate(e.ts)}</span>
                <span className="font-medium">{title}</span>
                {statusBadge(e.status) && <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">{statusBadge(e.status)}</span>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                {details.map((d, i) => <span key={i}>{i > 0 && <span className="mr-2 opacity-50">·</span>}{d}</span>)}
                {e.actor && (
                  <span>{details.length > 0 && <span className="mr-2 opacity-50">·</span>}<Link href={`/wallet/${encodeURIComponent(e.actor)}`} className="link">{e.actorLabel ?? `${e.actor.slice(0, 4)}…${e.actor.slice(-4)}`}</Link></span>
                )}
                {loc && <span><span className="mr-2 opacity-50">·</span>{loc}</span>}
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs">
                {e.gradeAfter != null && <span className="inline-flex items-center gap-1.5 text-muted">Grade <GradeMark grade={e.gradeAfter} size="sm" /></span>}
                {e.txSig && <a href={txUrl(e.txSig)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-ink">tx <ExternalLink className="h-3 w-3" aria-hidden /></a>}
                {e.arMedia && <a href={arUrl(e.arMedia)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-ink"><Camera className="h-3 w-3" aria-hidden /> Photo</a>}
                {e.arBundle && <a href={arUrl(e.arBundle)} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">Bundle</a>}
              </div>
            </li>
          );
        })}
      </ol>
      {hiddenNote}
    </>
  );
}
