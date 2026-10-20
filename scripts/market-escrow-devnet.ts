/**
 * programs/market_escrow on devnet (or a local validator). Refuses mainnet.
 *
 *   npx tsx scripts/market-escrow-devnet.ts init    # init_config once (upgrade authority only)
 *   npx tsx scripts/market-escrow-devnet.ts smoke   # one full order: open → ship → confirm → collect fees → close
 *   npx tsx scripts/market-escrow-devnet.ts show    # print the config
 *
 * Keys (never in the repository): the offer key and the arbiter are Solana keypair files, created with mode 0600
 * on first use: FV_MARKET_OFFER_KEY (default ~/.config/flaconvault/market-offer-devnet.json) and
 * FV_MARKET_ARBITER_KEY (default ~/.config/flaconvault/market-arbiter-devnet.json). The offer key's secret is what
 * the marketplace server signs offers with; the arbiter's should move to a multisig before anything real.
 *
 * Env: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET (default ~/.config/solana/id.json; must be the
 * program's upgrade authority for `init`), FV_USDC_MINT (default: the devnet test USDC of programs/escrow),
 * FV_EURC_MINT (default: a new test mint, 6 decimals, mint authority = the wallet), FV_FEE_RECIPIENT (default: the wallet).
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction } from "@solana/web3.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ataAddress, createAtaIdempotentIx, createMint, mintToIx, tokenBalance } from "./lib/spl";
import { programDataOf } from "./lib/cli";
import { configPda, feeVaultPda, offerArgs, offerMessage, offerSignatureIx, orderPda, vaultPda, DAY, HOUR, LANE, TOKEN_PROGRAM_ID } from "../tests/lib/market-escrow";

const ROOT = path.resolve(__dirname, "..");
const DEVNET = "https://api.devnet.solana.com";
const DEVNET_TEST_USDC = "FLhABVjb5dHqbZs8zpWXi4Qr9JhHJC2gx75KnHQ9AdW5";
const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const readKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

/** Loads a keypair file, or creates it (mode 0600, directory 0700) when it does not exist. */
function keyFile(envName: string, fallback: string): Keypair {
  const p = expandHome(process.env[envName] ?? fallback);
  if (fs.existsSync(p)) return readKeypair(p);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`created    ${p}  (${kp.publicKey.toBase58()})`);
  return kp;
}

async function main() {
  const cmd = process.argv[2] ?? "show";
  const url = process.env.ANCHOR_PROVIDER_URL ?? DEVNET;
  if (/mainnet/i.test(url)) throw new Error("market_escrow is devnet only until the legal opinion and the audit (blueprint §7.1)");
  const wallet = readKeypair(expandHome(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json"));
  const connection = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/market_escrow.json"), "utf8"));
  const program = new Program(idl, provider) as Program<any>;
  const pid = program.programId;
  const [config] = configPda(pid);
  const send = (tx: Transaction, signers: Keypair[] = []) => provider.sendAndConfirm(tx, signers, { commitment: "confirmed" });
  console.log(`rpc        ${url}`);
  console.log(`program    ${pid.toBase58()}`);
  console.log(`wallet     ${wallet.publicKey.toBase58()}  (${(await connection.getBalance(wallet.publicKey)) / 1e9} SOL)`);

  if (cmd === "init") {
    if (await connection.getAccountInfo(config)) {
      console.log(`config     ${config.toBase58()} exists already (it has no setter)`);
    } else {
      const offer = keyFile("FV_MARKET_OFFER_KEY", "~/.config/flaconvault/market-offer-devnet.json");
      const arbiter = keyFile("FV_MARKET_ARBITER_KEY", "~/.config/flaconvault/market-arbiter-devnet.json");
      const usdc = new PublicKey(process.env.FV_USDC_MINT ?? DEVNET_TEST_USDC);
      const eurc = process.env.FV_EURC_MINT ? new PublicKey(process.env.FV_EURC_MINT) : await createMint(connection, wallet, wallet.publicKey, 6);
      const feeRecipient = new PublicKey(process.env.FV_FEE_RECIPIENT ?? wallet.publicKey.toBase58());
      const sig = await program.methods
        .initConfig(offer.publicKey, arbiter.publicKey, feeRecipient)
        .accountsStrict({
          config,
          authority: wallet.publicKey,
          usdcMint: usdc,
          eurcMint: eurc,
          usdcFeeVault: feeVaultPda(usdc, pid)[0],
          eurcFeeVault: feeVaultPda(eurc, pid)[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          program: pid,
          programData: programDataOf(pid),
        })
        .rpc();
      console.log(`init_config ${sig}`);
    }
  }

  const cfg = await program.account.marketConfig.fetch(config);
  const [usdc, eurc] = cfg.mints as PublicKey[];
  console.log(`config     ${config.toBase58()}`);
  console.log(`offer key  ${cfg.offerKey.toBase58()}`);
  console.log(`arbiter    ${cfg.arbiter.toBase58()}`);
  console.log(`fees to    ${cfg.feeRecipient.toBase58()}`);
  console.log(`USDC       ${usdc.toBase58()}  fee vault ${feeVaultPda(usdc, pid)[0].toBase58()}`);
  console.log(`EURC       ${eurc.toBase58()}  fee vault ${feeVaultPda(eurc, pid)[0].toBase58()}`);

  if (cmd === "smoke") {
    const offer = keyFile("FV_MARKET_OFFER_KEY", "~/.config/flaconvault/market-offer-devnet.json");
    if (!offer.publicKey.equals(cfg.offerKey)) throw new Error("FV_MARKET_OFFER_KEY is not the config's offer key");
    const buyer = Keypair.generate();
    const seller = Keypair.generate();
    const mint = usdc;
    const ata = (o: PublicKey) => ataAddress(o, mint);
    // the wallet is the test mint's authority and the sponsor (rent payer); buyer and seller hold no SOL
    await send(
      new Transaction().add(
        createAtaIdempotentIx(wallet.publicKey, buyer.publicKey, mint),
        createAtaIdempotentIx(wallet.publicKey, seller.publicKey, mint),
        createAtaIdempotentIx(wallet.publicKey, cfg.feeRecipient, mint),
        mintToIx(mint, ata(buyer.publicKey), wallet.publicKey, 42_000_000n)
      )
    );
    const slot = await connection.getSlot("confirmed");
    const now = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const t = {
      orderId: randomBytes(16),
      seller: seller.publicKey,
      amount: 40_000_000n, // 40.00, blueprint §8: 2.00 buyer protection, 1.20 commission
      buyerFee: 2_000_000n,
      sellerFee: 1_200_000n,
      lane: LANE.S,
      shipDeadline: now + 5 * DAY,
      rulingWindowS: 21 * DAY,
      timelockS: 48 * HOUR,
      expiry: now + 45,
    };
    const [order] = orderPda(buyer.publicKey, t.orderId, pid);
    const [vault] = vaultPda(order, pid);
    const feeVault = feeVaultPda(mint, pid)[0];
    const log = (step: string, sig: string) => console.log(`${step.padEnd(18)} ${sig}`);
    log(
      "open_and_deposit",
      await program.methods
        .openAndDeposit(offerArgs(t))
        .accountsStrict({ config, order, vault, mint, buyer: buyer.publicKey, buyerToken: ata(buyer.publicKey), rentPayer: wallet.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .preInstructions([offerSignatureIx(offer, offerMessage(pid, buyer.publicKey, mint, t))])
        .signers([buyer])
        .rpc()
    );
    console.log(`order              ${order.toBase58()}`);
    log("mark_shipped", await program.methods.markShipped().accountsStrict({ order, seller: seller.publicKey }).signers([seller]).rpc());
    log(
      "confirm",
      await program.methods.confirm().accountsStrict({ order, buyer: buyer.publicKey, vault, sellerToken: ata(seller.publicKey), feeVault, tokenProgram: TOKEN_PROGRAM_ID }).signers([buyer]).rpc()
    );
    log(
      "collect_fees",
      await program.methods.collectFees().accountsStrict({ config, mint, feeVault, feeDestination: ata(cfg.feeRecipient), tokenProgram: TOKEN_PROGRAM_ID }).rpc()
    );
    console.log(`seller got         ${await tokenBalance(connection, ata(seller.publicKey))} (expected 38800000)`);
    process.stdout.write("waiting for the offer to expire before close_order ");
    for (;;) {
      const s = await connection.getSlot("confirmed");
      if (((await connection.getBlockTime(s)) ?? 0) > t.expiry) break;
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log();
    log(
      "close_order",
      await program.methods.closeOrder().accountsStrict({ order, vault, rentPayer: wallet.publicKey, buyerToken: null, tokenProgram: TOKEN_PROGRAM_ID }).rpc()
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
