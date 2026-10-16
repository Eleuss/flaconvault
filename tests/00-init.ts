/**
 * Init gating (runs first: file names sort before escrow.ts / flacon.ts). On a fresh validator neither the
 * flacon registry nor the escrow config exists yet; only the programs' upgrade authority (the provider
 * wallet, which `anchor test` deploys with) may create them. On a validator where they already exist
 * the checks are skipped (the singletons cannot be created twice).
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import type { Escrow } from "../target/types/escrow";
import type { Flacon } from "../target/types/flacon";
import { createMint } from "../scripts/lib/spl";
import { airdrop, expectAnchorError, programDataOf, registryPdaOf } from "./lib/flacon";

describe("init gating (upgrade authority only)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const flacon = anchor.workspace.flacon as Program<Flacon>;
  const escrow = anchor.workspace.escrow as Program<Escrow>;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const wallet = payer.publicKey;
  const stranger = Keypair.generate();
  const flaconErrors = (flacon.idl.errors ?? []) as { code: number; name: string }[];
  const escrowErrors = (escrow.idl.errors ?? []) as { code: number; name: string }[];
  const registry = registryPdaOf(flacon.programId);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], escrow.programId);

  before(async () => {
    await airdrop(provider, stranger.publicKey, 2);
  });

  it("programs are deployed upgradeable with the provider wallet as upgrade authority", async () => {
    for (const id of [flacon.programId, escrow.programId]) {
      const info = await provider.connection.getAccountInfo(programDataOf(id));
      expect(info, `ProgramData of ${id.toBase58()}`).to.not.be.null;
      // UpgradeableLoaderState::ProgramData: u32 tag (3) · u64 slot · Option<Pubkey> authority
      expect(info!.data.readUInt32LE(0)).to.equal(3);
      expect(info!.data[12]).to.equal(1);
      expect(new PublicKey(info!.data.subarray(13, 45)).equals(wallet)).to.be.true;
    }
  });

  it("init_registry: a stranger is refused, the upgrade authority succeeds", async function () {
    if (await provider.connection.getAccountInfo(registry)) {
      console.log("      (skipped: registry already exists on this validator)");
      return this.skip();
    }
    const accounts = (authority: PublicKey, programData = programDataOf(flacon.programId)) => ({
      registry,
      authority,
      systemProgram: SystemProgram.programId,
      program: flacon.programId,
      programData,
    });
    await expectAnchorError(
      flacon.methods.initRegistry().accountsStrict(accounts(stranger.publicKey)).signers([stranger]).rpc(),
      "NotUpgradeAuthority",
      flaconErrors
    );
    // the ProgramData of another program does not belong to this one
    await expectAnchorError(
      flacon.methods.initRegistry().accountsStrict(accounts(wallet, programDataOf(escrow.programId))).rpc(),
      "NotUpgradeAuthority",
      flaconErrors
    );
    await flacon.methods.initRegistry().accountsStrict(accounts(wallet)).rpc();
    const reg = await flacon.account.registry.fetch(registry);
    expect(reg.authority.equals(wallet)).to.be.true;
  });

  it("init_config: a stranger is refused, the window is bounded to 1 h ..= 60 days", async function () {
    if (await provider.connection.getAccountInfo(config)) {
      console.log("      (skipped: escrow config already exists on this validator)");
      return this.skip();
    }
    const mint = await createMint(provider.connection, payer, wallet, 6);
    const accounts = (admin: PublicKey) => ({
      config,
      admin,
      usdcMint: mint,
      systemProgram: SystemProgram.programId,
      program: escrow.programId,
      programData: programDataOf(escrow.programId),
    });
    await expectAnchorError(
      escrow.methods.initConfig(new BN(7 * 86400)).accountsStrict(accounts(stranger.publicKey)).signers([stranger]).rpc(),
      "Unauthorized",
      escrowErrors
    );
    await expectAnchorError(escrow.methods.initConfig(new BN(3599)).accountsStrict(accounts(wallet)).rpc(), "InvalidDisputeWindow", escrowErrors);
    await expectAnchorError(escrow.methods.initConfig(new BN(60 * 86400 + 1)).accountsStrict(accounts(wallet)).rpc(), "InvalidDisputeWindow", escrowErrors);
    await escrow.methods.initConfig(new BN(7 * 86400)).accountsStrict(accounts(wallet)).rpc();
    const cfg = await escrow.account.escrowConfig.fetch(config);
    expect(cfg.admin.equals(wallet)).to.be.true;
    expect(cfg.usdcMint.equals(mint)).to.be.true;
    expect(cfg.disputeAfterS.toNumber()).to.equal(7 * 86400);
  });
});
