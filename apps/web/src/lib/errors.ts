/**
 * Readable error messages. HTTP errors from the verifier arrive as `ApiError` (status + FastAPI `detail`), chain
 * failures from `sendAsV0` as `TxFailedError`; everything else is matched on its message.
 */

/** HTTP error from the verifier. `detail` is FastAPI's `detail` flattened to text, `code` a machine code like "tx_not_visible". */
export class ApiError extends Error {
  constructor(readonly path: string, readonly status: number, readonly detail: string | null, readonly code: string | null) {
    super(`${path}: ${detail ?? `HTTP ${status}`}`);
    this.name = "ApiError";
  }
}

/** The transaction was included in a block but failed (confirmation reported `err`). */
export class TxFailedError extends Error {
  constructor(readonly signature: string, readonly reason: string) {
    super(`The transaction failed on chain: ${reason}`);
    this.name = "TxFailedError";
  }
}

/** Builds an `ApiError` from a non-OK response without dumping raw JSON into the message. */
export async function apiError(path: string, r: Response): Promise<ApiError> {
  const text = await r.text().catch(() => "");
  let detail: string | null = null, code: string | null = null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const d = j?.detail ?? j?.error ?? j?.message;
    if (typeof d === "string") detail = d;
    else if (Array.isArray(d)) {
      // FastAPI validation errors: [{ loc: ["body", "tapToken"], msg: "Field required", ... }]
      detail = d.map((x: { loc?: unknown[]; msg?: string }) => {
        const loc = Array.isArray(x?.loc) ? x.loc.filter((l) => l !== "body").join(".") : "";
        return `${loc ? `${loc}: ` : ""}${x?.msg ?? "invalid"}`;
      }).join("; ");
    } else if (d && typeof d === "object") {
      const o = d as Record<string, unknown>;
      code = typeof o.code === "string" ? o.code : null;
      detail = typeof o.message === "string" ? o.message : typeof o.detail === "string" ? o.detail : code;
    }
  } catch {
    // not JSON: keep short plain text, never an HTML error page
    const t = text.trim();
    detail = t && !t.startsWith("<") ? t.slice(0, 160) : null;
  }
  if (!code && detail && /^[a-z][a-z0-9_]*$/.test(detail)) code = detail;
  return new ApiError(path, r.status, detail, code);
}

/** Machine codes the verifier sends as `detail` (see apps/verify/fv/routes_api.py and fv/ratelimit.py). */
export const CODES: Record<string, string> = {
  tx_not_visible: "The network has not shown the transaction yet. Try again in a few seconds.",
  tx_failed: "The transaction failed on chain.",
  tx_mismatch: "The transaction does not match this action (other wallet, passport or instruction).",
  nonce_invalid: "The scan session has expired or was already used. Start a new session.",
  not_issuer: "Only the wallet that issued this passport can do this.",
  event_confirmed: "This entry is already confirmed with another transaction.",
  chain_not_configured: "The verification server has no chain connection configured, so it cannot confirm transactions right now.",
  rate_limited: "Too many requests from this connection. Wait a minute, then try again.",
  // two causes on the verifier: an open report for this seal or passport (last 24 h), or the per-connection report budget
  report_limited: "A report for this seal is already open (from the last 24 hours), or too many reports came from this connection. Try again later.",
  media_nonce_invalid: "The photo upload needs a running scan session. Restart the scan.",
  resume_not_found: "This signed scan is no longer waiting to be anchored (already anchored or expired). Open the passport or start a new scan.",
  not_partner: "Certified scans and the vault/partner roles need a wallet registered as a FlaconVault partner. Connect the partner wallet or scan as owner.",
  request_too_large: "The request is too large for the verification server.",
};

/**
 * Program errors added with the hardened flacon/escrow programs, by Anchor error name ("Error Code: <Name>" in the
 * simulation log) and by the program's own message (what a landed-but-failed transaction reports).
 */
export const PROGRAM_ERRORS: Array<{ name: string; msg: string; text: string }> = [
  { name: "NotIssuerOrAuthority", msg: "Signer is neither the passport issuer", text: "Only the issuer of this passport (while a partner) or the registry authority can do this." },
  { name: "TooManySeals", msg: "maximum number of seals", text: "This passport already has the maximum number of seals (one box, one neck)." },
  { name: "ServerKeyNotValidNow", msg: "not valid at the current cluster time", text: "The verification server's signing key is no longer valid. Start a new scan." },
  { name: "StaleScanTimestamp", msg: "Signed ts is more than", text: "The server signature has expired (older than 10 minutes). Scan again." },
  { name: "CounterOutOfRange", msg: "24-bit NTAG counter range", text: "The seal's tap counter is out of range; this seal cannot be anchored any more." },
  { name: "PartnerNotFound", msg: "Partner is not registered", text: "This wallet is not a registered partner." },
  { name: "ServerKeyAlreadyRevoked", msg: "already expired or revoked", text: "This server key is already expired or revoked." },
  { name: "NotUpgradeAuthority", msg: "upgrade authority", text: "Only the program's upgrade authority can do this." },
  { name: "AssetMismatch", msg: "does not match the asset", text: "The Core asset does not match this passport." },
  { name: "InvalidAsset", msg: "not a Metaplex Core asset", text: "The account is not a Metaplex Core asset." },
  { name: "PriceChanged", msg: "price differs from the price the buyer agreed", text: "The price of this listing has changed. Reload the order and check the new price." },
  { name: "NotPassportOwner", msg: "Seller is not the owner", text: "Only the owner of the passport's Core asset (or its issuer, when it has no asset) can list it." },
  { name: "ReceiptMatched", msg: "receipt scan matched", text: "The receipt scan matched the shipping scan, so the order is released instead of disputed." },
  { name: "WrongTokenOwner", msg: "does not belong to the expected recipient", text: "The USDC account does not belong to the expected recipient." },
];

function programError(m: string): string | null {
  const code = /Error Code: (\w+)/.exec(m)?.[1];
  const hit = PROGRAM_ERRORS.find((p) => p.name === code) ?? PROGRAM_ERRORS.find((p) => m.includes(p.msg));
  return hit ? hit.text : null;
}

const sentence = (s: string) => { const t = s.trim().replace(/\s+/g, " "); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : t; };

function fromApi(e: ApiError): string {
  if (e.code && CODES[e.code]) return CODES[e.code];
  const d = e.detail ?? "";
  if (e.path.startsWith("/api/verify")) {
    if (e.status === 409) { const m = /belongs to (\S+)/.exec(d); return m ? `This seal belongs to a different passport (${m[1]}).` : "This seal belongs to a different passport."; }
    if (e.status === 422) {
      if (/mediaHash/i.test(d)) return "This tier needs a photo of the card. Photograph the card and try again.";
      if (/heat/i.test(d)) return "The indicator reading is inconsistent. Photograph the card again.";
      return "The server rejected the scan data. Restart the scan.";
    }
  }
  if (e.path.startsWith("/api/media")) {
    if (e.status === 422) return "No photo arrived at the server. Photograph the card again.";
    if (e.status === 413) return "The photos are too large or there are too many for this session. Restart the scan.";
    if (e.status === 415) return "The photo format was not accepted. Photograph the card again.";
  }
  if (e.status === 404) return d ? sentence(d) : "Not found.";
  if (e.status === 429) return "Too many requests. Wait a few seconds, then try again.";
  if (e.status >= 500) return `The verification server had a problem (HTTP ${e.status}). Try again in a moment.`;
  if (e.status === 422 || e.status === 409 || e.status === 400 || e.status === 403) return d ? `The server refused this: ${d.replace(/[.\s]+$/, "")}.` : `The server refused this request (HTTP ${e.status}).`;
  return d ? sentence(d) : `Request failed (HTTP ${e.status}).`;
}

/** One readable sentence for any error shown to the user. */
export function friendly(e: unknown): string {
  if (e instanceof ApiError) return fromApi(e);
  if (e instanceof TxFailedError) { const p = programError(e.reason); return p ? `The transaction failed on chain: ${p}` : e.message; }
  const name = (e as { name?: string })?.name ?? "";
  const m = (e as Error)?.message ?? String(e);
  if (name === "NotAllowedError" && !/wallet|transaction|sign/i.test(m)) return "Permission denied by the browser. Allow it in the site settings and try again.";
  if (name === "TimeoutError") return "The server did not answer in time. Check the connection and try again.";
  // SPL Token InsufficientFunds ("Error: insufficient funds", custom 0x1 of the token program) is a token shortfall, not SOL
  if (/Error: insufficient funds/i.test(m)) return "This wallet does not hold enough tokens (USDC) for this payment.";
  if (/prior credit|insufficient lamports|insufficient SOL|0x1\b/i.test(m)) return "This wallet has no SOL on devnet for the fee. Get devnet SOL (for example from faucet.solana.com), then try again.";
  if (/rejected|declined|cancel|abgelehnt/i.test(m)) return "Signature rejected or cancelled in the wallet app. Press again and confirm in the wallet.";
  if (/not connected|wallet.*connect|No wallet/i.test(m)) return "Wallet is no longer connected. Reconnect above.";
  if (/ChunkLoadError|Loading chunk|dynamically imported module/i.test(m)) return "Page is outdated (new version online). Reload the page and retry.";
  if (/429|Too Many Requests/i.test(m)) return "Devnet RPC overloaded (429). Wait 10 seconds, then press again.";
  if (/blockhash not found|block ?height exceeded|has expired/i.test(m)) return "The transaction expired before it was confirmed. Press again and confirm promptly in the wallet.";
  if (/Failed to fetch|Load failed|NetworkError|network request failed/i.test(m)) return "The server is unreachable. Check the connection and try again.";
  // Anchor / simulation errors: a readable text for the known ones, else the program's own message without the log dump
  const known = programError(m);
  if (known) return known;
  const anchor = /Error Message: ([^."\]]+)/.exec(m);
  if (anchor) return `The program refused the transaction: ${anchor[1].trim()}.`;
  const sim = /Transaction simulation failed: ([^.]+)/.exec(m);
  if (sim) return `The transaction would fail: ${sim[1].trim()}.`;
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}
