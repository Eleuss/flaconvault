/**
 * Readable error messages. HTTP errors from the verifier arrive as `ApiError` (status + FastAPI `detail`), chain
 * failures from `sendAsV0` as `TxFailedError`; everything else is matched on its message.
 */

/**
 * HTTP error from the verifier. `detail` is FastAPI's `detail` flattened to text, `code` a machine code like
 * "tx_not_visible". `retryAfter` is the Retry-After header in seconds (the verifier sends it with busy, rate_limited,
 * report_limited, media_limited and media_busy, and exposes it to the web origins via CORS), else null.
 */
export class ApiError extends Error {
  constructor(readonly path: string, readonly status: number, readonly detail: string | null, readonly code: string | null, readonly retryAfter: number | null = null) {
    super(`${path}: ${detail ?? `HTTP ${status}`}`);
    this.name = "ApiError";
  }
}

/** Retry-After in seconds (delta-seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterSeconds(header: string | null | undefined, now = Date.now()): number | null {
  const h = header?.trim();
  if (!h) return null;
  if (/^\d{1,9}$/.test(h)) return Number(h);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
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
  return new ApiError(path, r.status, detail, code, retryAfterSeconds(r.headers.get("retry-after")));
}

/**
 * Machine codes the verifier sends as `detail` (apps/verify/fv/routes_api.py, txverify.py, ratelimit.py, media_store.py,
 * bodylimit.py). errors.test.ts checks that every code raised there has an entry here.
 */
export const CODES: Record<string, string> = {
  tx_not_visible: "The network has not shown the transaction yet. Try again in a few seconds.",
  tx_failed: "The transaction failed on chain.",
  tx_mismatch: "The transaction does not match this action (other wallet, passport or instruction).",
  // all of the verifier's transaction lookups are in use (a global condition); api.events retries it on its own
  busy: "The verification server is busy checking other transactions. Wait a few seconds, then try again.",
  nonce_invalid: "The scan session has expired or was already used. Start a new session.",
  not_issuer: "Only the wallet that issued this passport can do this.",
  event_confirmed: "This entry is already confirmed with another transaction.",
  chain_not_configured: "The verification server has no chain connection configured, so it cannot confirm transactions right now.",
  rpc_unavailable: "The verification server cannot reach the Solana network right now. Try again later.",
  // per connection: the request budget, or (at /api/events) two confirmations of this connection still running
  rate_limited: "Too many requests from this connection. Wait a minute, then try again.",
  // two causes on the verifier: an open report for this seal or passport (last 24 h), or the per-connection report budget
  report_limited: "A report for this seal is already open (from the last 24 hours), or too many reports came from this connection. Try again later.",
  media_nonce_invalid: "The scan session of these photos has expired or was already used. Restart the scan.",
  media_limited: "This connection has uploaded too many photos for now. Try again later.",
  media_busy: "The verification server is receiving too many photos right now. Try again in a few minutes.",
  storage_full: "The verification server cannot store photos right now (its storage is full). Try again later.",
  resume_not_found: "This signed scan is no longer waiting to be anchored (already anchored or expired). Open the passport or start a new scan.",
  not_partner: "Certified scans and the vault/partner roles are signed only for a wallet registered as a FlaconVault partner. Connect the partner wallet before “Get signature” (on iPhone Safari: via WalletConnect). Without a partner wallet, open the scan without certification and scan as owner.",
  request_too_large: "The request is too large for the verification server.",
};

/** Codes whose Retry-After is worth showing as "try again in …". */
const WAIT_CODES = new Set(["busy", "rate_limited", "report_limited", "media_limited", "media_busy"]);
/** "about 40 seconds" / "about 3 minutes" / "about 2 hours". */
export function waitText(seconds: number): string {
  if (seconds <= 90) return `about ${Math.max(1, Math.round(seconds))} second${Math.round(seconds) === 1 ? "" : "s"}`;
  if (seconds <= 90 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hour${Math.round(seconds / 3600) === 1 ? "" : "s"}`;
}

/**
 * Program errors a user of the web app can run into, by Anchor error name ("Error Code: <Name>" in the simulation log)
 * and by a part of the program's own message (what a landed-but-failed transaction reports). A name that both programs
 * use (AssetMismatch, InvalidAsset, PassportVoid, SealPassportMismatch) has one `msg` that matches both messages;
 * errors.test.ts checks every entry against the committed IDLs. Errors not listed here keep the program's message.
 */
export const PROGRAM_ERRORS: Array<{ name: string; msg: string; text: string }> = [
  // flacon
  { name: "NotPartner", msg: "Signer is not a registered partner", text: "This wallet is not a registered FlaconVault partner, so it cannot do this." },
  { name: "SealPassportMismatch", msg: "Seal does not belong to", text: "This seal does not belong to this passport." },
  { name: "SealDead", msg: "Seal is dead (no longer answers)", text: "This seal is marked as not responding on chain: no further scans can be anchored." },
  { name: "PassportVoid", msg: "Passport is void", text: "This passport is void (opened or dead seal, or grade VOID): no further scans, seals or sales." },
  { name: "CounterNotIncreasing", msg: "greater than the seal's last counter", text: "A newer tap of this seal is already anchored. Tap the seal again and do a new scan." },
  { name: "ServerKeyNotValidAtTs", msg: "not valid at the given ts", text: "The verification server's key was not valid when it signed this scan. Do a new scan." },
  { name: "TierNotAllowedForRole", msg: "may attest at most tier 2", text: "Owners, sellers and buyers can anchor scans up to tier 2 (with photo); certified tiers need the vault or partner role." },
  { name: "SiteIdNotAllowed", msg: "site_id may only be set for role", text: "A site can only be given for the vault or partner role." },
  { name: "UnknownSite", msg: "site_id is not registered", text: "This site is not registered in the FlaconVault registry." },
  { name: "NotIssuerOrAuthority", msg: "Signer is neither the passport issuer", text: "Only the issuer of this passport (while a partner) or the registry authority can do this." },
  { name: "TooManySeals", msg: "maximum number of seals", text: "This passport already has the maximum number of seals (one box, one neck)." },
  { name: "ServerKeyNotValidNow", msg: "not valid at the current cluster time", text: "The verification server's signing key is no longer valid. Start a new scan." },
  { name: "StaleScanTimestamp", msg: "Signed ts is more than", text: "The server signature has expired (older than 10 minutes). Scan again." },
  { name: "CounterOutOfRange", msg: "24-bit NTAG counter range", text: "The seal's tap counter is out of range; this seal cannot be anchored any more." },
  { name: "PartnerNotFound", msg: "Partner is not registered", text: "This wallet is not a registered partner." },
  { name: "ServerKeyAlreadyRevoked", msg: "already expired or revoked", text: "This server key is already expired or revoked." },
  { name: "NotUpgradeAuthority", msg: "upgrade authority", text: "Only the program's upgrade authority can do this." },
  { name: "AssetMismatch", msg: "Asset account does not match the", text: "The Core asset does not match this passport." },
  { name: "InvalidAsset", msg: "Asset account is not", text: "The account is not a Metaplex Core asset." },
  { name: "AssetNotOwnedByIssuer", msg: "must be owned by the issuer", text: "The Core asset must belong to the wallet that issues the passport." },
  // escrow
  { name: "InvalidState", msg: "Order is not in the required state", text: "The order has already moved on to another step. Reload the order." },
  { name: "NotSeller", msg: "Signer is not the order's seller", text: "Only the seller of this order can do this. Connect the seller's wallet." },
  { name: "NotBuyer", msg: "Signer is not the order's buyer", text: "Only the buyer of this order can do this. Connect the buyer's wallet." },
  { name: "SellerCannotBuy", msg: "Seller cannot buy their own listing", text: "You cannot buy your own listing." },
  { name: "WrongMint", msg: "does not match the escrow USDC mint", text: "That token account does not hold the escrow's USDC." },
  { name: "ScanSealMismatch", msg: "ScanProof does not belong to the given seal", text: "That scan was made on another seal." },
  { name: "ScanAttesterMismatch", msg: "ScanProof attester is not the expected party", text: "That scan was anchored by another wallet: the shipping scan must be the seller's own, the receipt scan the buyer's own." },
  { name: "SellerScanMismatch", msg: "not the one recorded on the order", text: "The shipping scan does not match the one recorded on the order. Reload the order." },
  { name: "ReceiptScanNotNewer", msg: "higher counter than the pre-ship scan", text: "The receipt scan must be a newer tap of the seal than the shipping scan. Do a new scan after receiving the bottle." },
  { name: "DisputeWindowNotElapsed", msg: "has not elapsed yet", text: "The waiting period has not ended yet. Try again after the deadline shown on the order." },
  { name: "SealNotDead", msg: "Seal is not dead", text: "The seal still answers on chain, so this refund is not possible." },
  { name: "AssetAlreadyDeposited", msg: "Asset already deposited", text: "The Core asset is already in escrow custody." },
  { name: "PriceChanged", msg: "price differs from the price the buyer agreed", text: "The price of this listing has changed. Reload the order and check the new price." },
  { name: "NotPassportOwner", msg: "Seller is not the owner", text: "Only the owner of the passport's Core asset can list it (without a Core asset: its issuer, while still a partner)." },
  { name: "ReceiptMatched", msg: "receipt scan matched", text: "The receipt scan matched the shipping scan, so the order is released instead of disputed." },
  { name: "WrongTokenOwner", msg: "does not belong to the expected recipient", text: "The USDC account does not belong to the expected recipient." },
  { name: "ScanBeforeOrderStep", msg: "older than this order step", text: "This scan was made before the reservation (shipping scan) or before shipping (receipt scan). Do a new scan and record that one." },
  { name: "DeadSealAfterShipping", msg: "a dead seal is settled by the escrow admin", text: "The order is shipped: only the escrow admin can refund it now. Contact the admin before the receipt deadline." },
];

function programError(m: string): string | null {
  const code = /Error Code: (\w+)/.exec(m)?.[1];
  const hit = PROGRAM_ERRORS.find((p) => p.name === code) ?? PROGRAM_ERRORS.find((p) => m.includes(p.msg));
  return hit ? hit.text : null;
}

const sentence = (s: string) => { const t = s.trim().replace(/\s+/g, " "); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : t; };

/** 403 "admin token required" (the verifier's admin and simulator-reset routes). */
export const ADMIN_TOKEN_TEXT = "The verification server refused the admin token. Enter the FV_ADMIN_TOKEN of this verifier; a verifier without FV_ADMIN_TOKEN set refuses this action.";

function fromApi(e: ApiError): string {
  if (e.code && CODES[e.code]) {
    const t = CODES[e.code];
    return e.retryAfter != null && e.retryAfter > 0 && WAIT_CODES.has(e.code) ? `${t} The server asks to wait ${waitText(e.retryAfter)}.` : t;
  }
  const d = e.detail ?? "";
  // 422 texts of the verifier's input checks that can reach a user (routes_api.py)
  if (e.status === 422) {
    if (/^invalid serial/i.test(d)) return "The serial number is not valid: 3–64 characters, letters and digits, plus '.', '_' or '-'.";
    if (/^txSig must be/i.test(d)) return "The transaction signature is malformed. Reload the page and try again.";
    if (/^(attester|actor) must be a base58 pubkey/i.test(d)) return "The wallet address was not accepted. Reconnect the wallet and try again.";
  }
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
    if (e.status === 411) return "The photo upload was refused because the browser did not send its size. Try again, or use another browser.";
    if (e.status === 413) {
      if (/per session/i.test(d)) return "This scan session already holds the most photos it can take (6). Restart the scan for a new session.";
      if (/each file/i.test(d)) return "A photo is larger than the server accepts (8 MB). Photograph the card again.";
      return "The photos are too large or too many for one upload. Photograph the card again.";
    }
    if (e.status === 415) return "The photo format was not accepted (JPEG, PNG or WebP only). Photograph the card again.";
  }
  // /api/dev/reset, /api/reconcile, /api/admin/*: no x-admin-token, a wrong one, or no FV_ADMIN_TOKEN on the verifier
  if (e.status === 403 && /^admin token required$/i.test(d.trim())) return ADMIN_TOKEN_TEXT;
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
  // An Anchor error names itself in the simulation log: decide on it before the keyword guesses below, which would
  // otherwise read a log line such as "Instruction: Cancel" as a cancel in the wallet app
  if (/Error Code: \w+/.test(m)) {
    const p = programError(m);
    if (p) return p;
    const msg = /Error Message: ([^."\]]+)/.exec(m);
    if (msg) return `The program refused the transaction: ${msg[1].trim()}.`;
  }
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
