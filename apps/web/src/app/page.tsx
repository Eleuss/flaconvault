import Link from "next/link";
import { ArrowRight, Nfc, ScanLine, ShieldCheck } from "lucide-react";
import { getPassports } from "@/lib/api";
import { isTestPassport, passportHref } from "@/lib/format";
import { GradeMark } from "@/components/badges";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const res = await getPassports();
  const passports = (res.status === "ok" ? res.data : []).filter((p) => !isTestPassport(p));
  return (
    <div className="page-in">
      <section className="container-page py-16 md:py-24">
        <p className="eyebrow">Seal · Card · Passport</p>
        <h1 className="mt-5 max-w-3xl font-serif text-5xl leading-[0.98] tracking-[-0.01em] sm:text-6xl md:text-7xl">
          Sealed at first hand.<br /><em className="italic text-amber">Readable</em> on the secondary market.
        </h1>
        <p className="mt-7 max-w-xl text-base text-muted md:text-lg">
          A seal and handling record for collectible perfume. Hold an iPhone to the seal on the bottle neck, no app or
          wallet needed, and see whether it is the genuine seal and how often it has been tapped. A card on the bottle
          records excess heat and humidity, and every witnessed scan is signed and recorded on Solana, so the history
          goes with the bottle to its next owner.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/p/SN-2026-000007" className="btn">See a real sealed bottle <ArrowRight className="h-4 w-4" aria-hidden /></Link>
          <Link href="/scan" className="btn-outline">Check seal</Link>
        </div>
      </section>

      <section className="hairline">
        <div className="container-page grid gap-10 py-14 md:grid-cols-3 md:gap-8">
          {[
            { Icon: Nfc, t: "The chip verifies the seal", d: "An NXP NTAG 424 DNA sticker over the neck. Every tap returns a fresh checksum and a counter that only goes up, and only our verification server can check them, so a copied tap link is rejected. It does not prove what is inside the bottle." },
            { Icon: ScanLine, t: "The card records the handling", d: "The heat field turns dark for good above 40 °C, which a delivery van reaches on a warm day. The humidity dot turns pink above 60 % RH. The phone camera reads both, white-balanced against the card itself." },
            { Icon: ShieldCheck, t: "Solana keeps the history", d: "The server signs a scan only after the chip has proven a fresh tap. The program on Solana accepts only what the server signed and keeps one record per witnessed scan, so anyone can read a bottle's passport straight from the chain." },
          ].map(({ Icon, t, d }) => (
            <div key={t}>
              <Icon className="h-5 w-5 text-amber" aria-hidden />
              <h2 className="mt-4 font-serif text-2xl">{t}</h2>
              <p className="mt-2 text-sm text-muted">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {res.status === "error" && (
        <section className="hairline">
          <p className="container-page py-10 text-sm text-muted">The passport list is unavailable right now: the verification server did not answer. Try again in a moment.</p>
        </section>
      )}
      {passports.length > 0 && (
        <section className="hairline">
          <div className="container-page py-14">
            <p className="eyebrow">Bottles with a passport</p>
            <ul className="mt-5 divide-y divide-line border-y border-line">
              {passports.map((p) => (
                <li key={p.serial}>
                  <Link href={passportHref(p.serial)} className="flex items-center gap-4 py-4 transition hover:bg-surface">
                    <GradeMark grade={p.void ? 4 : p.grade} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.brand} · {p.name}</p>
                      <p className="mono text-muted">{p.serial}</p>
                    </div>
                    <p className="tabular text-sm text-muted">{p.scanCount} {p.scanCount === 1 ? "scan" : "scans"}</p>
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
