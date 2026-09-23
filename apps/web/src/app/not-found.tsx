import Link from "next/link";
export default function NotFound() {
  return (
    <div className="container-page py-24">
      <h1 className="font-serif text-4xl">Diesen Pass gibt es nicht.</h1>
      <p className="mt-3 text-muted">Seriennummer prüfen oder ein Siegel antippen.</p>
      <Link href="/" className="btn-outline mt-6">Zur Startseite</Link>
    </div>
  );
}
