import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getHealth, getTap } from "@/lib/api";
import { DEV_SIMULATOR } from "@/lib/config";
import { effectiveVerdict, passportHref, verdictText } from "@/lib/format";
import { Lamp, Unavailable } from "@/components/badges";
import { RememberTap, TapGate } from "@/components/tap-gate";

export const dynamic = "force-dynamic";

type Search = Record<string, string | undefined>;
/** One verifier call per request, shared by generateMetadata and the page. */
const loadTap = cache((id: string) => getTap(id));

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const t = searchParams.tap ? await loadTap(searchParams.tap) : null;
  return { title: t?.status === "ok" ? "Seal checked" : "Seal check" };
}

export default async function TagLanding({ searchParams }: { searchParams: Search }) {
  let { uid, ctr, cmac } = searchParams;
  const { tap, picc_data, enc, k } = searchParams;
  // NXP TagWriter writes its SDM mirrors as uid=<UID>x<CTR>x<MAC>
  const tw = /^([0-9a-f]{14})x([0-9a-f]{6})x([0-9a-f]{16})$/i.exec(uid ?? "");
  if (tw) { uid = tw[1]; ctr = tw[2]; cmac = tw[3]; }
  if (!tap && picc_data && cmac) return <TapGate params={{ uid: "", ctr: "", cmac, piccData: picc_data, enc }} />;
  if (!tap && uid && ctr && cmac) return <TapGate params={{ uid, ctr, cmac }} />;
  const res = tap ? await loadTap(tap) : null;
  if (res?.status === "error") {
    // the verifier already consumed this tap: keep tap + k in the retry link, so the adoption link is not lost
    const retry = `/t?tap=${encodeURIComponent(tap ?? "")}${k ? `&k=${encodeURIComponent(k)}` : ""}`;
    return <Unavailable what="The result of this tap" retry={retry} />;
  }
  if (!res || res.status === "missing") {
    // the simulator link only where the verifier really runs its simulator (it is off in production)
    let sim = false;
    if (DEV_SIMULATOR) { const h = await getHealth(); sim = h.status === "ok" && h.data.simulator === true; }
    return (
      <div className="page-in container-page py-16">
        <p className="eyebrow">Tag landing</p>
        <h1 className="mt-3 font-serif text-4xl">No tap found</h1>
        <p className="mt-3 max-w-md text-muted">This page is opened by the seal. Hold a seal to your phone{sim ? " — or play a tap in the simulator" : ""}.</p>
        {sim ? <Link href="/dev" className="btn-outline mt-6">Open simulator</Link> : <Link href="/" className="btn-outline mt-6">Back to home</Link>}
      </div>
    );
  }
  const t = res.data;
  // a VALID tap on a seal that is recorded as dead is "not responding": no green verdict, no condition check
  const verdict = effectiveVerdict(t);
  const v = verdictText(verdict, t.counter);
  const remember = <RememberTap uid={t.uid ?? null} serial={t.serial} counter={t.counter} />;
  const toneClass = { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-muted" }[v.tone];
  return (
    <div className="page-in container-page flex min-h-[70vh] flex-col justify-center py-16">
      {remember}
      <p className="eyebrow">Seal checked</p>
      <div className="mt-4 flex items-center gap-3">
        <Lamp tone={v.tone} className="h-3.5 w-3.5" />
        <h1 className={`font-serif text-4xl sm:text-5xl ${toneClass}`}>{v.title}</h1>
      </div>
      <p className="mt-4 max-w-lg text-muted">{v.hint}</p>
      {t.serial && (
        <p className="mt-2 text-sm text-muted">Passport <span className="mono text-ink">{t.serial}</span>{t.counter != null && <> · Counter <span className="tabular text-ink">{t.counter}</span></>}</p>
      )}
      {t.uid && (
        <p className="mt-2 text-sm text-muted">Chip UID <span className="mono select-all text-ink">{t.uid.toUpperCase()}</span>{t.verdict === "UNREGISTERED" && <> — enter it in <Link href="/certify" className="link">/certify</Link> under “Chip UID”</>}</p>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        {t.serial && <Link href={passportHref(t.serial)} className="btn">View passport with history <ArrowRight className="h-4 w-4" aria-hidden /></Link>}
        {verdict === "VALID" && <Link href={k ? `/scan?adopt=${encodeURIComponent(tap ?? "")}&k=${encodeURIComponent(k)}` : "/scan"} className="btn-outline">Check condition · Photograph the card</Link>}
        {!t.serial && <Link href="/" className="btn-outline">Back to home</Link>}
      </div>
    </div>
  );
}
