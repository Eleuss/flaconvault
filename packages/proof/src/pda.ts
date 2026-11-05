/**
 * Program derived addresses without @solana/web3.js: sha256(seeds ‖ bump ‖ program_id ‖ "ProgramDerivedAddress"),
 * bump from 255 down to the first result that is not an Ed25519 curve point (Solana `find_program_address`).
 */
import * as ed from "@noble/ed25519";
import { PDA_SEEDS } from "./enums.ts";
import { concatBytes, sha256Bytes, utf8 } from "./bytes.ts";
import { pubkeyBytes } from "./b58.ts";

export type PubkeyLike = Uint8Array | string;
export interface Pda { address: Uint8Array; bump: number }

const PDA_MARKER = utf8("ProgramDerivedAddress");
const MAX_SEED_LEN = 32;
const MAX_SEEDS = 16;

/**
 * `true` when the 32 bytes decode to a point on the Ed25519 curve. Like curve25519-dalek's `decompress` (what
 * Solana uses), a non-canonical y and x = 0 with the sign bit set still count as points, hence zip215 decoding.
 */
export function isOnCurve(key: Uint8Array): boolean {
  try {
    ed.ExtendedPoint.fromHex(key, true);
    return true;
  } catch {
    return false;
  }
}

/** Solana `create_program_address`: throws when the result is on the curve (no PDA for these seeds). */
export function createProgramAddress(seeds: Uint8Array[], programId: PubkeyLike): Uint8Array {
  if (seeds.length > MAX_SEEDS) throw new Error(`at most ${MAX_SEEDS} seeds`);
  for (const s of seeds) if (s.length > MAX_SEED_LEN) throw new Error(`seed longer than ${MAX_SEED_LEN} bytes`);
  const address = sha256Bytes(concatBytes(...seeds, pubkeyBytes(programId), PDA_MARKER));
  if (isOnCurve(address)) throw new Error("address is on the curve");
  return address;
}

/** Solana `find_program_address`: the highest bump whose address is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: PubkeyLike): Pda {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return { address: createProgramAddress([...seeds, new Uint8Array([bump])], programId), bump };
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "address is on the curve") throw e;
    }
  }
  throw new Error("no viable bump");
}

// Seeds of the flacon program (programs/flacon/src/constants.rs, vectors.constants.PDA_SEEDS).
export const pdaRegistry = (programId: PubkeyLike) => findProgramAddress([utf8(PDA_SEEDS.registry)], programId);
export const pdaPassport = (serialHash: Uint8Array, programId: PubkeyLike) =>
  findProgramAddress([utf8(PDA_SEEDS.passport), serialHash], programId);
export const pdaSeal = (uidHash: Uint8Array, programId: PubkeyLike) =>
  findProgramAddress([utf8(PDA_SEEDS.seal), uidHash], programId);
export const pdaHolderConfig = (programId: PubkeyLike) => findProgramAddress([utf8(PDA_SEEDS.holder_config)], programId);
export const pdaHolding = (passport: PubkeyLike, programId: PubkeyLike) =>
  findProgramAddress([utf8(PDA_SEEDS.holding), pubkeyBytes(passport)], programId);
/** Anchor's `#[event_cpi]` signer PDA (seed `__event_authority`, Anchor's own, not one of PDA_SEEDS). */
export const pdaEventAuthority = (programId: PubkeyLike) => findProgramAddress([utf8("__event_authority")], programId);
