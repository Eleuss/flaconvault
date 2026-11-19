/**
 * Read-only decoders for the flacon accounts that `verify-pass` reads (Borsh, packed, after the 8-byte Anchor
 * discriminator sha256("account:<Name>")[0..8]). Layouts: programs/flacon/src/state.rs; HolderConfig and Holding
 * from docs/public-record.md §6. Registry, Passport and Seal are frozen.
 */
import { bytesEqual, sha256Bytes, utf8 } from "./bytes.ts";
import { MAX_SCAN_TS_SKEW_S } from "./enums.ts";

/** First 8 bytes of sha256(`<namespace>:<name>`): Anchor's account, instruction and event discriminators. */
export function anchorDiscriminator(namespace: "account" | "global" | "event", name: string): Uint8Array {
  return sha256Bytes(utf8(`${namespace}:${name}`)).slice(0, 8);
}
export const RECORD_SCAN_V2_DISCRIMINATOR = anchorDiscriminator("global", "record_scan_v2");

/** Account sizes including the discriminator. */
export const ACCOUNT_SIZE = { Passport: 8 + 144, Seal: 8 + 79, HolderConfig: 8 + 219, Holding: 8 + 221 } as const;

class Reader {
  private o = 8;
  private readonly data: Uint8Array;
  private readonly dv: DataView;
  constructor(data: Uint8Array, name: string, minLen: number) {
    if (data.length < minLen) throw new Error(`${name}: account data is ${data.length} bytes, expected ≥ ${minLen}`);
    if (!bytesEqual(data.slice(0, 8), anchorDiscriminator("account", name))) throw new Error(`${name}: wrong discriminator`);
    this.data = data;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private take(n: number): number {
    if (this.o + n > this.data.length) throw new Error("account data too short");
    const at = this.o; this.o += n; return at;
  }
  bytes(n: number): Uint8Array { const at = this.take(n); return this.data.slice(at, at + n); }
  u8(): number { return this.dv.getUint8(this.take(1)); }
  bool(): boolean { return this.u8() !== 0; }
  u16(): number { return this.dv.getUint16(this.take(2), true); }
  u32(): number { return this.dv.getUint32(this.take(4), true); }
  i64(): bigint { return this.dv.getBigInt64(this.take(8), true); }
}

export interface PassportAccount {
  serialHash: Uint8Array; bindingHash: Uint8Array; asset: Uint8Array; issuer: Uint8Array;
  grade: number; scanCount: number; sealCount: number; void: boolean; createdAt: bigint; bump: number;
}
export function decodePassport(data: Uint8Array): PassportAccount {
  const r = new Reader(data, "Passport", ACCOUNT_SIZE.Passport);
  return {
    serialHash: r.bytes(32), bindingHash: r.bytes(32), asset: r.bytes(32), issuer: r.bytes(32), grade: r.u8(),
    scanCount: r.u32(), sealCount: r.u8(), void: r.bool(), createdAt: r.i64(), bump: r.u8(),
  };
}

export interface SealAccount {
  passport: Uint8Array; kind: number; uidHash: Uint8Array; lastCounter: number; dead: boolean; attachedAt: bigint; bump: number;
}
export function decodeSeal(data: Uint8Array): SealAccount {
  const r = new Reader(data, "Seal", ACCOUNT_SIZE.Seal);
  return {
    passport: r.bytes(32), kind: r.u8(), uidHash: r.bytes(32), lastCounter: r.u32(), dead: r.bool(), attachedAt: r.i64(),
    bump: r.u8(),
  };
}

export interface ServerKeyEntry { keyId: number; pubkey: Uint8Array; validFrom: bigint; validTo: bigint }
export interface RegistryAccount {
  authority: Uint8Array; serverKeys: ServerKeyEntry[]; partners: Uint8Array[];
  sites: { siteId: number; label: Uint8Array }[]; bump: number;
}
export function decodeRegistry(data: Uint8Array): RegistryAccount {
  const r = new Reader(data, "Registry", 8 + 32 + 4 + 4 + 4 + 1);
  const vec = <T>(item: () => T): T[] => {
    const n = r.u32();
    if (n > 64) throw new Error(`Registry: vector length ${n} is implausible`);
    return Array.from({ length: n }, item);
  };
  const authority = r.bytes(32);
  const serverKeys = vec(() => ({ keyId: r.u8(), pubkey: r.bytes(32), validFrom: r.i64(), validTo: r.i64() }));
  const partners = vec(() => r.bytes(32));
  const sites = vec(() => ({ siteId: r.u16(), label: r.bytes(32) }));
  return { authority, serverKeys, partners, sites, bump: r.u8() };
}
/** `valid_from ≤ t` and (`valid_to == 0` or `t ≤ valid_to`), as `ServerKey::is_valid_at`. */
export function serverKeyValidAt(k: ServerKeyEntry, t: bigint): boolean {
  return t >= k.validFrom && (k.validTo === 0n || t <= k.validTo);
}
/**
 * Could `record_scan_v2` have accepted a message signed at `ts` under this key, judged from the registry entry as it
 * is today? `valid_from ≤ ts` and (`valid_to == 0` or `ts ≤ valid_to + MAX_SCAN_TS_SKEW_S + 1`). The program checked
 * the key at `ts` and at its clock C (|ts − C| ≤ MAX_SCAN_TS_SKEW_S) against the registry of that moment. `valid_from`
 * never changes and `valid_to` only drops: `revoke_server_key` at clock R ≥ C sets it to R − 1, so every accepted scan
 * has ts ≤ C + 600 ≤ valid_to + 601. A plain `serverKeyValidAt(ts)` would drop a scan dated ahead of the cluster clock
 * once its key is revoked right after it, although the chain folded that scan into the Holding for good.
 */
export function serverKeyCouldAcceptAt(k: ServerKeyEntry, ts: bigint): boolean {
  return ts >= k.validFrom && (k.validTo === 0n || ts <= k.validTo + BigInt(MAX_SCAN_TS_SKEW_S) + 1n);
}

export interface HolderConfigAccount {
  authority: Uint8Array; guardian: Uint8Array; holderKey: Uint8Array; registrarKey: Uint8Array; clusterTag: number;
  claimDelayS: bigint; notapDelayS: bigint; paused: boolean; lastHeartbeat: bigint; bump: number;
}
export function decodeHolderConfig(data: Uint8Array): HolderConfigAccount {
  const r = new Reader(data, "HolderConfig", ACCOUNT_SIZE.HolderConfig);
  return {
    authority: r.bytes(32), guardian: r.bytes(32), holderKey: r.bytes(32), registrarKey: r.bytes(32), clusterTag: r.u8(),
    claimDelayS: r.i64(), notapDelayS: r.i64(), paused: r.bool(), lastHeartbeat: r.i64(), bump: r.u8(),
  };
}

export interface HoldingAccount {
  passport: Uint8Array; state: number; epoch: number; commitment: Uint8Array; scanHead: Uint8Array; headCount: number;
  lastActorKind: number; lastActor: Uint8Array; lastPurpose: number; lastScanTs: bigint; pendingKind: number;
  pendingTarget: Uint8Array; unlockAt: bigint; bump: number;
}
export function decodeHolding(data: Uint8Array): HoldingAccount {
  const r = new Reader(data, "Holding", ACCOUNT_SIZE.Holding);
  return {
    passport: r.bytes(32), state: r.u8(), epoch: r.u32(), commitment: r.bytes(32), scanHead: r.bytes(32),
    headCount: r.u32(), lastActorKind: r.u8(), lastActor: r.bytes(32), lastPurpose: r.u8(), lastScanTs: r.i64(),
    pendingKind: r.u8(), pendingTarget: r.bytes(32), unlockAt: r.i64(), bump: r.u8(),
  };
}
