"use client";
import { useEffect, useState } from "react";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { ApiError, apiError } from "@/lib/errors";
import { asRecord, isTerminalRecord, tapSendsSoon, watchTapRecord, type PublicRecord, type TapLine } from "@/lib/public-record";
import { RecordLine, TestPhaseNotice } from "./public-record";

/**
 * GET /api/tap/{tapId} → its `record`. A plain fetch rather than lib/verify-api's `api.tap`, which would pull the
 * proof package into the tap landing page's bundle.
 */
async function tapRecord(tapId: number): Promise<PublicRecord | null> {
  const path = `/api/tap/${encodeURIComponent(String(tapId))}`;
  const r = await fetch(`${PUBLIC_VERIFY_URL}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw await apiError(path, r);
  return asRecord(((await r.json()) as { record?: unknown }).record);
}

/** "The tab became visible again" (lib/public-record.ts watchTapRecord). */
function onTabVisible(cb: () => void): () => void {
  const h = () => { if (document.visibilityState === "visible") cb(); };
  document.addEventListener("visibilitychange", h);
  return () => document.removeEventListener("visibilitychange", h);
}

/**
 * Under the /t verdict: the public record of this tap. While pending it asks GET /api/tap/{tapId} every 5 s for at
 * most 10 minutes (the TAP is sent once the 180 s adoption window is over; a scan that adopts the tap replaces it with
 * its CHECK, whose record the tap then shows). The line goes when the record does (null, or the tap's 404); when the
 * 10 minutes run out it stays without its spinner and is loaded once more whenever the tab becomes visible again
 * (lib/public-record.ts watchTapRecord).
 *
 * "within about 3 minutes" is decided from the tap's own time `tapTs` (verifier clock) on `now`, the server's clock:
 * `serverNow` at render — so the first client render matches the server's — then the device clock shifted onto it.
 * `now` never goes back, and once the line has left "within about 3 minutes" it never returns to it (`leftSoon`).
 */
export function TapRecord({ tapId, tapTs, serial, initial, serverNow }: { tapId: number; tapTs: number | null; serial: string | null; initial: PublicRecord; serverNow: number }) {
  const [line, setLine] = useState<TapLine | null>({ record: initial, live: !isTerminalRecord(initial) });
  const [now, setNow] = useState(serverNow);
  const [leftSoon, setLeftSoon] = useState(false);
  const settled = isTerminalRecord(initial);
  useEffect(() => {
    if (settled) return;
    const offset = serverNow - Date.now() / 1000;
    const clock = () => setNow((n) => Math.max(n, Date.now() / 1000 + offset));
    const tick = setInterval(clock, 5000);
    const stop = watchTapRecord({
      initial,
      load: () => tapRecord(tapId),
      // the tap is gone (404): so is its record
      isGone: (e) => e instanceof ApiError && e.status === 404,
      show: (l) => { setLine(l); clock(); },
      onVisible: onTabVisible,
    });
    return () => { clearInterval(tick); stop(); };
  }, [tapId, settled, initial, serverNow]);
  const soon = tapSendsSoon(line?.record ?? null, tapTs, now, leftSoon);
  useEffect(() => { if (!soon) setLeftSoon(true); }, [soon]);
  if (!line) return null;
  return (
    <div className="mt-6 flex flex-col items-start gap-3">
      <RecordLine record={line.record} serial={serial} soon={soon} live={line.live} />
      <TestPhaseNotice />
    </div>
  );
}
