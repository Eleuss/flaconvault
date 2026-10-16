/**
 * Shared plumbing for the ops scripts: wallet/provider/IDL loading, the ProgramData PDA, verifier event posting
 * with the 503-retry the verifier expects, and a creating-signature lookup that checks the instruction, the account's
 * position in it and the signer (so a stray transfer to a PDA, or another instruction that merely lists it, is never
 * mistaken for its creation). Pure argument checks live here too so tests/scripts-cli.ts can exercise them without a
 * validator.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ROOT = path.resolve(__dirname, "../..");
export const DEVNET = "https://api.devnet.solana.com";
export const DEFAULT_VERIFY_URL = "https://verify.flaconvault.com";
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
export const UID_RE = /^[0-9A-Fa-f]{14}$/;
export const HEX32_RE = /^[0-9a-fA-F]{64}$/;

export const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
export const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);

export function loadWallet(): Keypair {
  const walletPath = expandHome(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
}
export function rpcUrl(fallback = DEVNET): string {
  return process.env.ANCHOR_PROVIDER_URL ?? fallback;
}
export function providerFor(keypair: Keypair, url = rpcUrl()): anchor.AnchorProvider {
  const provider = new anchor.AnchorProvider(new Connection(url, "confirmed"), new anchor.Wallet(keypair), { commitment: "confirmed" });
  anchor.setProvider(provider);
  return provider;
}
/** target/idl (fresh build) first, then the committed copy in packages/proof. */
export function loadIdl(name: "flacon" | "escrow"): any {
  for (const rel of [`target/idl/${name}.json`, `packages/proof/src/idl/${name}.json`]) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error(`${name} IDL not found — run \`anchor build\` first`);
}
export const programFor = (name: "flacon" | "escrow", provider: anchor.AnchorProvider) => new Program(loadIdl(name), provider);
export const programDataOf = (programId: PublicKey) => PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
export const verifyUrl = (arg?: string) => (arg ?? process.env.FV_VERIFY_URL ?? DEFAULT_VERIFY_URL).replace(/\/$/, "");

/** POST /api/events; retries while the verifier's RPC has not seen the transaction (503 tx_not_visible). */
export async function postEvent(verify: string, body: Record<string, unknown>, retries = 5): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${verify}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const text = await r.text();
    if (r.status === 503 && attempt < retries) { await new Promise((res) => setTimeout(res, 2500)); continue; }
    throw new Error(`/api/events ${r.status} ${text.slice(0, 300)}`);
  }
}

/** What the transaction that created an account looks like: which instruction, the account's position in it, who signed. */
export interface CreatingExpectation {
  programId: PublicKey;
  /** Anchor instruction discriminator (first 8 bytes of the instruction data). */
  discriminator: number[];
  /** Position of the created account in the instruction's accounts (from the IDL). */
  accountIndex: number;
  /** The wallet that must have signed the transaction. */
  signer?: PublicKey;
}

/** The expectation for `instruction` creating its account `accountName`, read from an Anchor IDL. */
export function expectationFromIdl(idl: any, programId: PublicKey, instruction: string, accountName: string, signer?: PublicKey): CreatingExpectation {
  const ix = (idl.instructions ?? []).find((i: any) => i.name === instruction);
  if (!ix) throw new Error(`instruction ${instruction} not in the IDL`);
  const accountIndex = ix.accounts.findIndex((a: any) => a.name === accountName);
  if (accountIndex < 0) throw new Error(`account ${accountName} not in ${instruction}`);
  return { programId, discriminator: Array.from(ix.discriminator as number[]), accountIndex, signer };
}

/**
 * True when `tx` succeeded, was signed by the expected wallet and carries the expected instruction (program,
 * discriminator) with `account` at the expected position. Anything else that merely lists the address (a stray
 * transfer, another instruction carrying the PDA as an extra account) does not count.
 */
export function txCreatesAccount(tx: Pick<VersionedTransactionResponse, "meta" | "transaction"> | null, account: PublicKey, e: CreatingExpectation): boolean {
  if (!tx || !tx.meta || tx.meta.err) return false;
  const msg = tx.transaction.message;
  const keys = msg.version === 0 ? msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }) : msg.getAccountKeys();
  if (e.signer) {
    let signed = false;
    for (let i = 0; i < msg.header.numRequiredSignatures; i++) if (keys.get(i)?.equals(e.signer)) signed = true;
    if (!signed) return false;
  }
  return msg.compiledInstructions.some((ix) =>
    !!keys.get(ix.programIdIndex)?.equals(e.programId)
    && ix.data.length >= e.discriminator.length && e.discriminator.every((b, i) => ix.data[i] === b)
    && !!keys.get(ix.accountKeyIndexes[e.accountIndex])?.equals(account));
}

/**
 * Signature of the transaction that created `account`: the oldest successful signature touching it whose transaction
 * matches `expect` (see txCreatesAccount). Returns null when none is found within `max` signatures (never a random
 * later signature).
 */
export async function creatingSignature(connection: Connection, account: PublicKey, expect: CreatingExpectation, max = 1000): Promise<string | null> {
  const ok: string[] = [];
  let before: string | undefined;
  let seen = 0;
  let complete = false;
  while (!complete) {
    const limit = Math.min(1000, max - seen);
    if (limit <= 0) return null; // window exhausted: the creation may be older than what we saw
    const page = await connection.getSignaturesForAddress(account, { limit, before }, "confirmed");
    seen += page.length;
    for (const s of page) if (!s.err) ok.push(s.signature);
    complete = page.length < limit; // reached the account's first signature
    if (page.length) before = page[page.length - 1].signature;
  }
  for (const sig of ok.reverse()) {
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (txCreatesAccount(tx, account, expect)) return sig;
  }
  return null;
}

/** Offset of `Passport.asset` in the account data (discriminator 8 · serial_hash 32 · binding_hash 32). */
export const PASSPORT_ASSET_OFFSET = 8 + 32 + 32;

/** Passports (flacon program accounts with the Passport discriminator) whose `asset` is `asset`. */
export async function passportsUsingAsset(connection: Connection, programId: PublicKey, idl: any, asset: PublicKey): Promise<PublicKey[]> {
  const disc = (idl.accounts ?? []).find((a: any) => a.name === "Passport")?.discriminator as number[] | undefined;
  if (!disc) throw new Error("Passport account not in the flacon IDL");
  const found = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 0, bytes: bs58encode(Uint8Array.from(disc)) } },
      { memcmp: { offset: PASSPORT_ASSET_OFFSET, bytes: asset.toBase58() } },
    ],
  });
  return found.map((f) => f.pubkey);
}

/**
 * Why bind-chip must not bind an existing Core asset to a new passport, or null when it may: mint_passport only takes
 * an AssetV1 owned by the issuer, and an asset that already backs a passport would let two passports share one asset
 * (the escrow lets the asset's owner sell the bottle).
 */
export function existingAssetProblem(o: { asset: PublicKey; core: { owner: PublicKey } | null; wallet: PublicKey; usedBy: PublicKey[] }): string | null {
  if (!o.core) return `${o.asset.toBase58()} is not a Metaplex Core asset (mint_passport would refuse it); pass "new" to mint one`;
  if (!o.core.owner.equals(o.wallet)) return `the Core asset ${o.asset.toBase58()} belongs to ${o.core.owner.toBase58()}, not this wallet; pass "new" to mint one`;
  if (o.usedBy.length) return `the Core asset ${o.asset.toBase58()} already backs passport ${o.usedBy.map((k) => k.toBase58()).join(", ")}; pass "new" to mint one`;
  return null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** base58 for memcmp filters (web3.js has no exported encoder; PublicKey only takes 32 bytes). */
export function bs58encode(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > BigInt(0)) { out = B58[Number(n % BigInt(58))] + out; n /= BigInt(58); }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

/**
 * Order of the seal steps for one seed passport: attach every seal first, then mark the dead ones. Marking a seal dead
 * voids the passport, and attach_seal refuses a void passport, so a dead seal listed first must not block the others.
 */
export function sealSeedPlan(seals: { uid: string; kind: number; dead?: boolean }[]): Array<{ op: "attach"; uid: string; kind: number } | { op: "markDead"; uid: string }> {
  return [
    ...seals.map((s) => ({ op: "attach" as const, uid: s.uid, kind: s.kind })),
    ...seals.filter((s) => s.dead).map((s) => ({ op: "markDead" as const, uid: s.uid })),
  ];
}

// ---- pure argument checks (unit-tested) -------------------------------------------------------------------------

export interface BindChipArgs { serial: string; uid: string; brand: string; name: string; batch: string; asset: "new" | PublicKey; kind: 0 | 1; verify: string }
/** bind-chip <serial> <uid14hex> <brand> <name> <batch> <coreAsset|new> [kind=1] [verifyUrl] — every argument checked before anything is sent. */
export function parseBindChipArgs(argv: string[]): BindChipArgs {
  const usage = 'usage: bind-chip <serial> <uid 14 hex> "<brand>" "<name>" "<batch>" <coreAssetPubkey|new> [kind 0=box|1=neck, default 1] [verifyUrl]';
  const [serialRaw, uid, brand, name, batch, assetArg, kindArg, verifyArg] = argv;
  const serial = (serialRaw ?? "").trim();
  if (!SERIAL_RE.test(serial)) throw new Error(`invalid serial "${serialRaw ?? ""}" (3–64 chars: letters, digits, . _ -)\n${usage}`);
  if (!UID_RE.test(uid ?? "")) throw new Error(`invalid uid "${uid ?? ""}" (7 bytes = 14 hex)\n${usage}`);
  if (!brand?.trim() || !name?.trim()) throw new Error(`brand and name are required\n${usage}`);
  if (batch === undefined) throw new Error(`batch is required (use "" for none)\n${usage}`);
  if (!assetArg) throw new Error(`Core asset is required (an existing Metaplex Core asset pubkey, or "new" to mint one)\n${usage}`);
  let asset: "new" | PublicKey;
  if (assetArg === "new") asset = "new";
  else { try { asset = new PublicKey(assetArg); } catch { throw new Error(`invalid Core asset pubkey "${assetArg}"\n${usage}`); } }
  const kind = Number(kindArg ?? "1");
  if (kind !== 0 && kind !== 1) throw new Error(`kind must be 0 (box) or 1 (neck)\n${usage}`);
  const verify = verifyUrl(verifyArg);
  if (!/^https?:\/\//.test(verify)) throw new Error(`invalid verify URL "${verify}"`);
  return { serial, uid: uid.toUpperCase(), brand: brand.trim(), name: name.trim(), batch, asset, kind, verify };
}

/** Server key for seed-devnet: explicit only. The public vectors test key needs --test-key AND a local RPC. */
export function chooseServerKey(o: { argv: string[]; url: string; envSeedHex?: string | null; vectorsPubkeyHex: string; derive: (seedHex: string) => string }): { hex: string; source: string } {
  const arg = (n: string) => { const i = o.argv.indexOf(n); return i >= 0 ? o.argv[i + 1] : undefined; };
  const has = (n: string) => o.argv.includes(n);
  const chosen = [has("--server-pubkey"), has("--server-pubkey-from-env"), has("--test-key")].filter(Boolean).length;
  if (chosen === 0) throw new Error("choose the verifier key explicitly: --server-pubkey <hex32> | --server-pubkey-from-env | --test-key (localhost only)");
  if (chosen > 1) throw new Error("use only one of --server-pubkey, --server-pubkey-from-env, --test-key");
  if (has("--test-key")) {
    if (!isLocalUrl(o.url)) throw new Error("--test-key registers the PUBLIC docs/vectors.json key (anyone can sign with it): only allowed against a local validator");
    return { hex: o.vectorsPubkeyHex.toLowerCase(), source: "docs/vectors.json serverTestKey (TEST ONLY, local validator)" };
  }
  if (has("--server-pubkey-from-env")) {
    const seed = o.envSeedHex?.trim();
    if (!seed || !HEX32_RE.test(seed)) throw new Error("FV_SERVER_ED25519_SEED missing or not 32 bytes hex in apps/verify/.env");
    const hex = o.derive(seed).toLowerCase();
    if (hex === o.vectorsPubkeyHex.toLowerCase() && !isLocalUrl(o.url)) throw new Error("apps/verify/.env holds the public test seed; refusing to register it on a public cluster");
    return { hex, source: "apps/verify/.env (derived)" };
  }
  const cli = arg("--server-pubkey") ?? "";
  if (!HEX32_RE.test(cli)) throw new Error("--server-pubkey must be 32 bytes hex");
  if (cli.toLowerCase() === o.vectorsPubkeyHex.toLowerCase() && !isLocalUrl(o.url)) throw new Error("that is the public docs/vectors.json test key; use --test-key on a local validator instead");
  return { hex: cli.toLowerCase(), source: "--server-pubkey" };
}

/** `--key-id <0-255>` for seed-devnet (default 1). */
export function parseKeyIdFlag(argv: string[], def = 1): number {
  const i = argv.indexOf("--key-id");
  if (i < 0) return def;
  const v = argv[i + 1];
  if (!/^\d{1,3}$/.test(v ?? "") || Number(v) > 255) throw new Error(`--key-id must be 0-255, got "${v ?? ""}"`);
  return Number(v);
}

/** A registry server key as the scripts see it (pubkey as lowercase hex, times as unix seconds; valid_to 0 = open). */
export interface RegistryKey { keyId: number; pubkeyHex: string; validFrom: number; validTo: number }
export type KeyStatus = "valid" | "revoked or expired" | "not yet valid";
/** ServerKey::is_valid_at: valid_from <= now and (valid_to == 0 or now <= valid_to). revoke_server_key sets valid_to = now − 1. */
export function keyStatus(k: RegistryKey, now: number): KeyStatus {
  if (k.validTo !== 0 && now > k.validTo) return "revoked or expired";
  if (now < k.validFrom) return "not yet valid";
  return "valid";
}
export const MAX_SERVER_KEYS = 8;

export type KeyPlan = { action: "skip" | "add"; keyId: number; note: string };
/**
 * What seed-devnet does about the verifier key `chosenHex` (asked for under `wantedId`), given the registry's keys:
 * - registered and valid under any key_id → nothing to do (also after a rotation: key 1 revoked, the key added as 2);
 * - not registered and `wantedId` free → add it there;
 * - not registered and `wantedId` held by a revoked or expired key → add it under the next free key_id;
 * - not registered and `wantedId` held by another VALID key → refuse (a second open key is a rotation decision);
 * - registered but only revoked or expired → refuse (a revoked key cannot be validated again).
 */
export function planServerKey(keys: RegistryKey[], chosenHex: string, wantedId: number, now: number): KeyPlan {
  const hex = chosenHex.toLowerCase();
  const tag = (k: RegistryKey) => `key_id ${k.keyId} [${keyStatus(k, now)}]`;
  const wanted = keys.find((k) => k.keyId === wantedId);
  const mine = keys.filter((k) => k.pubkeyHex.toLowerCase() === hex);
  const usable = mine.find((k) => keyStatus(k, now) === "valid") ?? mine.find((k) => keyStatus(k, now) === "not yet valid");
  if (usable) {
    const other = usable.keyId === wantedId ? "" : wanted ? `; ${tag(wanted)} holds ${wanted.pubkeyHex}` : `; key_id ${wantedId} is unused`;
    return { action: "skip", keyId: usable.keyId, note: `this key is registered as ${tag(usable)}${other}` };
  }
  if (mine.length) {
    throw new Error(`this key is registered only as ${mine.map(tag).join(", ")}: a revoked key stays revoked. Generate a new verifier key and add it with scripts/server-key.ts add <hex> <newKeyId>`);
  }
  const used = new Set(keys.map((k) => k.keyId));
  const nextFree = () => { for (let id = wantedId; id <= 255; id++) if (!used.has(id)) return id; for (let id = 0; id < wantedId; id++) if (!used.has(id)) return id; return -1; };
  if (!wanted) {
    if (keys.length >= MAX_SERVER_KEYS) throw new Error(`the registry already holds ${MAX_SERVER_KEYS} server keys (the maximum)`);
    return { action: "add", keyId: wantedId, note: `key_id ${wantedId} is unused` };
  }
  if (keyStatus(wanted, now) === "valid") {
    const free = nextFree();
    throw new Error(
      `${tag(wanted)} holds ${wanted.pubkeyHex}, not ${hex}. To rotate to the new key:\n` +
        `  npx tsx scripts/server-key.ts add ${hex} ${free < 0 ? "<newKeyId>" : free}\n` +
        `  switch the verifier to the new seed and FV_SERVER_KEY_ID=${free < 0 ? "<newKeyId>" : free}\n` +
        `  npx tsx scripts/server-key.ts revoke ${wanted.keyId}\n` +
        `or, if the new key is already registered under another key_id, pass --key-id <that id>.`
    );
  }
  if (keys.length >= MAX_SERVER_KEYS) throw new Error(`the registry already holds ${MAX_SERVER_KEYS} server keys (the maximum)`);
  const free = nextFree();
  return { action: "add", keyId: free, note: `${tag(wanted)} holds an old key; the new key goes to key_id ${free} (set FV_SERVER_KEY_ID=${free} on the verifier)` };
}

export interface ServerKeyCommand { cmd: "add"; pubkeyHex: string; keyId: number; validFrom: number; validTo: number }
export type ServerKeyCmd = ServerKeyCommand | { cmd: "revoke"; keyId: number } | { cmd: "list" };
/** server-key add <pubkeyHex> <keyId> [--valid-from <unix>] [--valid-to <unix>] | revoke <keyId> | list */
export function parseServerKeyArgs(argv: string[]): ServerKeyCmd {
  const usage = "usage: server-key add <pubkeyHex32> <keyId 0-255> [--valid-from <unix>] [--valid-to <unix>] | revoke <keyId> | list";
  const keyId = (v: string | undefined) => {
    if (!/^\d{1,3}$/.test(v ?? "") || Number(v) > 255) throw new Error(`invalid keyId "${v ?? ""}"\n${usage}`);
    return Number(v);
  };
  const num = (flag: string, def: number) => {
    const i = argv.indexOf(flag);
    if (i < 0) return def;
    const v = argv[i + 1];
    if (!/^\d{1,12}$/.test(v ?? "")) throw new Error(`${flag} must be a unix timestamp\n${usage}`);
    return Number(v);
  };
  switch (argv[0]) {
    case "add": {
      const pubkeyHex = (argv[1] ?? "").toLowerCase();
      if (!HEX32_RE.test(pubkeyHex)) throw new Error(`pubkey must be 32 bytes hex\n${usage}`);
      const validFrom = num("--valid-from", 0), validTo = num("--valid-to", 0);
      if (validTo !== 0 && validTo < validFrom) throw new Error("--valid-to must be 0 (open-ended) or >= --valid-from");
      return { cmd: "add", pubkeyHex, keyId: keyId(argv[2]), validFrom, validTo };
    }
    case "revoke": return { cmd: "revoke", keyId: keyId(argv[1]) };
    case "list": return { cmd: "list" };
    default: throw new Error(usage);
  }
}

export type PartnerCmd = { cmd: "add" | "remove"; partner: PublicKey } | { cmd: "list" };
/** partner add <pubkey> | remove <pubkey> | list */
export function parsePartnerArgs(argv: string[]): PartnerCmd {
  const usage = "usage: partner add <pubkey> | remove <pubkey> | list";
  if (argv[0] === "list") return { cmd: "list" };
  if (argv[0] !== "add" && argv[0] !== "remove") throw new Error(usage);
  try { return { cmd: argv[0], partner: new PublicKey(argv[1] ?? "") }; } catch { throw new Error(`invalid pubkey "${argv[1] ?? ""}"\n${usage}`); }
}
