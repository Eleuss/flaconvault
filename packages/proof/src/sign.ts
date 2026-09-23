import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { hexToBytes } from "./bytes.ts";

// @noble/ed25519 v2 needs a sync sha512 for the sync API.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export function ed25519PublicKey(seed: Uint8Array | string): Uint8Array {
  const s = typeof seed === "string" ? hexToBytes(seed) : seed;
  if (s.length !== 32) throw new Error("seed must be 32 bytes");
  return ed.getPublicKey(s);
}
export function ed25519Sign(msg: Uint8Array, seed: Uint8Array | string): Uint8Array {
  const s = typeof seed === "string" ? hexToBytes(seed) : seed;
  return ed.sign(msg, s);
}
export function ed25519Verify(sig: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean {
  try { return ed.verify(sig, msg, pubkey); } catch { return false; }
}
