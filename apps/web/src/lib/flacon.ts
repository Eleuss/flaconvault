import { AnchorProvider, BN, Program, type Idl } from "@anchor-lang/core";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { PDA_SEEDS, hexToBytes, parseScanMessage, heatLevelsToMask } from "@flaconvault/proof";
import idlJson from "@flaconvault/proof/idl/flacon.json";
import { PROGRAM_ID } from "./config";

const enc = (s: string) => new TextEncoder().encode(s);
export const programId = () => new PublicKey(PROGRAM_ID);
export const registryPda = () => PublicKey.findProgramAddressSync([enc(PDA_SEEDS.registry)], programId())[0];
export const passportPda = (serialHash: Uint8Array) => PublicKey.findProgramAddressSync([enc(PDA_SEEDS.passport), serialHash], programId())[0];
export const sealPda = (uidHash: Uint8Array) => PublicKey.findProgramAddressSync([enc(PDA_SEEDS.seal), uidHash], programId())[0];
export const scanPda = (seal: PublicKey, counter: number) => {
  const c = new Uint8Array(4); new DataView(c.buffer).setUint32(0, counter, true);
  return PublicKey.findProgramAddressSync([enc(PDA_SEEDS.scan), seal.toBytes(), c], programId())[0];
};

export function flaconProgram(connection: Connection, wallet: AnchorWallet): Program {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program(idlJson as Idl, provider);
}

export interface VerifyResponse {
  verdict: string; counter: number; serial: string | null; serialHash: string; uidHash: string; heatMask?: number;
  grade: number; reviewRecommended: boolean; serverSig: string | null; serverPubkey: string; keyId: number; ts: number;
  msgHex: string; bundle: { heatLevels: number[]; [k: string]: unknown } | null; bundleHash: string; eventId: number | null;
  sealKind: number | null; sealDead: boolean; message: string;
}

/**
 * Briefing §8 step 8: [Ed25519 verify ix, flacon.record_scan]. Every signed field is taken from the server's
 * msgHex (parsed with the shared layout), so the program's reconstruction matches byte for byte.
 */
export async function buildRecordScanTx(program: Program, attester: PublicKey, v: VerifyResponse, extra: { tier: number; role: number; siteId?: number }): Promise<{ tx: Transaction; scanProof: PublicKey }> {
  if (!v.serverSig) throw new Error("no server signature (verdict " + v.verdict + ")");
  const msg = hexToBytes(v.msgHex);
  const m = parseScanMessage(msg);
  const seal = sealPda(m.uidHash);
  const passport = passportPda(m.serialHash);
  const scanProof = scanPda(seal, m.counter);
  const heatLevels = v.bundle?.heatLevels ?? [0, 0, 0, 0, 0, 0];
  const args = {
    counter: m.counter, tier: extra.tier, role: extra.role, tamper: m.tamper, uv: m.uv, hum: m.hum, heat: m.heat,
    heatLevels: heatLevelsToMask(heatLevels), fill: m.fill, siteId: extra.siteId ?? 0,
    mediaHash: Array.from(m.mediaHash), bundleHash: Array.from(hexToBytes(v.bundleHash)), nonce: Array.from(m.nonce),
    ts: new BN(m.ts.toString()), serverKeyId: v.keyId,
  };
  const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: hexToBytes(v.serverPubkey), message: msg, signature: hexToBytes(v.serverSig) });
  const ix: TransactionInstruction = await program.methods.recordScan(args).accountsStrict({
    registry: registryPda(), passport, seal, scanProof, attester, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId,
  }).instruction();
  const tx = new Transaction().add(edIx, ix);
  tx.feePayer = attester;
  return { tx, scanProof };
}
