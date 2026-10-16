"use client";
import { useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { PDA_SEEDS, GradeName, hexToBytes } from "@flaconvault/proof";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2 } from "lucide-react";
import { PROGRAM_ID, SOLANA_RPC } from "@/lib/config";
import { addrUrl, decodePassportAccount, liveCheckVerdict, type ChainPassport } from "@/lib/format";

/**
 * Reads the passport PDA straight from Solana (no verifier involved) and compares it with what the server shows:
 * effective grade and passport.scan_count against stats.onChainScanCount (confirmed, anchored scans).
 */
export function LiveCheck({ serialHashHex, serverGrade, serverOnChainScanCount }: { serialHashHex: string; serverGrade: number; serverOnChainScanCount?: number | null }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ok" | "missing" | "error"; data?: ChainPassport; pda?: string; error?: string }>({ status: "idle" });
  if (!PROGRAM_ID) {
    return <p className="text-xs text-muted">Live check: program not yet deployed to devnet.</p>;
  }
  async function run() {
    setState({ status: "loading" });
    try {
      const programId = new PublicKey(PROGRAM_ID);
      const [pda] = PublicKey.findProgramAddressSync([new TextEncoder().encode(PDA_SEEDS.passport), hexToBytes(serialHashHex)], programId);
      const conn = new Connection(SOLANA_RPC, "confirmed");
      const info = await conn.getAccountInfo(pda);
      const data = info && info.owner.equals(programId) ? decodePassportAccount(new Uint8Array(info.data)) : null;
      setState(data ? { status: "ok", data, pda: pda.toBase58() } : { status: "missing", pda: pda.toBase58() });
    } catch (e) {
      setState({ status: "error", error: (e as Error).message });
    }
  }
  const d = state.data;
  const verdict = d ? liveCheckVerdict(d, { grade: serverGrade, onChainScanCount: serverOnChainScanCount }) : null;
  return (
    <div className="flex flex-col gap-2">
      <button onClick={run} className="btn-outline btn-sm self-start" disabled={state.status === "loading"}>
        {state.status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
        Check live on-chain
      </button>
      {state.status === "ok" && d && verdict && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          {verdict.matches ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden /> : <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden />}
          Passport PDA read: Grade {GradeName[d.void ? 4 : d.grade]} · {d.scanCount} anchored {d.scanCount === 1 ? "scan" : "scans"} · {d.sealCount} {d.sealCount === 1 ? "seal" : "seals"}{d.void ? " · VOID" : ""} · {verdict.text}
          {state.pda && <a className="link" href={addrUrl(state.pda)} target="_blank" rel="noreferrer">Explorer</a>}
        </p>
      )}
      {state.status === "missing" && <p className="text-xs text-muted">No passport account at <span className="mono">{state.pda}</span> — this passport is not on-chain yet.</p>}
      {state.status === "error" && <p className="text-xs text-bad">RPC error: {state.error}</p>}
    </div>
  );
}
