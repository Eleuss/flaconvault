/**
 * verify-pass (docs/public-record.md §8.2): checks from public chain data alone that the v2 scan history of a pass is
 * complete and in order, and that FlaconVault's scan key signed every entry. Read-only; it takes any RPC that
 * implements `PassRpc` (`jsonRpcPassClient` in rpc.ts, or a fake in tests).
 *
 * 1. Derive the Passport and Holding PDAs; read Passport, Holding and Registry (discriminators checked).
 * 2. List the Holding's transactions (every `record_scan_v2` writes it, D9), oldest first, failed ones dropped.
 * 3. In each, every top-level `record_scan_v2` instruction for this Holding: the instruction before it is an Ed25519
 *    precompile instruction; its signature verifies here; the FVSCAN2 message names this program, this cluster and
 *    this passport; the seal account is the PDA of the signed uid hash; the key id is a registry key with that
 *    public key, valid at the signed ts.
 * 4. Fold the accepted messages from zero and compare with Holding.scan_head and head_count.
 *
 * What this cannot show: the seal's secret check (SUN/CMAC) itself, which only FlaconVault can do, and v1 scans
 * (ScanProof accounts), which are not part of the scan head.
 */
import { ActorKindName, ClusterName, PurposeName } from "./enums.ts";
import { bytesEqual, bytesToHex, sha256Hex } from "./bytes.ts";
import { base58Decode, base58Encode } from "./b58.ts";
import { pdaHolding, pdaPassport, pdaRegistry, pdaSeal } from "./pda.ts";
import { serialHash } from "./message.ts";
import {
  ED25519_PROGRAM_ID, parseEd25519InstructionData, parseScanMessageV2, type Ed25519Payload, type ParsedScanMessageV2,
} from "./message2.ts";
import { foldScanHead, SCAN_HEAD_ZERO } from "./holding.ts";
import { ed25519Verify } from "./sign.ts";
import {
  decodeHolding, decodePassport, decodeRegistry, RECORD_SCAN_V2_DISCRIMINATOR, serverKeyValidAt,
  type HoldingAccount, type RegistryAccount,
} from "./accounts.ts";

// ---- RPC surface (the subset of Solana JSON-RPC results that verify-pass reads) --------------------------

export interface RpcAccountInfo { owner: string; data: Uint8Array }
export interface RpcSignatureInfo { signature: string; slot: number; err: unknown }
/** A compiled instruction as `getTransaction(…, {encoding: "json"})` returns it (data in base58). */
export interface RpcInstruction { programIdIndex: number; accounts: number[]; data: string }
export interface RpcTransaction {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: unknown[];
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RpcInstruction[] } };
}
export interface PassRpc {
  getAccountInfo(address: string): Promise<RpcAccountInfo | null>;
  /** Newest first, at most `limit`, strictly older than `before` when given (Solana semantics). */
  getSignaturesForAddress(address: string, opts: { before?: string; limit: number }): Promise<RpcSignatureInfo[]>;
  getTransaction(signature: string): Promise<RpcTransaction | null>;
}

/** Input or RPC problems: the CLI exits with 2. "Not complete" is a result, not an error. */
export class VerifyPassError extends Error {
  constructor(message: string) { super(message); this.name = "VerifyPassError"; }
}

/** Account positions of `record_scan_v2` (§7.6; the IDL is authoritative, src/verify-pass.test.ts compares). */
export const RECORD_SCAN_V2_ACCOUNTS = {
  registry: 0, holderConfig: 1, passport: 2, seal: 3, holding: 4, instructions: 5, actorSigner: 6, asset: 7,
  eventAuthority: 8, program: 9,
} as const;

export const VERDICT_COMPLETE = "complete and in order";
export const verdictIncomplete = (found: number, holdingSays: number) =>
  `incomplete or out of order (found ${found}, holding says ${holdingSays})`;

export interface VerifyPassOptions {
  programId: string;   // base58
  clusterTag: number;  // the cluster the RPC serves (cluster enum)
  serial: string;
  /** getSignaturesForAddress page size, default 1000 (the RPC maximum). */
  pageLimit?: number;
  /** Re-reads when the Holding changed while the history was read, default 3. */
  maxAttempts?: number;
}
export interface PassScan {
  signature: string; slot: number; instruction: number; ts: number; counter: number; purpose: string; actorKind: string;
  tier: number; seal: string; keyId: number; msgSha256Hex: string;
}
export interface RejectedScan { signature: string; slot: number; instruction: number; reason: string }
export interface VerifyPassResult {
  serial: string; programId: string; cluster: string; passport: string; holding: string;
  /** Passport.asset == Holding PDA: the pass is held in a FlaconVault account (else the Core-asset owner rule). */
  heldInAccount: boolean;
  /** Passport.scan_count counts v1 and v2 scans. */
  passportScanCount: number;
  holdingHeadCount: number; holdingHeadHex: string;
  found: number; computedHeadHex: string;
  complete: boolean; verdict: string;
  transactions: number;
  scans: PassScan[]; rejected: RejectedScan[];
}

interface Context {
  programId: string; programIdBytes: Uint8Array; clusterTag: number; passport: string; holding: string;
  serialHash: Uint8Array; registry: RegistryAccount;
}
type Inspected = { accepted: PassScan & { msg: Uint8Array } } | { rejected: RejectedScan } | null;

function keysOf(tx: RpcTransaction): string[] {
  const la = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])];
}
const nameOr = (names: Record<number, string>, code: number) => names[code] ?? `?${code}`;

/** Step 3 for one top-level instruction: null when it is not a `record_scan_v2` for this Holding. */
function inspectInstruction(tx: RpcTransaction, index: number, keys: string[], ctx: Context): Inspected {
  const ix = tx.transaction.message.instructions[index];
  if (keys[ix.programIdIndex] !== ctx.programId) return null;
  let data: Uint8Array;
  try { data = base58Decode(ix.data); } catch { return null; }
  if (data.length < 8 || !bytesEqual(data.slice(0, 8), RECORD_SCAN_V2_DISCRIMINATOR)) return null;
  const at = (name: keyof typeof RECORD_SCAN_V2_ACCOUNTS) => keys[ix.accounts[RECORD_SCAN_V2_ACCOUNTS[name]]];
  if (at("holding") !== ctx.holding) return null; // another pass's scan in the same transaction
  const signature = tx.transaction.signatures[0];
  const reject = (reason: string): Inspected => ({ rejected: { signature, slot: tx.slot, instruction: index, reason } });

  if (data.length < 9) return reject("record_scan_v2 data has no server key id");
  const keyId = data[8];
  if (at("passport") !== ctx.passport) return reject("passport account is not this pass");
  const prev = index > 0 ? tx.transaction.message.instructions[index - 1] : undefined;
  if (!prev || keys[prev.programIdIndex] !== ED25519_PROGRAM_ID) return reject("no Ed25519 instruction right before");
  let payload: Ed25519Payload;
  try {
    payload = parseEd25519InstructionData(base58Decode(prev.data), { ownIndex: index - 1 });
  } catch (e) {
    return reject((e as Error).message);
  }
  if (!ed25519Verify(payload.signature, payload.message, payload.pubkey)) return reject("bad server signature");
  let m: ParsedScanMessageV2;
  try { m = parseScanMessageV2(payload.message); } catch { return reject("not an FVSCAN2 message"); }
  if (!bytesEqual(m.programId, ctx.programIdBytes)) return reject("message is bound to another program id");
  if (m.clusterTag !== ctx.clusterTag) {
    return reject(`message is bound to cluster ${nameOr(ClusterName, m.clusterTag)}, not ${nameOr(ClusterName, ctx.clusterTag)}`);
  }
  if (!bytesEqual(m.serialHash, ctx.serialHash)) return reject("message names another passport");
  const sealPda = base58Encode(pdaSeal(m.uidHash, ctx.programIdBytes).address);
  if (at("seal") !== sealPda) return reject("seal account is not the PDA of the signed uid hash");
  const key = ctx.registry.serverKeys.find((k) => k.keyId === keyId);
  if (!key) return reject(`server key ${keyId} is not in the registry`);
  if (!bytesEqual(key.pubkey, payload.pubkey)) return reject(`server key ${keyId} has another public key`);
  if (!serverKeyValidAt(key, m.ts)) return reject(`server key ${keyId} was not valid at ts ${m.ts}`);
  return {
    accepted: {
      signature, slot: tx.slot, instruction: index, ts: Number(m.ts), counter: m.counter,
      purpose: nameOr(PurposeName, m.purpose), actorKind: nameOr(ActorKindName, m.actorKind), tier: m.tier, seal: sealPda,
      keyId, msgSha256Hex: sha256Hex(payload.message), msg: payload.message,
    },
  };
}

async function readAccount(rpc: PassRpc, address: string, programId: string, what: string): Promise<Uint8Array | null> {
  const acc = await rpc.getAccountInfo(address);
  if (!acc) return null;
  if (acc.owner !== programId) throw new VerifyPassError(`${what} ${address} is not owned by program ${programId}`);
  return acc.data;
}
function decodeOrFail<T>(decode: (d: Uint8Array) => T, data: Uint8Array, what: string): T {
  try { return decode(data); } catch (e) { throw new VerifyPassError(`${what}: ${(e as Error).message}`); }
}
async function readHolding(rpc: PassRpc, ctx: { holding: string; programId: string }): Promise<HoldingAccount> {
  const data = await readAccount(rpc, ctx.holding, ctx.programId, "Holding");
  if (!data) {
    throw new VerifyPassError(`no Holding ${ctx.holding} for this pass (a v1 pass whose Holding was not initialised, or another cluster)`);
  }
  return decodeOrFail(decodeHolding, data, "Holding");
}

/** Signatures of successful transactions that wrote `address`, oldest first. */
async function listSignatures(rpc: PassRpc, address: string, pageLimit: number): Promise<RpcSignatureInfo[]> {
  const all: RpcSignatureInfo[] = [];
  for (let before: string | undefined; ;) {
    const page = await rpc.getSignaturesForAddress(address, before ? { before, limit: pageLimit } : { limit: pageLimit });
    all.push(...page);
    if (page.length < pageLimit) break;
    before = page[page.length - 1].signature;
  }
  // The RPC lists newest first; reversed, a stable sort by slot keeps the in-slot order oldest first.
  return all.filter((s) => s.err === null || s.err === undefined).reverse().sort((a, b) => a.slot - b.slot);
}

export async function verifyPass(rpc: PassRpc, opts: VerifyPassOptions): Promise<VerifyPassResult> {
  let programIdBytes: Uint8Array;
  try { programIdBytes = base58Decode(opts.programId); } catch { programIdBytes = new Uint8Array(); }
  if (programIdBytes.length !== 32) throw new VerifyPassError(`not a program id: ${opts.programId}`);
  if (!ClusterName[opts.clusterTag]) throw new VerifyPassError(`unknown cluster tag ${opts.clusterTag}`);
  const sh = serialHash(opts.serial);
  const passport = base58Encode(pdaPassport(sh, programIdBytes).address);
  const holding = base58Encode(pdaHolding(passport, programIdBytes).address);
  const registryAddr = base58Encode(pdaRegistry(programIdBytes).address);
  const programId = base58Encode(programIdBytes);

  const passportData = await readAccount(rpc, passport, programId, "Passport");
  if (!passportData) throw new VerifyPassError(`no passport for serial ${opts.serial} (${passport}) on this cluster`);
  const pass = decodeOrFail(decodePassport, passportData, "Passport");
  const registryData = await readAccount(rpc, registryAddr, programId, "Registry");
  if (!registryData) throw new VerifyPassError(`no registry ${registryAddr} on this cluster`);
  const registry = decodeOrFail(decodeRegistry, registryData, "Registry");
  const ctx: Context = { programId, programIdBytes, clusterTag: opts.clusterTag, passport, holding, serialHash: sh, registry };

  const txCache = new Map<string, RpcTransaction>();
  const attempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const h = await readHolding(rpc, ctx);
    if (base58Encode(h.passport) !== passport) throw new VerifyPassError(`Holding ${holding} names another passport`);
    const sigs = await listSignatures(rpc, holding, opts.pageLimit ?? 1000);
    const scans: (PassScan & { msg: Uint8Array })[] = [];
    const rejected: RejectedScan[] = [];
    for (const s of sigs) {
      let tx = txCache.get(s.signature);
      if (!tx) {
        const got = await rpc.getTransaction(s.signature);
        if (!got) throw new VerifyPassError(`transaction ${s.signature} is not available from this RPC (pruned history?)`);
        tx = got;
        txCache.set(s.signature, tx);
      }
      if (tx.meta?.err !== null && tx.meta?.err !== undefined) continue;
      const keys = keysOf(tx);
      // top-level instructions only: record_scan_v2 refuses CPI (D8), an inner one never folded
      for (let i = 0; i < tx.transaction.message.instructions.length; i++) {
        const r = inspectInstruction(tx, i, keys, ctx);
        if (r && "accepted" in r) scans.push(r.accepted);
        else if (r) rejected.push(r.rejected);
      }
    }
    const after = await readHolding(rpc, ctx);
    if (after.headCount !== h.headCount || !bytesEqual(after.scanHead, h.scanHead)) continue; // a scan landed meanwhile

    const head = scans.reduce((acc, s) => foldScanHead(acc, s.msg), SCAN_HEAD_ZERO);
    const complete = scans.length === h.headCount && bytesEqual(head, h.scanHead);
    return {
      serial: opts.serial, programId, cluster: ClusterName[opts.clusterTag], passport, holding,
      heldInAccount: base58Encode(pass.asset) === holding, passportScanCount: pass.scanCount,
      holdingHeadCount: h.headCount, holdingHeadHex: bytesToHex(h.scanHead), found: scans.length,
      computedHeadHex: bytesToHex(head), complete,
      verdict: complete ? VERDICT_COMPLETE : verdictIncomplete(scans.length, h.headCount),
      transactions: sigs.length, scans: scans.map(({ msg: _msg, ...s }) => s), rejected,
    };
  }
  throw new VerifyPassError(`the Holding changed during ${attempts} reads; run again`);
}

/** Human-readable report (the CLI's default output). */
export function formatVerifyPass(r: VerifyPassResult): string {
  const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
  const lines = [
    `FlaconVault verify-pass · ${r.cluster} · program ${r.programId}`,
    `Pass ${r.serial}`,
    `  passport ${r.passport}${r.heldInAccount ? " (held in a FlaconVault account)" : ""}`,
    `  holding  ${r.holding} · the chain counts ${r.holdingHeadCount} v2 scan(s), read ${r.transactions} transaction(s)`,
  ];
  r.scans.forEach((s, n) => {
    lines.push(`  ${String(n + 1).padStart(3)}  ${iso(s.ts)}  counter ${String(s.counter).padEnd(8)} ${s.purpose.padEnd(8)}`
      + ` ${s.actorKind.padEnd(9)} tier ${s.tier}  ${s.signature}`);
  });
  if (r.rejected.length) {
    lines.push(`Not counted (${r.rejected.length}):`);
    for (const x of r.rejected) lines.push(`  ${x.signature} #${x.instruction}: ${x.reason}`);
  }
  const v1 = r.passportScanCount - r.holdingHeadCount;
  if (v1 > 0) lines.push(`v1 scans (ScanProof accounts) are not covered: ${v1} of the passport's ${r.passportScanCount}.`);
  lines.push(`Verdict: ${r.verdict}`);
  return lines.join("\n");
}
