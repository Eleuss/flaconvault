import type { Metadata } from "next";
import Link from "next/link";
import { getAttester } from "@/lib/api";
import { fmtDate, passportHref, short } from "@/lib/format";
import { Unavailable } from "@/components/badges";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Attester" };

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export default async function WalletPage({ params }: { params: { pubkey: string } }) {
  const pubkey = safeDecode(params.pubkey);
  const res = await getAttester(pubkey);
  if (res.status === "error") return <Unavailable what="This wallet's record" retry={`/wallet/${encodeURIComponent(pubkey)}`} />;
  const a = res.status === "ok" ? res.data : null;
  const escrows = a ? a.escrowsOk + a.escrowsDisputed : 0;
  return (
    <div className="page-in container-page py-12">
      <p className="eyebrow">Attester</p>
      <h1 className="mt-3 font-serif text-4xl">{a?.label ?? short(pubkey, 6)}</h1>
      <p className="mono mt-2 break-all text-muted">{pubkey}</p>
      {a ? (
        <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
          {[
            ["Since", a.firstSeen ? fmtDate(a.firstSeen) : "–"], ["Scans", a.scanCount], ["Certified scans", a.certifiedCount],
            ["Agreement rate", a.agreeRate == null ? "–" : `${Math.round(a.agreeRate * 100)} % (${a.agreeCount}/${a.compareCount})`],
            ["Escrows without dispute", escrows > 0 ? `${a.escrowsOk} / ${escrows}` : "–"], ["Role verified", a.isPartner ? "✓ Partner" : "–"],
          ].map(([k, v]) => (
            <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd className="mt-1 font-serif text-3xl tabular">{v}</dd></div>
          ))}
        </dl>
      ) : <p className="mt-6 text-muted">No metrics for this wallet yet.</p>}
      {a && a.recentSerials.length > 0 && (
        <div className="mt-8">
          <p className="eyebrow">Recently witnessed</p>
          <ul className="mt-2 space-y-1">{a.recentSerials.map((s) => <li key={s}><Link className="link mono" href={passportHref(s)}>{s}</Link></li>)}</ul>
        </div>
      )}
    </div>
  );
}
