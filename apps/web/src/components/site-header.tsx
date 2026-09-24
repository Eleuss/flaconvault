import Link from "next/link";
import { Menu } from "lucide-react";
import { DEV_SIMULATOR } from "@/lib/config";
import { WalletButton } from "./wallet-button";

const links = [
  { href: "/scan", label: "Siegel prüfen" },
  { href: "/p/SN-2026-000001", label: "Pass" },
  { href: "/certify", label: "Zertifizieren" },
  { href: "/market", label: "Markt" },
];

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-bg/80 backdrop-blur">
      <div className="container-page flex h-14 items-center justify-between gap-3">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 font-semibold tracking-tight" aria-label="FlaconVault Startseite">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-ink">
            <span className="block h-3 w-3 rounded-full border-2 border-amber" />
          </span>
          FlaconVault
        </Link>
        <nav className="hidden items-center gap-5 text-sm text-muted md:flex">
          {links.map((l) => <Link key={l.href} href={l.href} className="hover:text-ink">{l.label}</Link>)}
          {DEV_SIMULATOR && <Link href="/dev" className="rounded-full border border-line px-3 py-1 text-xs hover:border-ink hover:text-ink">Simulator</Link>}
          <WalletButton />
        </nav>
        {/* mobile: compact menu, wallet inside */}
        <details className="relative md:hidden">
          <summary className="btn-outline btn-sm list-none cursor-pointer" aria-label="Menü"><Menu className="h-4 w-4" aria-hidden /> Menü</summary>
          <div className="absolute right-0 top-11 z-20 w-56 rounded-2xl border border-line bg-surface p-2 shadow-soft">
            {links.map((l) => <Link key={l.href} href={l.href} className="block rounded-xl px-3 py-2 text-sm hover:bg-bg">{l.label}</Link>)}
            {DEV_SIMULATOR && <Link href="/dev" className="block rounded-xl px-3 py-2 text-sm hover:bg-bg">Simulator</Link>}
            {DEV_SIMULATOR && <Link href="/dev/vision" className="block rounded-xl px-3 py-2 text-sm hover:bg-bg">Indikatorlesung</Link>}
            <div className="mt-1 border-t border-line px-1 pt-2"><WalletButton /></div>
          </div>
        </details>
      </div>
    </header>
  );
}
