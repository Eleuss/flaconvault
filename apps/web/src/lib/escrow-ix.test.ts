import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AnchorProvider, Program, type Idl } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ata, escrowIx, payoutRecipient, registryPdaOf, type IxOrder } from "./escrow-ix";

const idl = JSON.parse(readFileSync(new URL("../../../../packages/proof/src/idl/escrow.json", import.meta.url), "utf8")) as Idl & {
  instructions: Array<{ name: string; accounts: Array<{ name: string }> }>;
};
const flaconIdl = JSON.parse(readFileSync(new URL("../../../../packages/proof/src/idl/flacon.json", import.meta.url), "utf8")) as { address: string };
const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: async <T extends Transaction | VersionedTransaction>(t: T) => t, signAllTransactions: async <T extends Transaction | VersionedTransaction>(t: T[]) => t };
// no RPC call is made: accountsStrict builders need no account resolution
const program = new Program(idl, new AnchorProvider(new Connection("http://127.0.0.1:1"), wallet, {}));
const mint = Keypair.generate().publicKey;
const caller = Keypair.generate().publicKey;
const order: IxOrder = {
  pubkey: Keypair.generate().publicKey, passport: Keypair.generate().publicKey, seller: Keypair.generate().publicKey,
  buyer: Keypair.generate().publicKey, asset: Keypair.generate().publicKey, priceBase: BigInt(480_000_000),
  sellerScan: Keypair.generate().publicKey, assetDeposited: false,
};

/** The first instruction must create `owner`'s USDC account idempotently, paid by `payer` (M15). */
function assertCreatesAta(tx: Transaction, payer: PublicKey, owner: PublicKey, label: string) {
  const first = tx.instructions[0];
  assert.ok(first.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID), `${label}: first instruction is the ATA program`);
  assert.deepEqual(Array.from(first.data), [1], `${label}: CreateIdempotent`);
  assert.ok(first.keys[0].pubkey.equals(payer), `${label}: payer`);
  assert.ok(first.keys[1].pubkey.equals(getAssociatedTokenAddressSync(mint, owner, true)), `${label}: the recipient's ATA`);
  assert.ok(first.keys[2].pubkey.equals(owner), `${label}: owner`);
  assert.ok(first.keys[3].pubkey.equals(mint), `${label}: mint`);
  assert.ok(tx.instructions[1].programId.equals(program.programId), `${label}: then the escrow instruction`);
}

test("every payout path first creates the recipient's USDC account (a seller who never held USDC still gets paid)", async () => {
  assertCreatesAta(await escrowIx.release(program, order, caller, mint).transaction(), caller, order.seller, "release");
  assertCreatesAta(await escrowIx.releaseAfterTimeout(program, order, caller, mint).transaction(), caller, order.seller, "release_after_timeout");
  assertCreatesAta(await escrowIx.dispute(program, order, caller, mint, null).transaction(), caller, order.buyer!, "dispute");
  assertCreatesAta(await escrowIx.resolve(program, order, caller, mint, true).transaction(), caller, order.seller, "resolve to the seller");
  assertCreatesAta(await escrowIx.resolve(program, order, caller, mint, false).transaction(), caller, order.buyer!, "resolve to the buyer");
});

test("the payout's token account is the one the ATA instruction creates", async () => {
  const release = await escrowIx.release(program, order, caller, mint).instruction();
  const names = idl.instructions.find((i) => i.name === "release")!.accounts.map((a) => a.name);
  assert.ok(release.keys[names.indexOf("seller_token")].pubkey.equals(ata(order.seller, mint)));
  const resolve = await escrowIx.resolve(program, order, caller, mint, false).instruction();
  const rNames = idl.instructions.find((i) => i.name === "resolve")!.accounts.map((a) => a.name);
  assert.ok(resolve.keys[rNames.indexOf("recipient_token")].pubkey.equals(ata(order.buyer!, mint)));
  assert.ok(payoutRecipient(order, "release").equals(order.seller));
  assert.ok(payoutRecipient(order, "dispute").equals(order.buyer!));
});

test("list and reserve pass the asset and the flacon registry the program checks the seller against (C12)", async () => {
  const registry = registryPdaOf(new PublicKey(flaconIdl.address));
  const reserve = await escrowIx.reserve(program, order, caller, mint, registry).instruction();
  const names = idl.instructions.find((i) => i.name === "reserve")!.accounts.map((a) => a.name);
  assert.deepEqual(names.slice(-3), ["passport", "asset", "registry"]);
  assert.ok(reserve.keys[names.indexOf("asset")].pubkey.equals(order.asset));
  assert.ok(reserve.keys[names.indexOf("registry")].pubkey.equals(registry));
  const list = await escrowIx.list(program, order.passport, order.seller, order.priceBase, order.asset, registry).instruction();
  const lNames = idl.instructions.find((i) => i.name === "list")!.accounts.map((a) => a.name);
  assert.deepEqual(lNames.slice(-2), ["asset", "registry"]);
  assert.ok(list.keys[lNames.indexOf("registry")].pubkey.equals(registry));
});
