import Link from "next/link";
import { DEV_SIMULATOR } from "@/lib/config";
import { WalletButton } from "./wallet-button";

export function SiteHeader() {
  return (
    <header className="hairline border-t-0 border-b border-line bg-bg/80 backdrop-blur">
      <div className="container-page flex h-14 items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight" aria-label="FlaconVault Startseite">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-ink">
            <span className="block h-3 w-3 rounded-full border-2 border-amber" />
          </span>
          FlaconVault
        </Link>
        <nav className="flex items-center gap-5 text-sm text-muted">
          <Link href="/scan" className="hover:text-ink">Siegel prüfen</Link>
          <Link href="/p/SN-2026-000001" className="hover:text-ink">Pass</Link>
          <Link href="/certify" className="hover:text-ink">Zertifizieren</Link>
          {DEV_SIMULATOR && <Link href="/dev" className="rounded-full border border-line px-3 py-1 text-xs hover:border-ink hover:text-ink">Simulator</Link>}
          <WalletButton />
        </nav>
      </div>
    </header>
  );
}
