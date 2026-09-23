import type { Metadata } from "next";
import { VERIFY_URL } from "@/lib/config";
import { fmtDate, short } from "@/lib/format";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Attester" };

interface Attester { pubkey: string; label: string | null; isPartner: boolean; firstSeen: number | null; scanCount: number; certifiedCount: number; agreeCount: number; compareCount: number; agreeRate: number | null; escrowsOk: number; escrowsDisputed: number; recentSerials: string[] }

export default async function WalletPage({ params }: { params: { pubkey: string } }) {
  let a: Attester | null = null;
  try {
    const r = await fetch(`${VERIFY_URL}/api/attester/${params.pubkey}`, { cache: "no-store" });
    if (r.ok) a = (await r.json()) as Attester;
  } catch {}
  return (
    <div className="page-in container-page py-12">
      <p className="eyebrow">Attester</p>
      <h1 className="mt-3 font-serif text-4xl">{a?.label ?? short(params.pubkey, 6)}</h1>
      <p className="mono mt-2 break-all text-muted">{params.pubkey}</p>
      {a ? (
        <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
          {[
            ["Dabei seit", a.firstSeen ? fmtDate(a.firstSeen) : "–"], ["Scans", a.scanCount], ["Zertifizierte Scans", a.certifiedCount],
            ["Übereinstimmungsquote", a.agreeRate == null ? "–" : `${Math.round(a.agreeRate * 100)} % (${a.agreeCount}/${a.compareCount})`],
            ["Escrows ohne Dispute", `${a.escrowsOk} / ${a.escrowsOk + a.escrowsDisputed}`], ["Rolle geprüft", a.isPartner ? "✓ Partner" : "–"],
          ].map(([k, v]) => (
            <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd className="mt-1 font-serif text-3xl tabular">{v}</dd></div>
          ))}
        </dl>
      ) : <p className="mt-6 text-muted">Für diese Wallet liegen noch keine Kennzahlen vor.</p>}
      {a && a.recentSerials.length > 0 && (
        <div className="mt-8">
          <p className="eyebrow">Zuletzt bezeugt</p>
          <ul className="mt-2 space-y-1">{a.recentSerials.map((s) => <li key={s}><a className="link mono" href={`/p/${s}`}>{s}</a></li>)}</ul>
        </div>
      )}
    </div>
  );
}
