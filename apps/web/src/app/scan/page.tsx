import type { Metadata } from "next";
import Link from "next/link";
export const metadata: Metadata = { title: "Scan" };
export default function ScanPage() {
  return (
    <div className="page-in container-page py-16">
      <p className="eyebrow">Scan-Flow · Abschnitt 8</p>
      <h1 className="mt-3 font-serif text-4xl">Tap, Foto, Signatur, Transaktion</h1>
      <p className="mt-3 max-w-md text-muted">Der neunstufige Scan-Flow ist der nächste Bauabschnitt (25.–28.09.). Bis dahin: Tag-Landing und Pass laufen über den Simulator.</p>
      <Link href="/dev" className="btn-outline mt-6">Zum Simulator</Link>
    </div>
  );
}
