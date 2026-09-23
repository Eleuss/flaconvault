import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Grade, HEAT_FIELDS_C } from "@flaconvault/proof";
import { getPassport } from "@/lib/api";
import { addrUrl, fmtDate, gradeLetter, gradeSentence, gradeTone, indicatorText, sealStatusText, short } from "@/lib/format";
import { GradeMark, Lamp, Pill } from "@/components/badges";
import { Timeline } from "@/components/timeline";
import { LiveCheck } from "@/components/live-check";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { serial: string } }): Promise<Metadata> {
  return { title: `Pass ${decodeURIComponent(params.serial)}` };
}

export default async function PassportPage({ params }: { params: { serial: string } }) {
  const serial = decodeURIComponent(params.serial);
  const p = await getPassport(serial);
  if (!p) notFound();
  const grade = p.void ? Grade.VOID : p.grade;
  const seal = sealStatusText(p.sealStatus);
  const heat = indicatorText("heat", p.latest?.indicators.heat ?? 3);
  const hum = indicatorText("humidity", p.latest?.indicators.humidity ?? 3);
  const uv = indicatorText("uv", 3);
  const sentence = gradeSentence(grade);

  return (
    <div className="page-in container-page py-10 md:py-14">
      <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">Pass · {p.serial}</p>
          <h1 className="mt-3 font-serif text-4xl leading-tight sm:text-5xl">{p.brand} <span className="text-muted">·</span> {p.name}</h1>
          <p className="mt-3 text-sm text-muted">
            Charge {p.batch || "–"} · Herkunft ab Quelle dokumentiert{p.issuerLabel ? ` · ${p.issuerLabel}` : ""} · seit {fmtDate(p.createdAt)}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Pill tone={seal.tone}>{seal.label}</Pill>
            <Pill tone="none">Bezeugt von {p.stats.attesterCount} Wallets, davon {p.stats.certifiedCount} zertifiziert</Pill>
          </div>
        </div>
        <div className="flex items-center gap-5 md:flex-col md:items-end">
          <GradeMark grade={grade} />
          <div className="text-sm text-muted md:text-right">
            <p className="font-medium text-ink">Grade {gradeLetter(grade)}</p>
            <p className="tabular">{p.stats.scanCount} Scans · Zähler {p.stats.counter}</p>
          </div>
        </div>
      </div>
      {sentence && <p className="mt-4 text-sm text-muted">{sentence}</p>}

      <section className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[heat, hum, uv].map((i) => (
          <div key={i.label} className="card p-4">
            <div className="flex items-center gap-2"><Lamp tone={i.tone} /><p className="font-medium">{i.label}</p></div>
            <p className="mt-1.5 text-sm text-muted">{i.detail}</p>
          </div>
        ))}
        <div className="card p-4">
          <p className="font-medium">Füllstand</p>
          {p.latest ? (
            <>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ink" style={{ width: `${p.latest.fill}%` }} /></div>
              <p className="mt-1.5 tabular text-sm text-muted">{p.latest.fill} % · zuletzt {fmtDate(p.latest.ts)}</p>
            </>
          ) : <p className="mt-1.5 text-sm text-muted">noch kein Scan</p>}
        </div>
      </section>

      {p.latest && (
        <section className="mt-6 card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Hitzestreifen · sechs Felder, gelesen wird 40 °C</p>
            {p.latest.reviewRecommended && <Pill tone="none">Prüfung empfohlen</Pill>}
          </div>
          <div className="mt-3 grid grid-cols-6 gap-2">
            {HEAT_FIELDS_C.map((c, i) => {
              const on = p.latest!.heatLevels[i] === 1;
              return (
                <div key={c} className={`rounded-lg border px-2 py-2 text-center text-xs tabular ${i === 4 ? "border-amber" : "border-line"} ${on ? "bg-ink text-bg" : "bg-surface text-muted"}`}>
                  {c} °C
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">Die fünf anderen Felder sind Kontext, keine Aussage.</p>
        </section>
      )}

      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Geschichte</p>
            <h2 className="mt-2 font-serif text-3xl">Geburt, Versiegelung, jeder Scan, jeder Besitzerwechsel</h2>
          </div>
          <LiveCheck serialHashHex={p.serialHash} serverGrade={grade} serverScanCount={p.stats.scanCount} />
        </div>
        <div className="mt-8"><Timeline events={p.events} /></div>
      </section>

      <section className="mt-12 grid gap-6 text-sm sm:grid-cols-2">
        <div>
          <p className="eyebrow">Siegel</p>
          <ul className="mt-3 space-y-2">
            {p.seals.map((s) => (
              <li key={s.uidHash} className="flex flex-wrap items-center gap-x-3 text-muted">
                <Lamp tone={s.dead ? "bad" : "ok"} />
                <span className="text-ink">{s.kind === 0 ? "Packung" : "Hals"}</span>
                <span className="mono">…{s.uidHash.slice(-8)}</span>
                <span className="tabular">Zähler {s.lastCounter}</span>
                <span>seit {fmtDate(s.attachedAt)}</span>
                {s.dead && <span className="text-bad">antwortet nicht</span>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow">On-chain</p>
          <ul className="mt-3 space-y-2 text-muted">
            <li>serial_hash <span className="mono text-ink">{short(p.serialHash, 10)}</span></li>
            <li>Asset {p.asset ? <a className="link inline-flex items-center gap-1 text-ink" href={addrUrl(p.asset)} target="_blank" rel="noreferrer">{short(p.asset)} <ExternalLink className="h-3 w-3" aria-hidden /></a> : "–"}</li>
            <li>Aussteller {p.issuer ? <Link className="link text-ink" href={`/wallet/${p.issuer}`}>{p.issuerLabel ?? short(p.issuer)}</Link> : "–"}</li>
          </ul>
        </div>
      </section>
      <p className={`mt-10 text-xs ${gradeTone(grade) === "bad" ? "text-bad" : "text-muted"}`}>
        Dieser Pass ist öffentlich lesbar, ohne Wallet und ohne Login.
      </p>
    </div>
  );
}
