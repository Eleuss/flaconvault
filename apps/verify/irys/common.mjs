// Shared helpers for the FlaconVault Irys sidecar (upload.mjs / fund.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Uploader } from '@irys/upload';
import { Solana } from '@irys/upload-solana';

export const GATEWAY = 'https://gateway.irys.xyz';

export function parseArgs(argv, spec) {
  // spec: { flags: {name: 'string'|'boolean'|'list'}, positional: n }
  const out = { _: [] };
  for (const [k, t] of Object.entries(spec.flags)) out[k] = t === 'list' ? [] : t === 'boolean' ? false : undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let [name, inline] = a.slice(2).split(/=(.*)/s);
      const t = spec.flags[name];
      if (!t) throw new Error(`unknown flag --${name}`);
      if (t === 'boolean') { out[name] = true; continue; }
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      if (t === 'list') out[name].push(v); else out[name] = v;
    } else out._.push(a);
  }
  return out;
}

export function resolveKeyPath(p) {
  if (!p || p === 'default') p = path.join(os.homedir(), '.config', 'solana', 'id.json');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

export function loadKeypair(keyPath) {
  const raw = JSON.parse(fs.readFileSync(resolveKeyPath(keyPath), 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`keypair json must be a 64-number array: ${keyPath}`);
  return raw;
}

export async function connect({ key, network = 'devnet', rpc, timeoutMs = 45000 }) {
  const wallet = loadKeypair(key);
  let b = Uploader(Solana).withWallet(wallet).timeout(timeoutMs);
  if (rpc) b = b.withRpc(rpc);
  b = network === 'mainnet' ? b.mainnet() : b.devnet();
  const irys = await b;           // the builder is thenable
  return irys;
}

export function fail(msg, code = 1) {
  process.stderr.write(`irys-sidecar: ${msg}\n`);
  process.exit(code);
}
