/**
 * Holding hashes (docs/public-record.md §4.1, §4.2): the holder commitment and the scan-head fold that lets anyone
 * check that a list of FVSCAN2 messages is the complete, ordered history of a Holding.
 */
import { COMMITMENT_PREFIX, MSG2_LEN, SCAN_HEAD_PREFIX } from "./enums.ts";
import { concatBytes, sha256Bytes, u32le, utf8 } from "./bytes.ts";

/** scan_head_0, set by init_holding_v1 / mint_passport_v2. */
export const SCAN_HEAD_ZERO: Uint8Array = new Uint8Array(32);

/**
 * commitment = sha256("FVHOLD1" ‖ passport (32 raw bytes of the Passport PDA) ‖ epoch u32 LE ‖ secret32), 75 input
 * bytes. A commitment of 32 zero bytes is never valid (`InvalidCommitment`).
 */
export function commitment(passport: Uint8Array, epoch: number, secret: Uint8Array): Uint8Array {
  if (passport.length !== 32) throw new Error("passport must be 32 bytes");
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return sha256Bytes(concatBytes(utf8(COMMITMENT_PREFIX), passport, u32le(epoch), secret));
}

/** scan_head_n = sha256("FVHEAD1" ‖ scan_head_(n−1) ‖ sha256(msg_n)), 71 input bytes; msg_n is a full FVSCAN2. */
export function foldScanHead(head: Uint8Array, msg: Uint8Array): Uint8Array {
  if (head.length !== 32) throw new Error("scan head must be 32 bytes");
  if (msg.length !== MSG2_LEN) throw new Error(`message length ${msg.length} != ${MSG2_LEN}`);
  return sha256Bytes(concatBytes(utf8(SCAN_HEAD_PREFIX), head, sha256Bytes(msg)));
}

/** Folds the messages in execution order, starting at `start` (default SCAN_HEAD_ZERO). */
export function foldScanHeads(msgs: readonly Uint8Array[], start: Uint8Array = SCAN_HEAD_ZERO): Uint8Array {
  return msgs.reduce((h, m) => foldScanHead(h, m), start);
}
