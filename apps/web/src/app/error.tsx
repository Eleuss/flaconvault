"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { retryBoundary } from "@/lib/retry";

/** Error boundary for every page below the root layout (header and footer stay). */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => { console.error("[page error]", error); }, [error]);
  return (
    <div className="page-in container-page py-24" role="alert">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-3 font-serif text-4xl">This page could not be shown</h1>
      <p className="mt-3 max-w-md text-muted">
        A temporary problem, most likely with the connection to the verification server. Nothing about a passport or a
        bottle has changed. Try again in a moment.
      </p>
      {error.digest && <p className="mono mt-2 text-xs text-muted">Reference {error.digest}</p>}
      <div className="mt-6 flex flex-wrap gap-3">
        <button onClick={() => retryBoundary(router, reset)} className="btn">Try again</button>
        <Link href="/" className="btn-outline">Back to home</Link>
      </div>
    </div>
  );
}
