import { sha256 } from "@noble/hashes/sha2";

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function bytesToHex(b: Uint8Array, prefix = false): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return prefix ? `0x${s}` : s;
}
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
export function u8(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`u8 out of range: ${n}`);
  return new Uint8Array([n]);
}
export function u16le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`u16 out of range: ${n}`);
  const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b;
}
export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b;
}
export function i64le(n: number | bigint): Uint8Array {
  const v = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return b;
}
export function sha256Bytes(data: Uint8Array): Uint8Array { return sha256(data); }
export function sha256Hex(data: Uint8Array): string { return bytesToHex(sha256(data)); }
export const ZERO32 = new Uint8Array(32);
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
