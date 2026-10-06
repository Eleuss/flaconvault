"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { scanSession, tapHandoff } from "@/lib/handoff";
import type { TagParams } from "@/lib/verify-api";

/** Raw tag parameters arrived at /t: hand them to a running scan session, otherwise let the verifier consume the tap. */
export function TapGate({ params }: { params: TagParams }) {
  const [handed, setHanded] = useState<boolean | null>(null);
  useEffect(() => {
    if (scanSession.active()) { tapHandoff.set(params); setHanded(true); return; }
    setHanded(false);
    const q = params.piccData
      ? `picc_data=${encodeURIComponent(params.piccData)}&cmac=${encodeURIComponent(params.cmac)}${params.enc ? `&enc=${encodeURIComponent(params.enc)}` : ""}`
      : `uid=${encodeURIComponent(params.uid)}&ctr=${encodeURIComponent(params.ctr)}&cmac=${encodeURIComponent(params.cmac)}`;
    window.location.replace(`${PUBLIC_VERIFY_URL}/t?${q}`);
  }, [params]);
  if (handed) {
    return (
      <div className="page-in container-page flex min-h-[70vh] flex-col justify-center py-16">
        <p className="eyebrow">Scan läuft</p>
        <h1 className="mt-3 font-serif text-4xl">Tap übernommen</h1>
        <p className="mt-3 max-w-md text-muted">Der Tap wurde an deine laufende Scan-Sitzung übergeben. Wechsle zurück zum Scan-Tab, dort geht es automatisch weiter.</p>
        <Link href="/scan" className="btn mt-6 self-start">Zum Scan <ArrowRight className="h-4 w-4" aria-hidden /></Link>
      </div>
    );
  }
  return <div className="container-page py-16 text-sm text-muted"><Loader2 className="inline h-4 w-4 animate-spin" aria-hidden /> Siegel wird geprüft …</div>;
}

/** On the /t result page: remember the chip for /certify ("UID vom letzten Tap übernehmen"). */
export function RememberTap({ uid, serial, counter }: { uid: string | null; serial: string | null; counter: number | null }) {
  useEffect(() => { if (uid) import("@/lib/handoff").then((m) => m.lastTap.set({ uid: uid.toUpperCase(), serial, counter })); }, [uid, serial, counter]);
  return null;
}
