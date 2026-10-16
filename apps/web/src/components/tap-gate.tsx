"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { safeScanUrl, scanSession, tapHandoff } from "@/lib/handoff";
import type { TagParams } from "@/lib/verify-api";

/**
 * Raw tag parameters arrived at /t: hand them to a running scan session, otherwise let the verifier consume the tap.
 *
 * Handed over: if this tab is the scan tab (iPhone Safari loads the sticker link into it), go back to the scan page
 * with its tier/role/site. If the scan runs in another tab (Android opens a new tab), stay here and ask the user to
 * return there — a second /scan on the same session would only fail with "session expired".
 */
export function TapGate({ params }: { params: TagParams }) {
  const [handed, setHanded] = useState<null | { back: string | null }>(null);
  useEffect(() => {
    const s = scanSession.active();
    if (s) {
      tapHandoff.set(params);
      const back = scanSession.ownedHere(s) ? safeScanUrl(s.scanUrl) : null;
      setHanded({ back });
      if (!back) return;
      const id = setTimeout(() => window.location.replace(back), 1500);
      return () => clearTimeout(id);
    }
    const q = params.piccData
      ? `picc_data=${encodeURIComponent(params.piccData)}&cmac=${encodeURIComponent(params.cmac)}${params.enc ? `&enc=${encodeURIComponent(params.enc)}` : ""}`
      : `uid=${encodeURIComponent(params.uid)}&ctr=${encodeURIComponent(params.ctr)}&cmac=${encodeURIComponent(params.cmac)}`;
    window.location.replace(`${PUBLIC_VERIFY_URL}/t?${q}`);
  }, [params]);
  if (handed) {
    return (
      <div className="page-in container-page flex min-h-[70vh] flex-col justify-center py-16">
        <p className="eyebrow">Scan in progress</p>
        <h1 className="mt-3 font-serif text-4xl">Tap handed over</h1>
        {handed.back ? (
          <>
            <p className="mt-3 max-w-md text-muted">The tap was handed over to your running scan session. The scan continues in a moment.</p>
            <Link href={handed.back} className="btn mt-6 self-start">Back to scan <ArrowRight className="h-4 w-4" aria-hidden /></Link>
          </>
        ) : (
          <p className="mt-3 max-w-md text-muted">The tap was handed over to the scan running in your other tab. Return to that tab to continue; you can close this one.</p>
        )}
      </div>
    );
  }
  return <div className="container-page py-16 text-sm text-muted"><Loader2 className="inline h-4 w-4 animate-spin" aria-hidden /> Checking seal …</div>;
}

/** On the /t result page: remember the chip for /certify ("take over the UID of the last tap"). */
export function RememberTap({ uid, serial, counter }: { uid: string | null; serial: string | null; counter: number | null }) {
  // a tap without a UID (registered seal) clears an older unregistered UID, so certify never offers a stale chip
  useEffect(() => { import("@/lib/handoff").then((m) => (uid ? m.lastTap.set({ uid: uid.toUpperCase(), serial, counter }) : m.lastTap.clear())); }, [uid, serial, counter]);
  return null;
}
