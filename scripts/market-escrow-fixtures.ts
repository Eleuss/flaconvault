/**
 * Writes the genesis accounts of the market escrow tests to tests/fixtures/market-escrow/ (loaded by
 * `anchor test` through Anchor.toml `[[test.validator.account_dir]]`): the two TEST ONLY mints and the
 * aged fixture orders with their vaults (tests/lib/market-escrow.ts). The files are committed; re-run
 * after a change to `MarketOrder` or to the fixtures, then `anchor test`:
 *
 *   npx tsx scripts/market-escrow-fixtures.ts           # write
 *   npx tsx scripts/market-escrow-fixtures.ts --check   # exit 1 if the committed files differ
 *
 * Order and vault addresses and the order's owner depend on the program id, which is read from Anchor.toml
 * `[programs.localnet]`: after `anchor keys sync` (CI, fresh program keypairs) the script writes fixtures for the
 * synced id.
 */
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fixtureAccounts } from "../tests/lib/market-escrow";

const root = path.join(__dirname, "..");
const dir = path.join(root, "tests", "fixtures", "market-escrow");
const check = process.argv.includes("--check");

function localnetProgramId(): PublicKey {
  const toml = fs.readFileSync(path.join(root, "Anchor.toml"), "utf8");
  const section = toml.split(/^\[programs\.localnet\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const m = /^market_escrow\s*=\s*"(\w+)"/m.exec(section);
  if (!m) throw new Error("Anchor.toml [programs.localnet] has no market_escrow id");
  return new PublicKey(m[1]);
}

const programId = localnetProgramId();
console.log(`program id ${programId.toBase58()} (Anchor.toml [programs.localnet])`);
const accounts = fixtureAccounts(programId);
let stale = 0;
if (!check) fs.mkdirSync(dir, { recursive: true });
for (const [name, json] of Object.entries(accounts)) {
  const file = path.join(dir, `${name}.json`);
  const text = JSON.stringify(json, null, 2) + "\n";
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
      console.error(`stale: ${path.relative(process.cwd(), file)}`);
      stale++;
    }
  } else {
    fs.writeFileSync(file, text);
    console.log(`${json.pubkey}  ${path.relative(process.cwd(), file)}`);
  }
}
if (check) {
  const extra = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !(f.replace(/\.json$/, "") in accounts)) : [];
  for (const f of extra) console.error(`not generated: ${f}`);
  process.exit(stale + extra.length > 0 ? 1 : 0);
}
