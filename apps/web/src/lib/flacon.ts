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

/** Metaplex Core: mint_passport only accepts an asset account owned by this program (an AssetV1). */
export const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/** Most seals a passport can carry (MAX_SEALS_PER_PASSPORT: one BOX, one NECK). */
export const MAX_SEALS_PER_PASSPORT = 2;
/** The program accepts a server signature only while |msg.ts − cluster clock| ≤ this (MAX_SCAN_TS_SKEW_S). */
export const MAX_SCAN_TS_SKEW_S = 600;

/** On-chain passport fields the clients need (raw read, no wallet). Layout: programs/flacon/src/state.rs. */
export interface PassportChain { pubkey: PublicKey; asset: PublicKey; issuer: PublicKey; grade: number; scanCount: number; sealCount: number; void: boolean }
export async function fetchPassportChain(connection: Connection, passport: PublicKey): Promise<PassportChain | null> {
  const info = await connection.getAccountInfo(passport);
  if (!info || !info.owner.equals(programId()) || info.data.length < 143) return null;
  const d = info.data;
  // 8 disc · serial_hash 32 · binding_hash 32 · asset @72 · issuer @104 · grade @136 · scan_count @137 · seal_count @141 · void @142
  return {
    pubkey: passport, asset: new PublicKey(d.subarray(72, 104)), issuer: new PublicKey(d.subarray(104, 136)),
    grade: d[136], scanCount: d.readUInt32LE(137), sealCount: d[141], void: d[142] === 1,
  };
}

/** Seal PDAs with their on-chain `dead` flag (8 disc · passport 32 · kind 1 · uid_hash 32 · last_counter 4 · dead @77). */
export async function fetchSealStates(connection: Connection, uidHashesHex: string[]): Promise<{ uidHash: string; pda: PublicKey; exists: boolean; dead: boolean; passport: PublicKey | null }[]> {
  const pdas = uidHashesHex.map((h) => sealPda(hexToBytes(h)));
  const infos = pdas.length ? await connection.getMultipleAccountsInfo(pdas) : [];
  return uidHashesHex.map((uidHash, i) => {
    const d = infos[i]?.data;
    const ok = !!d && d.length >= 78 && !!infos[i]?.owner.equals(programId());
    return { uidHash, pda: pdas[i], exists: ok, dead: ok && d![77] === 1, passport: ok ? new PublicKey(d!.subarray(8, 40)) : null };
  });
}

/** Metaplex Core AssetV1 (key 1 · owner 32 · update authority enum, 2 = collection); null when the account is none. */
export interface CoreAssetInfo { owner: PublicKey; inCollection: boolean }
export async function fetchCoreAsset(connection: Connection, asset: PublicKey): Promise<CoreAssetInfo | null> {
  const info = await connection.getAccountInfo(asset);
  if (!info || !info.owner.equals(MPL_CORE_PROGRAM_ID) || info.data.length < 34 || info.data[0] !== 1) return null;
  return { owner: new PublicKey(info.data.subarray(1, 33)), inCollection: info.data[33] === 2 };
}

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
