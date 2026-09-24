#!/usr/bin/env node
// Fund the Irys devnet node from the Solana keypair when the loaded balance is below the price of --target-bytes (default 1 MB).
//   node fund.mjs --key <keypair.json|default> --network devnet --rpc <url> [--amount-sol 0.01] [--target-bytes 1048576] [--dry-run]
// Hard cap: never funds more than 0.05 SOL in one call. Funding is needed once; balance is spent per upload.
import { connect, fail, parseArgs } from './common.mjs';

const MAX_SOL = 0.05;
let args;
try {
  args = parseArgs(process.argv.slice(2), { flags: { key: 'string', network: 'string', rpc: 'string', 'amount-sol': 'string', 'target-bytes': 'string', 'dry-run': 'boolean' } });
} catch (e) { fail(e.message, 2); }
const network = args.network || 'devnet';
const rpc = args.rpc || (network === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const amountSol = Number(args['amount-sol'] || 0.01);
const targetBytes = Number(args['target-bytes'] || 1024 * 1024);
if (!(amountSol > 0) || amountSol > MAX_SOL) fail(`--amount-sol must be in (0, ${MAX_SOL}]`, 2);

try {
  const irys = await connect({ key: args.key, network, rpc });
  const balance = await irys.getLoadedBalance();
  const price = await irys.getPrice(targetBytes);
  const out = { address: irys.address, network, node: irys.url.toString(), balanceSol: irys.utils.fromAtomic(balance).toString(),
    priceSol: irys.utils.fromAtomic(price).toString(), targetBytes, funded: false, txId: null };
  if (balance.gte(price)) {
    out.status = 'sufficient';
  } else if (args['dry-run']) {
    out.status = `would fund ${amountSol} SOL`;
  } else {
    const atomic = irys.utils.toAtomic(amountSol);
    const res = await irys.fund(atomic);
    out.funded = true;
    out.txId = res.id;
    out.fundedSol = irys.utils.fromAtomic(res.quantity).toString();
    // the node credits the deposit after the Solana tx is confirmed; poll briefly
    for (let i = 0; i < 20; i++) {
      const b = await irys.getLoadedBalance();
      if (b.gte(price)) { out.balanceSol = irys.utils.fromAtomic(b).toString(); break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    out.status = 'funded';
  }
  process.stdout.write(JSON.stringify(out) + '\n');
} catch (e) {
  fail(e?.message || String(e));
}
