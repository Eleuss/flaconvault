import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getTap } from "@/lib/api";
import { verdictText } from "@/lib/format";
import { Lamp } from "@/components/badges";
import { RememberTap, TapGate } from "@/components/tap-gate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Siegel geprüft" };

export default async function TagLanding({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  let { uid, ctr, cmac } = searchParams;
  const { tap, picc_data, enc } = searchParams;
  // NXP TagWriter writes its SDM mirrors as uid=<UID>x<CTR>x<MAC>
  const tw = /^([0-9a-f]{14})x([0-9a-f]{6})x([0-9a-f]{16})$/i.exec(uid ?? "");
  if (tw) { uid = tw[1]; ctr = tw[2]; cmac = tw[3]; }
  if (!tap && picc_data && cmac) return <TapGate params={{ uid: "", ctr: "", cmac, piccData: picc_data, enc }} />;
  if (!tap && uid && ctr && cmac) return <TapGate params={{ uid, ctr, cmac }} />;
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
  const remember = <RememberTap uid={t.uid ?? null} serial={t.serial} counter={t.counter} />;
  const toneClass = { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-muted" }[v.tone];
  return (
    <div className="page-in container-page flex min-h-[70vh] flex-col justify-center py-16">
      {remember}
      <p className="eyebrow">Siegel geprüft</p>
      <div className="mt-4 flex items-center gap-3">
        <Lamp tone={v.tone} className="h-3.5 w-3.5" />
        <h1 className={`font-serif text-4xl sm:text-5xl ${toneClass}`}>{v.title}</h1>
      </div>
      <p className="mt-4 max-w-lg text-muted">{v.hint}</p>
      {t.serial && (
        <p className="mt-2 text-sm text-muted">Pass <span className="mono text-ink">{t.serial}</span>{t.counter != null && <> · Zähler <span className="tabular text-ink">{t.counter}</span></>}</p>
      )}
      {t.uid && (
        <p className="mt-2 text-sm text-muted">Chip-UID <span className="mono select-all text-ink">{t.uid.toUpperCase()}</span>{t.verdict === "UNREGISTERED" && <> — in <Link href="/certify" className="link">/certify</Link> unter „Chip-UID“ eintragen</>}</p>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        {t.serial && <Link href={`/p/${t.serial}`} className="btn">Pass mit Geschichte ansehen <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
        {t.verdict === "VALID" && <Link href="/scan" className="btn-outline">Scan mit Foto bezeugen</Link>}
        {!t.serial && <Link href="/" className="btn-outline">Zur Startseite</Link>}
      </div>
    </div>
  );
}
