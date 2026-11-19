/**
 * Anchor integration tests of the v2 public record (docs/public-record.md §7, §13) on the local validator, with the
 * real Ed25519 precompile: init_holder_config / set_holder_config, init_holding_v1 (registry authority or partner, and
 * in one transaction with v1 mint_passport as the mint paths send it, scripts/lib/cli.ts), mint_passport_v2,
 * attach_seal_v2 with a separate payer, and record_scan_v2 sent by an ephemeral fee payer (the "relayer") that is in
 * no instruction. Visitor scans are evidence only; HOLDER, WALLET and PARTNER scans change the grade; the folded
 * scan_head equals the TypeScript fold; ScanRecordedV2 is decoded from the self-CPI with the full message.
 *
 * The clock-dependent cases (±600 s boundaries, key validity at ts vs now) and a byte-for-byte replay of
 * docs/vectors.json v2.scans run in LiteSVM (programs/flacon/tests/record_scan_v2.rs, scripts/test-flacon-litesvm.sh).
 * Every message here is signed with a fresh ts under the public TEST server key (vectors.serverTestKey).
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { randomBytes } from "crypto";
import nacl from "tweetnacl";
import type { Flacon } from "../target/types/flacon";
import {
  FILL_NONE,
  airdrop,
  buildScanMessageV2,
  bytes,
  chainTime,
  commitmentOf,
  createCoreAsset,
  ed25519Ix,
  ensureHolderConfig,
  ensureRegistry,
  enums,
  eventAuthorityOf,
  expectAnchorError,
  foldScanHead,
  holderConfigPdaOf,
  holdingPdaOf,
  mintPassportV2WithSeal,
  mintPassportWithSeal,
  passportPdaOf,
  providerPayer,
  recordScan,
  recordScanBuilder,
  scanPdaOf,
  sealPdaOf,
  serverPubkey,
  sha256,
  signMessage,
  vectors,
  type Msg2Fields,
  type PassportHandle,
  type RegistryHandle,
} from "./lib/flacon";
import { holdingState, initHoldingV1, mintHoldingPlan, mintPassportV1 } from "../scripts/lib/cli";

const A = enums.actor_kind as Record<string, number>;
const P = enums.purpose as Record<string, number>;
const G = enums.grade as Record<string, number>;
const I = enums.indicator as Record<string, number>;
const ZERO32 = Buffer.alloc(32);
const EVENT_IX_TAG_LE = Buffer.from("e445a52e51cb9a1d", "hex");
/** `.rpc()` options: wait for "confirmed" (what a later "confirmed" read needs); simulate at "processed", where the
 * blockhash and the accounts of the previous sends are (a "confirmed" preflight may not see them yet). */
const CONFIRMED = { commitment: "confirmed", preflightCommitment: "processed" } as const;

describe("public record (v2)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.flacon as Program<Flacon>;
  const connection = provider.connection;
  const wallet = provider.wallet.publicKey; // registry authority + partner (ensureRegistry)
  const payer = providerPayer(program);
  const idlErrors = (program.idl.errors ?? []) as { code: number; name: string }[];
  const holderConfigPda = holderConfigPdaOf(program.programId);
  const eventAuthority = eventAuthorityOf(program.programId);
  const relayer = Keypair.generate(); // fee payer of every scan; no program authority, in no instruction
  const stranger = Keypair.generate();
  let reg: RegistryHandle;
  let clusterTag: number;

  type Pass = PassportHandle & { holdingPda: PublicKey; commitment: Buffer };

  /** A message for `p` signed now (fields default to a visitor CHECK at tier 1, fill 95, indicators INTACT). */
  async function msgFor(p: Pass, o: Partial<Msg2Fields> & { counter: number }): Promise<Buffer> {
    return buildScanMessageV2({
      programId: program.programId,
      clusterTag,
      serialHash: p.serialHash,
      uidHash: p.uidHash,
      tier: enums.tier.SELF,
      role: enums.role.OWNER,
      tamper: enums.tamper.UNKNOWN,
      uv: I.INTACT,
      hum: I.INTACT,
      heat: I.INTACT,
      heatLevels: 0,
      fill: 95,
      siteId: 0,
      purpose: P.CHECK,
      actorKind: A.NONE,
      actor: ZERO32,
      mediaHash: ZERO32,
      bundleHash: randomBytes(32),
      nonce: randomBytes(32),
      ts: await chainTime(connection),
      ...o,
    });
  }
  /** A P1 visitor TAP (tier 0, MISSING, fill 255, no media). */
  const tapFor = (p: Pass, counter: number, o: Partial<Msg2Fields> = {}) =>
    msgFor(p, { counter, tier: enums.tier.SIGHTING, purpose: P.TAP, uv: I.MISSING, hum: I.MISSING, heat: I.MISSING, fill: FILL_NONE, ...o });

  /** [Ed25519(TEST key over msg), record_scan_v2] as instructions (not sent). */
  async function scanIxs(p: Pass, msg: Buffer, o: { actorSigner?: PublicKey; asset?: PublicKey; keyId?: number; sig?: Buffer } = {}) {
    const ix = await program.methods
      .recordScanV2(o.keyId ?? reg.serverKeyId)
      .accountsStrict({
        registry: reg.registryPda,
        holderConfig: holderConfigPda,
        passport: p.passportPda,
        seal: p.sealPda,
        holding: p.holdingPda,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        actorSigner: o.actorSigner ?? null,
        asset: o.asset ?? null,
        eventAuthority,
        program: program.programId,
      })
      .instruction();
    return [ed25519Ix(msg, o.sig ?? signMessage(msg)), ix];
  }
  /**
   * Sends the instructions with the relayer as fee payer (and only signer unless `extra`). Preflight at "processed",
   * like the method builders' `.rpc()` that created the accounts (a "confirmed" preflight may not see them yet).
   */
  const sendAsRelayer = (ixs: TransactionInstruction[], extra: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [relayer, ...extra], { commitment: "confirmed", preflightCommitment: "processed" });
  async function recordV2(p: Pass, msg: Buffer, o: Parameters<typeof scanIxs>[2] & { extra?: Keypair[] } = {}) {
    return sendAsRelayer(await scanIxs(p, msg, o), o.extra);
  }

  const fetchPassport = (p: Pass) => program.account.passport.fetch(p.passportPda);
  const fetchHolding = (p: Pass) => program.account.holding.fetch(p.holdingPda);
  const newPass = async (o: Parameters<typeof mintPassportV2WithSeal>[2] = {}): Promise<Pass> => mintPassportV2WithSeal(program, reg.registryPda, o);

  before(async () => {
    reg = await ensureRegistry(program, wallet);
    await airdrop(provider, relayer.publicKey, 2);
    await airdrop(provider, stranger.publicKey, 1);
  });

  it("init_holder_config: registry authority only, cluster_tag 1..3, once", async function () {
    const accounts = (authority: PublicKey, payerKey: PublicKey = wallet) => ({
      registry: reg.registryPda,
      holderConfig: holderConfigPda,
      authority,
      payer: payerKey,
      systemProgram: SystemProgram.programId,
    });
    if (await connection.getAccountInfo(holderConfigPda)) {
      console.log("      (init checks skipped: holder_config already exists on this validator)");
    } else {
      await expectAnchorError(
        program.methods.initHolderConfig(enums.cluster.LOCALNET, PublicKey.default, PublicKey.default, PublicKey.default)
          .accountsStrict(accounts(stranger.publicKey)).signers([stranger]).rpc(),
        "Unauthorized",
        idlErrors
      );
      for (const bad of [0, 4]) {
        await expectAnchorError(
          program.methods.initHolderConfig(bad, PublicKey.default, PublicKey.default, PublicKey.default).accountsStrict(accounts(wallet)).rpc(),
          "InvalidClusterTag",
          idlErrors
        );
      }
      // the authority signs, a separate payer pays the rent
      const before = await connection.getBalance(wallet);
      await program.methods.initHolderConfig(enums.cluster.LOCALNET, PublicKey.default, PublicKey.default, PublicKey.default)
        .accountsStrict(accounts(wallet, relayer.publicKey)).signers([relayer]).rpc();
      expect(before - (await connection.getBalance(wallet)), "the authority paid only the fee").to.be.lessThan(20_000);
    }
    const cfg = await program.account.holderConfig.fetch(holderConfigPda);
    expect(cfg.authority.equals(wallet)).to.be.true;
    expect(cfg.clusterTag).to.be.oneOf([1, 2, 3]);
    expect(cfg.paused).to.be.false;
    expect((await connection.getAccountInfo(holderConfigPda))!.data.length).to.equal(8 + 219);
    clusterTag = (await ensureHolderConfig(program, wallet)).clusterTag;
    // a second init fails (the account exists), whatever the tag
    let failed = false;
    try {
      await program.methods.initHolderConfig(enums.cluster.MAINNET, PublicKey.default, PublicKey.default, PublicKey.default).accountsStrict(accounts(wallet)).rpc();
    } catch {
      failed = true;
    }
    expect(failed, "init_holder_config twice").to.be.true;
    expect((await program.account.holderConfig.fetch(holderConfigPda)).clusterTag).to.equal(clusterTag);
  });

  it("set_holder_config: the current registry authority only, delays 1 day ..= 30 days, cluster_tag unchanged", async () => {
    const DAY = 86_400;
    const set = (authority: Keypair | null, claim: number, notap: number, guardian = PublicKey.default) => {
      const b = program.methods
        .setHolderConfig(guardian, PublicKey.default, PublicKey.default, new BN(claim), new BN(notap))
        .accountsStrict({ holderConfig: holderConfigPda, authority: authority?.publicKey ?? wallet, registry: reg.registryPda });
      return (authority ? b.signers([authority]) : b).rpc();
    };
    await expectAnchorError(set(stranger, 3 * DAY, 7 * DAY), "Unauthorized", idlErrors);
    await expectAnchorError(set(null, DAY - 1, 7 * DAY), "InvalidDelay", idlErrors);
    await expectAnchorError(set(null, 3 * DAY, 30 * DAY + 1), "InvalidDelay", idlErrors);
    const guardian = Keypair.generate().publicKey;
    await set(null, DAY, 30 * DAY, guardian);
    let cfg = await program.account.holderConfig.fetch(holderConfigPda);
    expect(cfg.guardian.equals(guardian)).to.be.true;
    expect([cfg.claimDelayS.toNumber(), cfg.notapDelayS.toNumber(), cfg.clusterTag]).to.deep.equal([DAY, 30 * DAY, clusterTag]);
    await set(null, 259_200, 604_800); // back to the defaults
    cfg = await program.account.holderConfig.fetch(holderConfigPda);
    expect([cfg.claimDelayS.toNumber(), cfg.notapDelayS.toNumber()]).to.deep.equal([259_200, 604_800]);
  });

  it("mint_passport_v2 + attach_seal_v2: a partner signs, a separate payer pays; asset = Holding PDA, epoch 0", async () => {
    const issuer = Keypair.generate(); // a partner without any SOL
    await program.methods.addPartner(issuer.publicKey).accountsStrict({ registry: reg.registryPda, authority: wallet }).rpc();
    const rentPayer = Keypair.generate();
    await airdrop(provider, rentPayer.publicKey, 1);
    const p = await newPass({ issuer, payer: rentPayer });
    expect(await connection.getBalance(issuer.publicKey), "the issuer needs no SOL").to.equal(0);
    const passport = await fetchPassport(p);
    expect(passport.asset.equals(p.holdingPda)).to.be.true;
    expect(passport.issuer.equals(issuer.publicKey)).to.be.true;
    expect([passport.grade, passport.scanCount, passport.sealCount, passport.void]).to.deep.equal([G.A, 0, 1, false]);
    const h = await fetchHolding(p);
    expect(h.passport.equals(p.passportPda)).to.be.true;
    expect([h.state, h.epoch, h.headCount, h.lastScanTs.toNumber()]).to.deep.equal([enums.holding_state.ACCOUNT, 0, 0, 0]);
    expect(Buffer.from(h.commitment).equals(p.commitment)).to.be.true;
    expect(Buffer.from(h.scanHead).equals(ZERO32)).to.be.true;
    expect((await connection.getAccountInfo(p.holdingPda))!.data.length).to.equal(8 + 221);
    const seal = await program.account.seal.fetch(p.sealPda);
    expect(seal.passport.equals(p.passportPda)).to.be.true;

    // a non-partner issuer, a zero commitment
    const serialHash = sha256(`SN-V2-REFUSED-${randomBytes(4).toString("hex")}`);
    const passportPda = PublicKey.findProgramAddressSync([Buffer.from("passport"), serialHash], program.programId)[0];
    const mint = (issuerKp: Keypair, commitment: Buffer) =>
      program.methods
        .mintPassportV2(bytes(serialHash), bytes(serialHash), bytes(commitment))
        .accountsStrict({ registry: reg.registryPda, passport: passportPda, holding: holdingPdaOf(program.programId, passportPda), issuer: issuerKp.publicKey, payer: wallet, systemProgram: SystemProgram.programId })
        .signers([issuerKp])
        .rpc();
    await expectAnchorError(mint(stranger, randomBytes(32)), "NotPartner", idlErrors);
    await expectAnchorError(mint(issuer, ZERO32), "InvalidCommitment", idlErrors);
    expect(await connection.getAccountInfo(passportPda)).to.be.null;
  });

  it("record_scan_v2: visitor TAP and CHECK from an ephemeral fee payer; no ScanProof, grade unchanged, head = TS fold", async () => {
    const p = await newPass();
    const before = await fetchPassport(p);
    let head = ZERO32;
    const tap = await tapFor(p, 1);
    const relayerBefore = await connection.getBalance(relayer.publicKey);
    const sig = await recordV2(p, tap);
    head = foldScanHead(head, tap);
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx!.meta!.err).to.be.null;
    expect(relayerBefore - (await connection.getBalance(relayer.publicKey)), "the relayer paid the fee and no rent").to.equal(tx!.meta!.fee);
    // the relayer is the fee payer and the only signer, and in no instruction's account list
    const msg = tx!.transaction.message;
    const keys = msg.staticAccountKeys;
    expect(keys[0].equals(relayer.publicKey)).to.be.true;
    expect(msg.header.numRequiredSignatures).to.equal(1);
    for (const ix of msg.compiledInstructions) expect(ix.accountKeyIndexes, "relayer in an instruction").to.not.include(0);
    // ScanRecordedV2 through the self-CPI, with the full message
    const inner = tx!.meta!.innerInstructions!.find((x) => x.index === 1)!.instructions;
    expect(inner).to.have.length(1);
    const data = Buffer.from(anchor.utils.bytes.bs58.decode(inner[0].data));
    expect(data.subarray(0, 8).equals(EVENT_IX_TAG_LE)).to.be.true;
    const ev = program.coder.events.decode(data.subarray(8).toString("base64"));
    expect(ev?.name).to.equal("scanRecordedV2");
    const evData = ev!.data as any;
    expect(Buffer.from(evData.message).equals(tap)).to.be.true;
    expect(Buffer.from(evData.scanHead).equals(head)).to.be.true;
    expect([evData.headCount, evData.scanCount, evData.grade, evData.void]).to.deep.equal([1, 1, before.grade, false]);
    expect(evData.holding.equals(p.holdingPda) && evData.seal.equals(p.sealPda) && evData.passport.equals(p.passportPda)).to.be.true;

    // a visitor CHECK with a low fill and triggered heat: evidence only
    const check = await msgFor(p, { counter: 2, fill: 10, heat: I.TRIGGERED, heatLevels: 0b01_0000 });
    await recordV2(p, check);
    head = foldScanHead(head, check);
    const passport = await fetchPassport(p);
    expect([passport.grade, passport.void, passport.scanCount]).to.deep.equal([before.grade, false, 2]);
    expect((await program.account.seal.fetch(p.sealPda)).lastCounter).to.equal(2);
    const h = await fetchHolding(p);
    expect(Buffer.from(h.scanHead).equals(head), "on-chain head = TS fold").to.be.true;
    expect([h.headCount, h.lastActorKind, h.lastPurpose]).to.deep.equal([2, A.NONE, P.CHECK]);
    expect(Buffer.from(h.lastActor).equals(ZERO32)).to.be.true;
    expect(h.lastScanTs.toNumber()).to.equal(Number(check.readBigInt64LE(248)));
    for (const c of [1, 2]) expect(await connection.getAccountInfo(scanPdaOf(program.programId, p.sealPda, c)), "no ScanProof").to.be.null;
  });

  it("HOLDER scans change the grade with the current commitment only; RECIPIENT is evidence", async () => {
    const p = await newPass();
    await recordV2(p, await msgFor(p, { counter: 1, fill: 70, actorKind: A.HOLDER, actor: p.commitment }));
    expect((await fetchPassport(p)).grade).to.equal(G.B);
    await expectAnchorError(recordV2(p, await msgFor(p, { counter: 2, fill: 95, actorKind: A.HOLDER, actor: randomBytes(32) })), "ActorMismatch", idlErrors);
    // the next owner's RECEIPT under a prepared commitment: recorded, grade unchanged; never under the current one
    const next = commitmentOf(p.passportPda, 1, randomBytes(32));
    await expectAnchorError(recordV2(p, await msgFor(p, { counter: 2, fill: 95, purpose: P.RECEIPT, actorKind: A.RECIPIENT, actor: p.commitment })), "ActorMismatch", idlErrors);
    await recordV2(p, await msgFor(p, { counter: 2, fill: 95, purpose: P.RECEIPT, actorKind: A.RECIPIENT, actor: next }));
    expect((await fetchPassport(p)).grade).to.equal(G.B);
    const h = await fetchHolding(p);
    expect(h.lastActorKind).to.equal(A.RECIPIENT);
    expect(Buffer.from(h.lastActor).equals(next)).to.be.true;
    await recordV2(p, await msgFor(p, { counter: 3, fill: 95, actorKind: A.HOLDER, actor: p.commitment }));
    expect((await fetchPassport(p)).grade).to.equal(G.A);
  });

  it("init_holding_v1 on a v1 passport: the registry authority or a partner, separate payer, state WALLET; the Core owner's WALLET scan counts", async () => {
    const v1 = await mintPassportWithSeal(program, reg.registryPda, wallet); // Core asset owned by the wallet
    const holdingPda = holdingPdaOf(program.programId, v1.passportPda);
    const init = (authority: Keypair | null, payerKp: Keypair, passport = v1.passportPda) => {
      const b = program.methods.initHoldingV1().accountsStrict({
        registry: reg.registryPda, passport, holding: holdingPdaOf(program.programId, passport), authority: authority?.publicKey ?? wallet, payer: payerKp.publicKey, systemProgram: SystemProgram.programId,
      });
      return b.signers([authority, payerKp].filter((k): k is Keypair => !!k && !k.publicKey.equals(wallet))).rpc();
    };
    // neither the registry authority nor a partner
    await expectAnchorError(init(stranger, relayer), "Unauthorized", idlErrors);
    await init(null, relayer);
    const h = await program.account.holding.fetch(holdingPda);
    expect([h.state, h.epoch, h.headCount]).to.deep.equal([enums.holding_state.WALLET, 0, 0]);
    expect(Buffer.from(h.commitment).equals(ZERO32)).to.be.true;
    let twice = false;
    try { await init(null, relayer); } catch { twice = true; }
    expect(twice, "init_holding_v1 twice").to.be.true;
    // a registered partner that is not the authority, without any SOL: it signs, the relayer pays (mint_passport's
    // issuer check, so the partner console can send it with its own mints)
    const partner = Keypair.generate();
    await program.methods.addPartner(partner.publicKey).accountsStrict({ registry: reg.registryPda, authority: wallet }).rpc();
    const other = await mintPassportWithSeal(program, reg.registryPda, wallet);
    await init(partner, relayer, other.passportPda);
    expect(await connection.getBalance(partner.publicKey), "the partner paid nothing").to.equal(0);
    expect((await program.account.holding.fetch(holdingPdaOf(program.programId, other.passportPda))).state).to.equal(enums.holding_state.WALLET);
    await program.methods.removePartner(partner.publicKey).accountsStrict({ registry: reg.registryPda, authority: wallet }).rpc(); // the registry holds 16 at most
    const p: Pass = { ...v1, holdingPda, commitment: ZERO32 };

    // HOLDER / RECIPIENT need a pass held in an account
    await expectAnchorError(recordV2(p, await msgFor(p, { counter: 1, actorKind: A.HOLDER, actor: ZERO32 })), "HoldingNotInAccount", idlErrors);
    // WALLET: the Core owner co-signs (the relayer still pays); nobody else, and not without the signature
    const walletMsg = (counter: number, fill: number, actor = wallet) => msgFor(p, { counter, fill, actorKind: A.WALLET, actor: actor.toBuffer() });
    await expectAnchorError(recordV2(p, await walletMsg(1, 10), { asset: v1.asset }), "MissingActorSigner", idlErrors);
    await expectAnchorError(recordV2(p, await walletMsg(1, 10, stranger.publicKey), { actorSigner: stranger.publicKey, asset: v1.asset, extra: [stranger] }), "NotAssetOwner", idlErrors);
    await recordV2(p, await walletMsg(1, 10), { actorSigner: wallet, asset: v1.asset, extra: [payer] });
    expect((await fetchPassport(p)).grade).to.equal(G.D);
    // a visitor TAP on the same pass is recorded and keeps D
    await recordV2(p, await tapFor(p, 2));
    expect((await fetchPassport(p)).grade).to.equal(G.D);
    // v1 record_scan keeps working on a passport that has a Holding (it does not fold into scan_head)
    await recordScan(program, provider, reg, v1, { counter: 3, fill: 95 });
    expect((await fetchPassport(p)).grade).to.equal(G.A);
    const after = await program.account.holding.fetch(holdingPda);
    expect(after.headCount).to.equal(2);
  });

  it("v1 mint paths: mint_passport + init_holding_v1 in one transaction (the partner signs and pays), a relay scan lands at once; recovery adds a missing Holding", async () => {
    // the builders and the plan scripts/bind-chip.ts and scripts/seed-passports.ts use (the partner console sends the same)
    const issuer = Keypair.generate(); // a partner that is not the registry authority, as at /certify
    await program.methods.addPartner(issuer.publicKey).accountsStrict({ registry: reg.registryPda, authority: wallet }).rpc();
    await airdrop(provider, issuer.publicKey, 1);
    const mintV1 = async (withHolding: boolean): Promise<{ p: Pass; mintSig: string }> => {
      const serial = `SN-V1-HOLD-${randomBytes(4).toString("hex")}`;
      const serialHash = sha256(serial), uidHash = sha256(randomBytes(7));
      const passportPda = passportPdaOf(program.programId, serialHash), sealPda = sealPdaOf(program.programId, uidHash);
      const asset = await createCoreAsset(connection, payer, { owner: issuer.publicKey });
      const state = await holdingState(connection, program.programId, passportPda);
      expect(mintHoldingPlan({ ...state, passport: passportPda, existing: null }), "a new passport where the public record is on").to.equal("with_mint");
      const mint = await mintPassportV1(program, { registry: reg.registryPda, passport: passportPda, serialHash, bindingHash: sha256(serial), asset, wallet: issuer.publicKey, withHolding });
      const mintSig = await mint.signers([issuer]).rpc(CONFIRMED); // holdingState and getTransaction read "confirmed"
      await program.methods.attachSeal(bytes(uidHash), enums.seal_kind.NECK)
        .accountsStrict({ registry: reg.registryPda, passport: passportPda, seal: sealPda, signer: issuer.publicKey, systemProgram: SystemProgram.programId })
        .signers([issuer]).rpc();
      return { p: { serial, serialHash, uidHash, passportPda, sealPda, asset, holdingPda: state.holding, commitment: ZERO32 }, mintSig };
    };
    const planNow = async (p: Pass) =>
      mintHoldingPlan({ ...(await holdingState(connection, program.programId, p.passportPda)), passport: p.passportPda, existing: await fetchPassport(p) });

    const { p, mintSig } = await mintV1(true);
    // one transaction, mint_passport first, then init_holding_v1 of the same passport
    const tx = await connection.getTransaction(mintSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx!.transaction.message.staticAccountKeys;
    const ixs = (program.idl.instructions as { name: string; discriminator: number[] }[]);
    const names = tx!.transaction.message.compiledInstructions
      .filter((ix) => keys[ix.programIdIndex].equals(program.programId))
      .map((ix) => ixs.find((d) => Buffer.from(d.discriminator).equals(Buffer.from(ix.data).subarray(0, 8)))?.name);
    expect(names, "as the workspace IDL spells them").to.deep.equal(["mintPassport", "initHoldingV1"]);
    const h = await fetchHolding(p);
    expect(h.passport.equals(p.passportPda)).to.be.true;
    expect([h.state, h.epoch, h.headCount]).to.deep.equal([enums.holding_state.WALLET, 0, 0]);
    expect((await fetchPassport(p)).asset.equals(p.asset), "a v1 pass keeps its Core asset").to.be.true;
    expect(await planNow(p), "nothing to recover").to.equal("none");
    // a visitor TAP, relayed at once
    const tap = await tapFor(p, 1);
    await recordV2(p, tap);
    const after = await fetchHolding(p);
    expect(after.headCount).to.equal(1);
    expect(Buffer.from(after.scanHead).equals(foldScanHead(ZERO32, tap))).to.be.true;

    // mint_passport alone (how the mint paths sent it before): no Holding, so no relay scan can land ...
    const { p: q } = await mintV1(false);
    expect(await connection.getAccountInfo(q.holdingPda)).to.be.null;
    await expectAnchorError(recordV2(q, await tapFor(q, 1)), "AccountNotInitialized", idlErrors);
    // ... until the recovery path sends init_holding_v1 alone (the partner signs and pays)
    expect(await planNow(q)).to.equal("alone");
    await initHoldingV1(program, { registry: reg.registryPda, passport: q.passportPda, wallet: issuer.publicKey }).signers([issuer]).rpc(CONFIRMED);
    expect(await planNow(q)).to.equal("none");
    await recordV2(q, await tapFor(q, 1));
    expect((await fetchHolding(q)).headCount).to.equal(1);
    await program.methods.removePartner(issuer.publicKey).accountsStrict({ registry: reg.registryPda, authority: wallet }).rpc(); // the registry holds 16 at most
  });

  it("PARTNER: a co-signed BIRTH at tier 4 with a site; visitors cannot certify, receipt or skip the sighting rule", async () => {
    const p = await newPass();
    const birth = (counter: number, actor = wallet) =>
      msgFor(p, { counter, tier: enums.tier.BIRTH, role: enums.role.PARTNER, purpose: P.BIRTH, siteId: 1, fill: 100, actorKind: A.PARTNER, actor: actor.toBuffer(), mediaHash: randomBytes(32) });
    await expectAnchorError(recordV2(p, await birth(1)), "MissingActorSigner", idlErrors);
    await expectAnchorError(recordV2(p, await birth(1, stranger.publicKey), { actorSigner: stranger.publicKey, extra: [stranger] }), "NotPartner", idlErrors);
    await recordV2(p, await birth(1), { actorSigner: wallet, extra: [payer] });
    expect((await fetchHolding(p)).lastActorKind).to.equal(A.PARTNER);
    // a visitor never certifies: a pro role without a partner co-signer, or a certified tier for an owner
    await expectAnchorError(recordV2(p, await msgFor(p, { counter: 2, tier: enums.tier.CERTIFIED, role: enums.role.VAULT })), "NotPartner", idlErrors);
    await expectAnchorError(recordV2(p, await msgFor(p, { counter: 2, tier: enums.tier.CERTIFIED })), "TierNotAllowedForRole", idlErrors);
    await expectAnchorError(recordV2(p, await msgFor(p, { counter: 2, purpose: P.RECEIPT })), "PurposeNotAllowed", idlErrors);
    await expectAnchorError(recordV2(p, await tapFor(p, 2, { fill: 50 })), "InvalidSighting", idlErrors);
    await expectAnchorError(recordV2(p, await tapFor(p, 2, { mediaHash: randomBytes(32) })), "InvalidSighting", idlErrors);
  });

  it("domain, key and placement checks: cluster, program id, prefix, revoked key, counter replay, v1/v2 Ed25519 sizes", async () => {
    const p = await newPass();
    const otherTag = clusterTag === enums.cluster.LOCALNET ? enums.cluster.DEVNET : enums.cluster.LOCALNET;
    await expectAnchorError(recordV2(p, await tapFor(p, 1, { clusterTag: otherTag })), "WrongCluster", idlErrors);
    await expectAnchorError(recordV2(p, await tapFor(p, 1, { programId: Keypair.generate().publicKey })), "WrongProgramId", idlErrors);
    const padded = await tapFor(p, 1);
    padded.write(vectors.constants.MSG_PREFIX, 0, "ascii");
    await expectAnchorError(recordV2(p, padded), "InvalidMessagePrefix", idlErrors);
    // a 152-byte (v1-sized) Ed25519 message before record_scan_v2, and an FVSCAN2 Ed25519 before v1 record_scan
    const v1Sized = (await tapFor(p, 1)).subarray(0, vectors.constants.MSG_LEN);
    const [, v2ix] = await scanIxs(p, await tapFor(p, 1));
    await expectAnchorError(sendAsRelayer([ed25519Ix(v1Sized, signMessage(v1Sized)), v2ix]), "MalformedEd25519Instruction", idlErrors);
    const v1 = await mintPassportWithSeal(program, reg.registryPda, wallet);
    const v2msg = await tapFor(p, 1);
    await expectAnchorError(
      // [v1 Ed25519, FVSCAN2 Ed25519, record_scan]: the instruction right before record_scan carries 256 bytes
      recordScanBuilder(program, provider, reg, v1, { counter: 1, fill: 95 }).preInstructions([ed25519Ix(v2msg, signMessage(v2msg))]).rpc(),
      "MalformedEd25519Instruction",
      idlErrors
    );
    // no Ed25519 right before
    await expectAnchorError(sendAsRelayer([v2ix]), "MissingEd25519Instruction", idlErrors);
    const tap = await tapFor(p, 1);
    const [ed, ix] = await scanIxs(p, tap);
    await expectAnchorError(sendAsRelayer([ed, ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix]), "MissingEd25519Instruction", idlErrors);
    // the relayer's shape [limit, price, Ed25519, record_scan_v2] is accepted
    await sendAsRelayer([ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ed, ix]);
    await expectAnchorError(recordV2(p, await tapFor(p, 1)), "CounterNotIncreasing", idlErrors);
    // a signature by another key under the registry key id
    const other = nacl.sign.keyPair();
    const m2 = await tapFor(p, 2);
    const foreign = ed25519Ix(m2, Buffer.from(nacl.sign.detached(m2, other.secretKey)), Buffer.from(other.publicKey));
    await expectAnchorError(sendAsRelayer([foreign, (await scanIxs(p, m2))[1]]), "ServerKeyMismatch", idlErrors);

    // a revoked key (the TEST key under a fresh key id): signatures stop anchoring at once
    const used = new Set((await program.account.registry.fetch(reg.registryPda)).serverKeys.map((k) => k.keyId));
    let id = 2;
    while (used.has(id)) id++;
    const admin = { registry: reg.registryPda, authority: wallet };
    await program.methods.addServerKey(id, bytes(serverPubkey), new BN(0), new BN(0)).accountsStrict(admin).rpc();
    // dated a minute before the revocation (as the v1 twin in tests/flacon.ts): revoke sets valid_to = its clock − 1,
    // which may still be the second chainTime() read, so a ts of that second would fail ServerKeyNotValidAtTs first
    const signedBefore = await tapFor(p, 2, { ts: (await chainTime(connection)) - 60 });
    await program.methods.revokeServerKey(id).accountsStrict(admin).rpc();
    await expectAnchorError(recordV2(p, signedBefore, { keyId: id }), "ServerKeyNotValidNow", idlErrors);
    await recordV2(p, signedBefore); // the main TEST key id still works
    expect((await fetchHolding(p)).headCount).to.equal(2);
  });
});
