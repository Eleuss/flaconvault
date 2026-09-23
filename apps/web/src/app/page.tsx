import Link from "next/link";
import { ArrowRight, Nfc, ScanLine, ShieldCheck } from "lucide-react";
import { getPassports } from "@/lib/api";
import { GradeMark } from "@/components/badges";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const passports = (await getPassports()) ?? [];
  return (
    <div className="page-in">
      <section className="container-page py-16 md:py-24">
        <p className="eyebrow">Siegel · Karte · Pass</p>
        <h1 className="mt-5 max-w-3xl font-serif text-5xl leading-[0.98] tracking-[-0.01em] sm:text-6xl md:text-7xl">
          Aus erster Hand versiegelt.<br />Auf dem Zweitmarkt <em className="italic text-amber">lesbar</em>.
        </h1>
        <p className="mt-7 max-w-xl text-base text-muted md:text-lg">
          Ein NFC-Chip beweist beim Antippen, dass es der echte Chip ist und der wievielte Tap das ist. Eine Karte am Flakon
          trägt irreversible Indikatoren für Hitze und Feuchte. Jeder Scan wird signiert und auf Solana verankert — so entsteht ein
          Pass mit lückenloser Geschichte.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/scan" className="btn">Siegel prüfen <ArrowRight className="h-4 w-4" aria-hidden /></Link>
          <Link href="/p/SN-2026-000001" className="btn-outline">Beispiel-Pass ansehen</Link>
        </div>
      </section>

      <section className="hairline">
        <div className="container-page grid gap-10 py-14 md:grid-cols-3 md:gap-8">
          {[
            { Icon: Nfc, t: "Der Chip beweist Echtheit", d: "NTAG 424 DNA. Jeder Tap liefert eine frische Prüfsumme und einen Zähler, der nur nach oben geht. Der Server ist die einzige Stelle, die das prüfen kann." },
            { Icon: ScanLine, t: "Die Karte zeigt die Handhabung", d: "Hitze über 40 °C und Feuchte über 60 % rF verfärben sich unumkehrbar. Die Handykamera liest die Felder gegen gedruckte Referenzen." },
            { Icon: ShieldCheck, t: "Die Kette macht es übertragbar", d: "Der Server signiert nur, was der Chip bewiesen hat. Das Programm nimmt nur an, was der Server signiert hat. Der Pass hängt am Flakon, nicht am Chip." },
          ].map(({ Icon, t, d }) => (
            <div key={t}>
              <Icon className="h-5 w-5 text-amber" aria-hidden />
              <h2 className="mt-4 font-serif text-2xl">{t}</h2>
              <p className="mt-2 text-sm text-muted">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {passports.length > 0 && (
        <section className="hairline">
          <div className="container-page py-14">
            <p className="eyebrow">Pässe auf diesem Server</p>
            <ul className="mt-5 divide-y divide-line border-y border-line">
              {passports.map((p) => (
                <li key={p.serial}>
                  <Link href={`/p/${p.serial}`} className="flex items-center gap-4 py-4 transition hover:bg-surface">
                    <GradeMark grade={p.void ? 4 : p.grade} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.brand} · {p.name}</p>
                      <p className="mono text-muted">{p.serial}</p>
                    </div>
                    <p className="tabular text-sm text-muted">{p.scanCount} Scans</p>
                    <ArrowRight className="h-4 w-4 text-muted" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
