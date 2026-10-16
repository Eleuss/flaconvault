import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="hairline mt-16">
      <div className="container-page flex flex-col gap-2 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>FlaconVault · Handling and provenance record for perfume bottles · Solana Devnet</p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>The chip proves authenticity. The chain makes it transferable.</span>
          <Link href="/privacy" className="link">Privacy</Link>
        </p>
      </div>
    </footer>
  );
}
