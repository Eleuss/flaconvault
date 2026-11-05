/**
 * verify-pass — checks that the public record of a FlaconVault pass is complete and in order, from public chain data
 * alone (docs/public-record.md §8.2). Read-only: it only calls getAccountInfo, getSignaturesForAddress and
 * getTransaction, and it needs no key.
 *
 *   npm run -s verify-pass -- --rpc <url> --serial <serial> [--cluster devnet|mainnet|localnet]
 *                             [--program <id>] [--commitment finalized|confirmed] [--json]
 *
 * --program defaults to the flacon program id of this package's IDL; --cluster to devnet. Use `npm run -s` (silent)
 * with --json so npm's banner does not precede the JSON.
 * Exit codes: 0 = complete and in order, 1 = not, 2 = input or RPC error.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { clusterTag, formatVerifyPass, jsonRpcPassClient, verifyPass } from "../src/index.ts";

const USAGE = "usage: verify-pass --rpc <url> --serial <serial> [--cluster devnet|mainnet|localnet] [--program <id>] "
  + "[--commitment finalized|confirmed] [--json]";

function fail(message: string): never {
  console.error(`verify-pass: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        rpc: { type: "string" }, serial: { type: "string" }, cluster: { type: "string", default: "devnet" },
        program: { type: "string" }, commitment: { type: "string", default: "finalized" }, json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
  if (values.help) { console.log(USAGE); return; }
  if (!values.rpc || !values.serial) fail(USAGE);
  if (values.commitment !== "finalized" && values.commitment !== "confirmed") fail("--commitment is finalized or confirmed");
  let tag: number;
  try { tag = clusterTag(values.cluster); } catch (e) { fail((e as Error).message); }
  const programId = values.program
    ?? (JSON.parse(readFileSync(new URL("../src/idl/flacon.json", import.meta.url), "utf8")) as { address: string }).address;

  try {
    const rpc = jsonRpcPassClient(values.rpc, { commitment: values.commitment });
    const result = await verifyPass(rpc, { programId, clusterTag: tag, serial: values.serial });
    console.log(values.json ? JSON.stringify(result, null, 2) : formatVerifyPass(result));
    process.exitCode = result.complete ? 0 : 1;
  } catch (e) {
    fail((e as Error).message);
  }
}

await main();
