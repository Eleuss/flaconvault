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
export function GradeMark({ grade, size = "lg" }: { grade: number | null | undefined; size?: "lg" | "sm" }) {
  const tone = gradeTone(grade);
  return (
    <span className={cn("inline-flex items-center justify-center rounded-2xl border border-line bg-surface font-serif leading-none tabular",
      size === "lg" ? "h-24 w-24 text-6xl" : "h-8 w-8 rounded-lg text-lg", toneText[tone])} aria-label={`Grade ${gradeLetter(grade)}`}>
      {gradeLetter(grade)}
    </span>
  );
}
