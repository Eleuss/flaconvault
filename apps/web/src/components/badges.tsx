import Link from "next/link";
import { cn } from "@/lib/cn";
import { gradeLetter, gradeTone } from "@/lib/format";

const toneText = { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-none" } as const;
const toneBg = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", none: "bg-none" } as const;
export type Tone = keyof typeof toneText;

export function Lamp({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", toneBg[tone], className)} />;
}
export function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs font-medium", toneText[tone], className)}>
      <Lamp tone={tone} />{children}
    </span>
  );
}
/**
 * The verification server did not answer (timeout, 5xx, network). Shown instead of "does not exist": a genuine
 * passport must never look like a fake because the server was redeploying.
 *
 * `retry` is the URL already on screen, so "Try again" is a plain link with a full page load on purpose: it always
 * reaches the server and never reuses a client router payload of this outage page (Next 15 keeps none for dynamic
 * pages by default, but back/forward navigation, a configured staleTimes.dynamic and older Next versions do).
 */
export function Unavailable({ what, retry }: { what: string; retry: string }) {
  return (
    <div className="page-in container-page py-16" role="alert">
      <p className="eyebrow">Temporarily unavailable</p>
      <h1 className="mt-3 font-serif text-4xl">The verification server did not answer</h1>
      <p className="mt-3 max-w-md text-muted">{what} could not be loaded right now. This says nothing about the bottle: try again in a moment.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        {/* a full page load on purpose, see above */}
        <a href={retry} className="btn">Try again</a>
        <Link href="/" className="btn-outline">Back to home</Link>
      </div>
    </div>
  );
}

export function GradeMark({ grade, size = "lg" }: { grade: number | null | undefined; size?: "lg" | "sm" }) {
  const tone = gradeTone(grade);
  return (
    <span className={cn("inline-flex items-center justify-center rounded-2xl border border-line bg-surface font-serif leading-none tabular",
      size === "lg" ? "h-24 w-24 text-6xl" : "h-8 w-8 rounded-lg text-lg", toneText[tone])} aria-label={`Grade ${gradeLetter(grade)}`}>
      {gradeLetter(grade)}
    </span>
  );
}
