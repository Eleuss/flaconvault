/**
 * A minimal Solana JSON-RPC client for `verifyPass`, over the global `fetch`. Read-only by construction: it can call
 * nothing but getAccountInfo, getSignaturesForAddress and getTransaction, so it never sends a transaction.
 * Error messages never contain the URL (RPC URLs often carry an API key).
 */
import type { PassRpc, RpcAccountInfo, RpcSignatureInfo, RpcTransaction } from "./verify-pass.ts";

export const READ_ONLY_RPC_METHODS = ["getAccountInfo", "getSignaturesForAddress", "getTransaction"] as const;
type ReadOnlyMethod = (typeof READ_ONLY_RPC_METHODS)[number];

export interface JsonRpcOptions {
  commitment?: "confirmed" | "finalized";
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries after a network error, HTTP 429 or 5xx (backoff 0.5, 1, 2, 4 … s). Default 4. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class RpcError extends Error {
  constructor(message: string) { super(message); this.name = "RpcError"; }
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function jsonRpcPassClient(url: string, opts: JsonRpcOptions = {}): PassRpc {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new RpcError("RPC URL is not a URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new RpcError("RPC URL must be http(s)");
  const doFetch = opts.fetch ?? fetch;
  const commitment = opts.commitment ?? "finalized";
  const retries = opts.retries ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let id = 0;

  async function call<T>(method: ReadOnlyMethod, params: unknown[]): Promise<T> {
    if (!READ_ONLY_RPC_METHODS.includes(method)) throw new RpcError(`${method} is not a read-only method`);
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST", headers: { "content-type": "application/json" }, body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch (e) {
        if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new RpcError(`${method}: network error (${(e as Error).name})`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (json.error) throw new RpcError(`${method}: RPC error ${json.error.code} ${json.error.message}`);
      return json.result as T;
    }
  }

  return {
    async getAccountInfo(address: string): Promise<RpcAccountInfo | null> {
      const r = await call<{ value: { owner: string; data: [string, string] } | null }>(
        "getAccountInfo", [address, { encoding: "base64", commitment }]);
      if (!r.value) return null;
      if (r.value.data[1] !== "base64") throw new RpcError("getAccountInfo: expected base64 data");
      return { owner: r.value.owner, data: base64ToBytes(r.value.data[0]) };
    },
    getSignaturesForAddress(address: string, o: { before?: string; limit: number }): Promise<RpcSignatureInfo[]> {
      return call("getSignaturesForAddress", [address, { ...o, commitment }]);
    },
    getTransaction(signature: string): Promise<RpcTransaction | null> {
      return call("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment }]);
    },
  };
}
