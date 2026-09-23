import { MSG_LEN, MSG_PREFIX } from "./enums.ts";
import { bytesToHex, concatBytes, hexToBytes, i64le, sha256Bytes, u32le, u8, utf8, ZERO32 } from "./bytes.ts";

/** sha256 of the serial string (UTF-8). */
export function serialHash(serial: string): Uint8Array { return sha256Bytes(utf8(serial)); }
/** sha256 of the 7 raw UID bytes (not the hex string). */
export function uidHash(uid: Uint8Array | string): Uint8Array {
  const b = typeof uid === "string" ? hexToBytes(uid) : uid;
  if (b.length !== 7) throw new Error(`uid must be 7 bytes, got ${b.length}`);
  return sha256Bytes(b);
}
/** binding_hash = sha256(serial ‖ batch_code ‖ uid_hash_first_seal), all UTF-8 except the 32 hash bytes. */
export function bindingHash(serial: string, batchCode: string, firstSealUidHash: Uint8Array): Uint8Array {
  return sha256Bytes(concatBytes(utf8(serial), utf8(batchCode), firstSealUidHash));
}

export interface ScanMessageFields {
  serialHash: Uint8Array; // 32
  uidHash: Uint8Array;    // 32
  counter: number;        // u32
  tamper: number; uv: number; hum: number; heat: number; // u8 each
  fill: number;           // u8 0..100
  mediaHash: Uint8Array;  // 32, ZERO32 when tier < 2
  nonce: Uint8Array;      // 32
  ts: number | bigint;    // i64 unix seconds
}

/**
 * Briefing §4.3 — exactly these bytes. Server signs, program reconstructs.
 * "FVSCAN1" ‖ serial_hash ‖ uid_hash ‖ counter u32le ‖ tamper ‖ uv ‖ hum ‖ heat ‖ fill ‖ media_hash ‖ nonce ‖ ts i64le
 */
export function buildScanMessage(f: ScanMessageFields): Uint8Array {
  if (f.serialHash.length !== 32 || f.uidHash.length !== 32 || f.mediaHash.length !== 32 || f.nonce.length !== 32)
    throw new Error("hashes and nonce must be 32 bytes");
  if (f.fill < 0 || f.fill > 100) throw new Error("fill must be 0..100");
  const msg = concatBytes(
    utf8(MSG_PREFIX), f.serialHash, f.uidHash, u32le(f.counter),
    u8(f.tamper), u8(f.uv), u8(f.hum), u8(f.heat), u8(f.fill),
    f.mediaHash, f.nonce, i64le(f.ts),
  );
  if (msg.length !== MSG_LEN) throw new Error(`message length ${msg.length} != ${MSG_LEN}`);
  return msg;
}

export interface ParsedScanMessage extends ScanMessageFields { ts: bigint }
export function parseScanMessage(msg: Uint8Array): ParsedScanMessage {
  if (msg.length !== MSG_LEN) throw new Error(`message length ${msg.length} != ${MSG_LEN}`);
  const prefix = new TextDecoder().decode(msg.slice(0, 7));
  if (prefix !== MSG_PREFIX) throw new Error(`bad prefix ${prefix}`);
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  let o = 7;
  const serialHash = msg.slice(o, o + 32); o += 32;
  const uidHash = msg.slice(o, o + 32); o += 32;
  const counter = dv.getUint32(o, true); o += 4;
  const tamper = msg[o++], uv = msg[o++], hum = msg[o++], heat = msg[o++], fill = msg[o++];
  const mediaHash = msg.slice(o, o + 32); o += 32;
  const nonce = msg.slice(o, o + 32); o += 32;
  const ts = dv.getBigInt64(o, true);
  return { serialHash, uidHash, counter, tamper, uv, hum, heat, fill, mediaHash, nonce, ts };
}

export const scanMessageHex = (f: ScanMessageFields) => bytesToHex(buildScanMessage(f));
export { ZERO32 };
