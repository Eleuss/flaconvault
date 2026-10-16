"use client";
import { useEffect } from "react";
import "./globals.css";

/** Last-resort boundary: replaces the root layout when the layout itself fails, so it renders its own html/body. */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("[global error]", error); }, [error]);
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans text-[15px] leading-relaxed">
        <div className="container-page py-24" role="alert">
          <p className="eyebrow">FlaconVault</p>
          <h1 className="mt-3 font-serif text-4xl">Something went wrong</h1>
          <p className="mt-3 max-w-md text-muted">The app could not be loaded. Nothing about a passport or a bottle has changed. Try again in a moment.</p>
          {error.digest && <p className="mono mt-2 text-xs text-muted">Reference {error.digest}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {/* full page loads: the root layout or the router may be what failed, and reset() alone would re-render the
                cached payload that holds the error */}
            <button onClick={() => window.location.reload()} className="btn">Try again</button>
            <a href="/" className="btn-outline">Back to home</a>
          </div>
        </div>
      </body>
    </html>
  );
}
