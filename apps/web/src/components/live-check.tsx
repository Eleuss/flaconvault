"use client";
import { useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { PDA_SEEDS, GradeName, hexToBytes } from "@flaconvault/proof";
import { CheckCircle2, CircleDashed, Loader2 } from "lucide-react";
import { PROGRAM_ID, SOLANA_RPC } from "@/lib/config";
import { addrUrl } from "@/lib/format";

interface OnChain { grade: number; scanCount: number; sealCount: number; void: boolean; createdAt: number; pda: string }

function decodePassport(data: Uint8Array, pda: string): OnChain {
  // Anchor account: 8-byte discriminator, then serial_hash[32], binding_hash[32], asset[32], issuer[32], grade u8, scan_count u32, seal_count u8, void bool, created_at i64
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32 * 4;
  const grade = dv.getUint8(o); o += 1;
  const scanCount = dv.getUint32(o, true); o += 4;
  const sealCount = dv.getUint8(o); o += 1;
  const isVoid = dv.getUint8(o) === 1; o += 1;
  const createdAt = Number(dv.getBigInt64(o, true));
  return { grade, scanCount, sealCount, void: isVoid, createdAt, pda };
}

export function LiveCheck({ serialHashHex, serverGrade, serverScanCount }: { serialHashHex: string; serverGrade: number; serverScanCount: number }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ok" | "missing" | "error"; data?: OnChain; error?: string }>({ status: "idle" });
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
      if (!info) { setState({ status: "missing", data: { grade: 0, scanCount: 0, sealCount: 0, void: false, createdAt: 0, pda: pda.toBase58() } }); return; }
      setState({ status: "ok", data: decodePassport(new Uint8Array(info.data), pda.toBase58()) });
    } catch (e) {
      setState({ status: "error", error: (e as Error).message });
    }
  }
  const d = state.data;
  return (
    <div className="flex flex-col gap-2">
      <button onClick={run} className="btn-outline btn-sm self-start" disabled={state.status === "loading"}>
        {state.status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
        Check live on-chain
      </button>
      {state.status === "ok" && d && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
          Passport PDA read: Grade {GradeName[d.grade]} · {d.scanCount} scans · {d.sealCount} seals{d.void ? " · VOID" : ""}
          {d.grade === serverGrade && d.scanCount === serverScanCount ? " · matches the server" : " · differs from the server"}
          <a className="link" href={addrUrl(d.pda)} target="_blank" rel="noreferrer">Explorer</a>
        </p>
      )}
      {state.status === "missing" && d && <p className="text-xs text-muted">No passport account at <span className="mono">{d.pda}</span> — this passport is not on-chain yet.</p>}
      {state.status === "error" && <p className="text-xs text-bad">RPC error: {state.error}</p>}
    </div>
  );
}
