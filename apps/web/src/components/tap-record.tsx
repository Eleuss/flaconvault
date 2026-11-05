"use client";
import { useEffect, useState } from "react";
import { PUBLIC_VERIFY_URL } from "@/lib/config";
import { ApiError, apiError } from "@/lib/errors";
import { asRecord, isTerminalRecord, startRecordPoll, tapRecordPollDelay, type PublicRecord } from "@/lib/public-record";
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

/**
 * Under the /t verdict: the public record of this tap. While pending it asks GET /api/tap/{tapId} every 5 s for at
 * most 10 minutes (the TAP is sent once the 180 s adoption window is over; a scan that adopts the tap replaces it with
 * its CHECK, whose record the tap then shows). `serverNow` is the server's clock at render, so the first client render
 * matches the server's ("within about 3 minutes" depends on the time).
 */
export function TapRecord({ tapId, serial, initial, serverNow }: { tapId: number; serial: string | null; initial: PublicRecord; serverNow: number }) {
  const [record, setRecord] = useState<PublicRecord>(initial);
  const [now, setNow] = useState(serverNow);
  const settled = isTerminalRecord(initial);
  useEffect(() => {
    if (settled) return;
    const tick = setInterval(() => setNow(Date.now() / 1000), 5000);
    const stop = startRecordPoll({
      load: () => tapRecord(tapId),
      delay: tapRecordPollDelay,
      onRecord: (r) => { setRecord(r); setNow(Date.now() / 1000); },
      // the tap is gone (404): keep the last line, stop asking
      stopOn: (e) => e instanceof ApiError && e.status === 404,
    });
    return () => { clearInterval(tick); stop(); };
  }, [tapId, settled]);
  return (
    <div className="mt-6 flex flex-col items-start gap-3">
      <RecordLine record={record} serial={serial} nowS={now} />
      <TestPhaseNotice />
    </div>
  );
}
