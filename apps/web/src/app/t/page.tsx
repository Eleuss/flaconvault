import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getTap } from "@/lib/api";
import { VERIFY_URL } from "@/lib/config";
import { verdictText } from "@/lib/format";
import { Lamp } from "@/components/badges";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Siegel geprüft" };

export default async function TagLanding({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const { uid, ctr, cmac, tap } = searchParams;
  if (!tap && uid && ctr && cmac) {
    // A tag pointed at the web host: let the verifier consume the tap exactly once, it redirects back with ?tap=<id>.
    redirect(`${VERIFY_URL}/t?uid=${encodeURIComponent(uid)}&ctr=${encodeURIComponent(ctr)}&cmac=${encodeURIComponent(cmac)}`);
  }
  const t = tap ? await getTap(tap) : null;
  if (!t) {
    return (
      <div className="page-in container-page py-16">
        <p className="eyebrow">Tag-Landing</p>
        <h1 className="mt-3 font-serif text-4xl">Kein Tap gefunden</h1>
        <p className="mt-3 max-w-md text-muted">Diese Seite wird vom Siegel aufgerufen. Halte ein Siegel an dein Handy — oder spiele im Simulator einen Tap ein.</p>
        <Link href="/dev" className="btn-outline mt-6">Zum Simulator</Link>
      </div>
    );
  }
  const v = verdictText(t.verdict, t.counter);
  const toneClass = { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-muted" }[v.tone];
  return (
    <div className="page-in container-page flex min-h-[70vh] flex-col justify-center py-16">
      <p className="eyebrow">Siegel geprüft</p>
      <div className="mt-4 flex items-center gap-3">
        <Lamp tone={v.tone} className="h-3.5 w-3.5" />
        <h1 className={`font-serif text-4xl sm:text-5xl ${toneClass}`}>{v.title}</h1>
      </div>
      <p className="mt-4 max-w-lg text-muted">{v.hint}</p>
      {t.serial && (
        <p className="mt-2 text-sm text-muted">Pass <span className="mono text-ink">{t.serial}</span>{t.counter != null && <> · Zähler <span className="tabular text-ink">{t.counter}</span></>}</p>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        {t.serial && <Link href={`/p/${t.serial}`} className="btn">Pass mit Geschichte ansehen <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
        {t.verdict === "VALID" && <Link href="/scan" className="btn-outline">Scan mit Foto bezeugen</Link>}
        {!t.serial && <Link href="/" className="btn-outline">Zur Startseite</Link>}
      </div>
    </div>
  );
}
