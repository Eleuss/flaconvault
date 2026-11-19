import Link from "next/link";
import { Clock, FlaskConical, Loader2 } from "lucide-react";
import { CLUSTER, type ClusterName } from "@/lib/config";
import { TEST_PHASE_NOTICE, recordLine, showTestNotice, type PublicRecord } from "@/lib/public-record";
import { cn } from "@/lib/cn";

/**
 * The public record line under a scan result (/t and the scan page): pending, saved, kept off the record, not saved.
 * `soon`: a pending TAP still waits for its send time (lib/public-record.ts tapSendsSoon, /t only). `live`: the record
 * is still being asked for; a pending line that is no longer polled shows no spinner.
 */
export function RecordLine({ record, serial, soon = false, live = true, className }: { record: PublicRecord; serial: string | null | undefined; soon?: boolean; live?: boolean; className?: string }) {
  const l = recordLine(record, serial, soon);
  if (l.kind === "pending") {
    return (
      <p className={cn("flex items-center gap-2 text-sm text-muted", className)} role="status">
        {l.soon ? <Clock className="h-4 w-4 shrink-0" aria-hidden /> : live ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
        {l.text}
      </p>
    );
  }
  if (l.kind === "recorded") {
    return (
      <p className={cn("text-sm", className)} role="status">
        <span className="font-medium text-ok">{l.text}</span>
        {l.link && <> <span className="text-muted">·</span> <Link href={l.link.href} className="link">{l.link.label}</Link></>}
      </p>
    );
  }
  return <p className={cn("text-sm text-muted", className)} role="status">{l.text}</p>;
}

/** "Test phase: …" while the configured cluster is not mainnet (NEXT_PUBLIC_SOLANA_CLUSTER); nothing on mainnet. */
export function TestPhaseNotice({ className, cluster = CLUSTER }: { className?: string; cluster?: ClusterName }) {
  if (!showTestNotice(cluster)) return null;
  return (
    <p className={cn("inline-flex max-w-lg items-start gap-2 rounded-xl border border-line px-3 py-2 text-xs text-muted", className)} role="note">
      <FlaskConical className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{TEST_PHASE_NOTICE}</span>
    </p>
  );
}
