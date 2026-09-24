#!/usr/bin/env node
// Upload one file to Arweave via Irys and print JSON on stdout.
//   node upload.mjs --key <keypair.json|default> --network devnet --rpc <solana rpc> [--tag Content-Type=image/jpeg ...] <file>
// stdout: {"id":"…","url":"https://gateway.irys.xyz/<id>","ar":"ar://<id>","bytes":n,"network":"devnet","tags":[…]}
// exit 1 + message on stderr on failure. NOTE: Irys devnet uploads are pruned after ~60 days.
import fs from 'node:fs';
import { GATEWAY, connect, fail, parseArgs } from './common.mjs';

let args;
try {
  args = parseArgs(process.argv.slice(2), { flags: { key: 'string', network: 'string', rpc: 'string', tag: 'list', timeout: 'string' } });
} catch (e) { fail(e.message, 2); }
const file = args._[0];
if (!file) fail('usage: node upload.mjs --key <keypair.json> --network devnet --rpc <url> [--tag k=v ...] <file>', 2);
if (!fs.existsSync(file)) fail(`file not found: ${file}`, 2);
const network = args.network || 'devnet';
const rpc = args.rpc || (network === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');

const tags = [];
for (const t of args.tag) {
  const i = t.indexOf('=');
  if (i <= 0) fail(`bad --tag ${t} (expected name=value)`, 2);
  tags.push({ name: t.slice(0, i), value: t.slice(i + 1) });
}
if (!tags.some((t) => t.name.toLowerCase() === 'content-type')) tags.push({ name: 'Content-Type', value: 'application/octet-stream' });
if (!tags.some((t) => t.name === 'App-Name')) tags.push({ name: 'App-Name', value: 'FlaconVault' });

try {
  const irys = await connect({ key: args.key, network, rpc, timeoutMs: Number(args.timeout || 45000) });
  const bytes = fs.statSync(file).size;
  const price = await irys.getPrice(bytes);
  const balance = await irys.getLoadedBalance();
  if (balance.lt(price)) {
    fail(`insufficient Irys balance: have ${irys.utils.fromAtomic(balance)} SOL, need ${irys.utils.fromAtomic(price)} SOL for ${bytes} bytes — run: node fund.mjs --key ${args.key || 'default'} --network ${network}`);
  }
  const receipt = await irys.uploadFile(file, { tags });
  process.stdout.write(JSON.stringify({ id: receipt.id, url: `${GATEWAY}/${receipt.id}`, ar: `ar://${receipt.id}`, bytes, network,
    timestamp: receipt.timestamp ?? null, tags }) + '\n');
} catch (e) {
  fail(e?.message || String(e));
}
