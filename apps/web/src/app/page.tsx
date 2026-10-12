import Link from "next/link";
import { ArrowRight, Nfc, ScanLine, ShieldCheck } from "lucide-react";
import { getPassports } from "@/lib/api";
import { isTestPassport } from "@/lib/format";
import { GradeMark } from "@/components/badges";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const passports = ((await getPassports()) ?? []).filter((p) => !isTestPassport(p));
  return (
    <div className="page-in">
      <section className="container-page py-16 md:py-24">
        <p className="eyebrow">Seal · Card · Passport</p>
        <h1 className="mt-5 max-w-3xl font-serif text-5xl leading-[0.98] tracking-[-0.01em] sm:text-6xl md:text-7xl">
          Sealed at first hand.<br /><em className="italic text-amber">Readable</em> on the secondary market.
        </h1>
        <p className="mt-7 max-w-xl text-base text-muted md:text-lg">
          An NFC chip proves on every tap that it is the genuine chip and which tap number this is. A card on the bottle
          carries irreversible indicators for heat and humidity. Every scan is signed and anchored on Solana — building a
          passport with an unbroken history.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/scan" className="btn">Check seal <ArrowRight className="h-4 w-4" aria-hidden /></Link>
          <Link href="/p/SN-2026-000001" className="btn-outline">View sample passport</Link>
        </div>
      </section>

      <section className="hairline">
        <div className="container-page grid gap-10 py-14 md:grid-cols-3 md:gap-8">
          {[
            { Icon: Nfc, t: "The chip proves authenticity", d: "NTAG 424 DNA. Every tap delivers a fresh checksum and a counter that only goes up. The server is the only place that can verify it." },
            { Icon: ScanLine, t: "The card shows the handling", d: "Heat above 40 °C and humidity above 60 % RH change colour irreversibly. The phone camera reads the fields against printed references." },
            { Icon: ShieldCheck, t: "The chain makes it transferable", d: "The server signs only what the chip has proven. The program accepts only what the server has signed. The passport belongs to the bottle, not the chip." },
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
            <p className="eyebrow">Passports on this server</p>
            <ul className="mt-5 divide-y divide-line border-y border-line">
              {passports.map((p) => (
                <li key={p.serial}>
                  <Link href={`/p/${p.serial}`} className="flex items-center gap-4 py-4 transition hover:bg-surface">
                    <GradeMark grade={p.void ? 4 : p.grade} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.brand} · {p.name}</p>
                      <p className="mono text-muted">{p.serial}</p>
                    </div>
                    <p className="tabular text-sm text-muted">{p.scanCount} scans</p>
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
