/**
 * List a passport on the escrow market from the CLI wallet and record the LIST event on the verifier.
 *
 * Usage: npx tsx scripts/list-order.ts <serial> <priceUsdc> [--no-deposit] [--no-event] [verifyUrl]
 *   The wallet must own the passport's Metaplex Core asset (or be the issuer when there is no Core asset).
 *   An owned Core asset outside a collection is moved into escrow custody in the same transaction (it goes to the
 *   buyer on release) unless --no-deposit is given.
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET, FV_VERIFY_URL (default https://verify.flaconvault.com)
 */
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { MPL_CORE_PROGRAM_ID, fetchCoreAsset } from "./lib/core";
import { SERIAL_RE, loadWallet, postEvent, programFor, providerFor, verifyUrl } from "./lib/cli";
import { formatUsdc, parsePriceUsdc } from "../apps/web/src/lib/escrow-rules";

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((x) => x.startsWith("--")));
  const [serialRaw, priceRaw, verifyArg] = argv.filter((x) => !x.startsWith("--"));
  const serial = (serialRaw ?? "").trim();
  if (!SERIAL_RE.test(serial)) throw new Error("usage: list-order <serial> <priceUsdc> [--no-deposit] [--no-event] [verifyUrl]");
  const price = parsePriceUsdc(priceRaw ?? "");
  if (price === null) throw new Error(`invalid price "${priceRaw ?? ""}" (USDC > 0, at most 6 decimals, e.g. 480 or 480.5)`);
  const verify = verifyUrl(verifyArg);

  const keypair = loadWallet();
  const provider = providerFor(keypair);
  const connection = provider.connection;
  const escrow = programFor("escrow", provider);
  const flacon = programFor("flacon", provider);
  const seller = keypair.publicKey;
  const serialHash = createHash("sha256").update(serial).digest();
  const [passport] = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], flacon.programId);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], escrow.programId);
  const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), passport.toBuffer(), seller.toBuffer()], escrow.programId);

  const pp: any = await (flacon.account as any).passport.fetchNullable(passport);
  if (!pp) throw new Error(`passport ${serial} is not on chain`);
  if (pp.void || pp.grade === 4) throw new Error(`passport ${serial} is VOID`);
  const core = await fetchCoreAsset(connection, pp.asset);
  const allowed = core ? core.owner.equals(seller) : pp.issuer.equals(seller);
  if (!allowed) throw new Error(core ? `the Core asset ${pp.asset.toBase58()} belongs to ${core.owner.toBase58()}, not this wallet` : `only the issuer ${pp.issuer.toBase58()} can list this passport`);

  const tx = new Transaction().add(
    await escrow.methods.list(new BN(price.toString())).accountsStrict({ config, passport, order, seller, systemProgram: SystemProgram.programId, asset: pp.asset }).instruction()
  );
  const deposit = !!core && !core.inCollection && !flags.has("--no-deposit");
  if (deposit) {
    tx.add(await escrow.methods.depositAsset().accountsStrict({ order, seller, asset: pp.asset, mplCoreProgram: MPL_CORE_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction());
  }
  const sig = await provider.sendAndConfirm(tx);
  console.log(`list ${serial} ${formatUsdc(price)} USDC → order ${order.toBase58()}${deposit ? " (Core asset in escrow custody)" : ""} ${sig}`);

  if (!flags.has("--no-event")) {
    await postEvent(verify, { serial, type: 3, txSig: sig, actor: seller.toBase58(), payload: { priceUsdc: Number(formatUsdc(price)), currency: "USDC", market: "flaconvault", order: order.toBase58() } });
    console.log(`LIST event posted to ${verify}`);
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
