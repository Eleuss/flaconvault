//! LiteSVM tests of the v2 public record (docs/public-record.md §7, §13): `record_scan_v2` sent by a fee payer that
//! appears in no instruction (the relayer), the actor rules, the freshness window and key validity under a `Clock`
//! override, the top-level-only rule (a test builtin calls `record_scan_v2` through a CPI), and the setup
//! instructions (`init_holder_config`, `set_holder_config` gated on the current registry authority, `init_holding_v1`
//! by the authority or a partner, also in one transaction with v1 `mint_passport` as the mint paths send it,
//! `mint_passport_v2`, `attach_seal_v2`). `replays_the_v2_vectors` sends the six `docs/vectors.json` `v2.scans`
//! byte for byte (their Ed25519 instruction data and TEST-key signatures) at their signed `ts` and checks grade, void
//! and `scan_head` after each against the TypeScript generator.
//!
//! The registry is written straight into the SVM (`init_registry` needs an upgradeable deploy); everything else goes
//! through the program's instructions. This LiteSVM build has no precompiles, so the Ed25519 program is a test
//! builtin that verifies each signature like the precompile does (one signature, data in the instruction itself) and
//! fails the transaction otherwise. The real precompile runs in `tests/public-record.ts` (`anchor test`).
//!
//! Needs an SBF build of the program that LiteSVM 0.10 (Agave 3.1) can load. `anchor build` targets SBPF v3 by
//! default, which this runtime refuses, so the test builds the same source for SBPF v2:
//!   scripts/test-flacon-litesvm.sh
//! which runs
//!   cargo build-sbf --manifest-path programs/flacon/Cargo.toml --tools-version v1.57 --arch v2 \
//!     --sbf-out-dir target/sbf-v2 -- --locked
//!   cargo test -p flacon --test record_scan_v2 -- --ignored
//! The tests are `#[ignore]`d so a plain `cargo test` (no SBF toolchain) skips them visibly. `FV_FLACON_SO` points
//! them at another build. The vector replay needs `declare_id!` to be the vectors' program id (7dCr…): run it before
//! `anchor keys sync`.

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{AccountMeta, Instruction},
    AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use flacon::{
    constants::*,
    events::ScanRecordedV2,
    message_v2::{build_scan_message_v2, fold_scan_head, ScanMessageV2},
    FlaconError, HolderConfig, Holding, Passport, Registry, Seal, ServerKey, Site,
};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_program_runtime::{__private::InstructionError, declare_process_instruction};
use solana_signer::Signer;
use solana_transaction::Transaction;

/// Some point in time well after the epoch (the exact value does not matter).
const T0: i64 = 1_790_000_000;
const ED25519_ID: Pubkey = flacon::ed25519::ED25519_PROGRAM_ID;
const COMPUTE_BUDGET_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
const NATIVE_LOADER_ID: Pubkey = pubkey!("NativeLoader1111111111111111111111111111111");

fn program_so() -> String {
    let path = std::env::var("FV_FLACON_SO")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/sbf-v2/flacon.so").to_string());
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} is missing: run scripts/test-flacon-litesvm.sh (builds it for SBPF v2, see the module docs)"
    );
    path
}

fn code(e: FlaconError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}
fn hex32(s: &str) -> [u8; 32] {
    hex(s).try_into().expect("32 bytes")
}
fn sha256(b: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[b]).to_bytes()
}
fn vectors() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("docs/vectors.json")).unwrap()
}

// ---- Ed25519 "precompile" ---------------------------------------------------------------------------------

/// Verifies the data like the Ed25519 precompile for the layout the relayer sends (one signature; key, signature and
/// message inside this instruction, every instruction index 0xFFFF).
fn ed25519_data_verifies(d: &[u8]) -> bool {
    let u16_at = |o: usize| d.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let (Some(sig), Some(sig_ix), Some(pk), Some(pk_ix), Some(msg), Some(len), Some(msg_ix)) =
        (u16_at(2), u16_at(4), u16_at(6), u16_at(8), u16_at(10), u16_at(12), u16_at(14))
    else {
        return false;
    };
    if d[0] != 1 || [sig_ix, pk_ix, msg_ix].iter().any(|&i| i != 0xFFFF) {
        return false;
    }
    let (Some(sig), Some(pk), Some(msg)) = (d.get(sig..sig + 64), d.get(pk..pk + 32), d.get(msg..msg + len)) else {
        return false;
    };
    solana_signature::Signature::from(<[u8; 64]>::try_from(sig).unwrap()).verify(pk, msg)
}

declare_process_instruction!(Ed25519Builtin, 150, |invoke_context| {
    let data = invoke_context.transaction_context.get_current_instruction_context()?.get_instruction_data().to_vec();
    if ed25519_data_verifies(&data) {
        Ok(())
    } else {
        Err(InstructionError::InvalidInstructionData)
    }
});

// A test-only wrapper program: forwards its own data and accounts unchanged to flacon as an inner instruction (the
// accounts must include flacon's program id; `record_scan_v2` has it as `program`). `record_scan_v2` then runs at stack
// height 2 and must refuse (D8).
declare_process_instruction!(CpiForwarder, 1000, |invoke_context| {
    let (data, accounts) = {
        let ictx = invoke_context.transaction_context.get_current_instruction_context()?;
        let mut accounts = Vec::new();
        for i in 0..ictx.get_number_of_instruction_accounts() {
            accounts.push(AccountMeta {
                pubkey: *ictx.get_key_of_instruction_account(i)?,
                is_signer: ictx.is_instruction_account_signer(i)?,
                is_writable: ictx.is_instruction_account_writable(i)?,
            });
        }
        (ictx.get_instruction_data().to_vec(), accounts)
    };
    invoke_context.native_invoke(Instruction { program_id: flacon::ID, accounts, data }, &[])
});
const CPI_FORWARDER_ID: Pubkey = Pubkey::new_from_array([0xCF; 32]);

/// Same layout as web3.js `Ed25519Program.createInstructionWithPublicKey` (docs/public-record.md §3.6).
fn ed25519_ix(pubkey: &[u8; 32], sig: &[u8], msg: &[u8]) -> Instruction {
    let mut d = vec![1u8, 0u8];
    for v in [48u16, u16::MAX, 16, u16::MAX, 112, msg.len() as u16, u16::MAX] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(pubkey);
    d.extend_from_slice(sig);
    d.extend_from_slice(msg);
    Instruction { program_id: ED25519_ID, accounts: vec![], data: d }
}

// ---- environment ---------------------------------------------------------------------------------------------

struct Pass {
    serial_hash: [u8; 32],
    passport: Pubkey,
    holding: Pubkey,
    commitment: [u8; 32],
}

struct Env {
    svm: LiteSVM,
    /// Fee payer of every scan; in no instruction's account list.
    relayer: Keypair,
    /// Registry authority (and payer of the setup instructions unless a test says otherwise).
    admin: Keypair,
    /// The verifier's scan key, registered as key_id 1.
    server: Keypair,
    partner: Keypair,
    registry: Pubkey,
    holder_config: Pubkey,
    event_authority: Pubkey,
}

fn anchor_account<T: AccountSerialize>(svm: &LiteSVM, value: &T, space: usize) -> Account {
    let mut data = Vec::with_capacity(space);
    value.try_serialize(&mut data).expect("serialize");
    data.resize(space, 0);
    Account { lamports: svm.minimum_balance_for_rent_exemption(space), data, owner: flacon::ID, executable: false, rent_epoch: 0 }
}

impl Env {
    /// Registry (server key 1 = `server`, partner, sites 1 and 2) and HolderConfig with `cluster_tag`.
    fn new(server: Keypair, partner: Keypair, cluster_tag: u8, extra_keys: &[ServerKey]) -> Env {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(flacon::ID, program_so()).expect("load flacon.so");
        svm.add_builtin(ED25519_ID, Ed25519Builtin::vm);
        // the runtime dispatches a builtin by program id only when its account belongs to the native loader
        // (litesvm 0.10's add_builtin leaves it to the BPF loader, which then refuses the "program")
        let native = Account { lamports: 1, data: b"ed25519_test_builtin".to_vec(), owner: NATIVE_LOADER_ID, executable: true, rent_epoch: 0 };
        svm.set_account(ED25519_ID, native).unwrap();
        svm.add_builtin(CPI_FORWARDER_ID, CpiForwarder::vm);
        let native = Account { lamports: 1, data: b"cpi_forwarder_test_builtin".to_vec(), owner: NATIVE_LOADER_ID, executable: true, rent_epoch: 0 };
        svm.set_account(CPI_FORWARDER_ID, native).unwrap();
        let (relayer, admin) = (Keypair::new(), Keypair::new());
        for k in [&relayer, &admin, &partner] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let (registry, bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &flacon::ID);
        let mut server_keys = vec![ServerKey { key_id: 1, pubkey: server.pubkey().to_bytes(), valid_from: 0, valid_to: 0 }];
        server_keys.extend_from_slice(extra_keys);
        let reg = Registry {
            authority: admin.pubkey(),
            server_keys,
            partners: vec![partner.pubkey()],
            sites: vec![Site { site_id: 1, label: [b'x'; 32] }, Site { site_id: 2, label: [b'y'; 32] }],
            bump,
        };
        let acc = anchor_account(&svm, &reg, 8 + Registry::INIT_SPACE);
        svm.set_account(registry, acc).unwrap();
        let holder_config = Pubkey::find_program_address(&[HOLDER_CONFIG_SEED], &flacon::ID).0;
        let event_authority = Pubkey::find_program_address(&[b"__event_authority"], &flacon::ID).0;
        let mut env = Env { svm, relayer, admin, server, partner, registry, holder_config, event_authority };
        env.set_time(T0);
        let ix = env.init_holder_config_ix(cluster_tag, &env.admin.pubkey());
        let admin = env.admin.insecure_clone();
        env.send(vec![ix], &[&admin]).expect("init_holder_config");
        env
    }

    /// A fresh scan key and partner, DEVNET.
    fn devnet() -> Env {
        Env::new(Keypair::new(), Keypair::new(), CLUSTER_DEVNET, &[])
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Sends the instructions with the relayer as fee payer (plus extra signers); `Err(debug text)` on failure.
    fn send(&mut self, ixs: Vec<Instruction>, extra: &[&Keypair]) -> std::result::Result<TransactionMetadata, String> {
        // a fresh blockhash per attempt, so a retried identical transaction is not "already processed"
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![&self.relayer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&self.relayer.pubkey()), &signers, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map_err(|e| format!("{:?} {}", e.err, e.meta.logs.join("\n")))
    }

    fn expect_error(&mut self, ixs: Vec<Instruction>, extra: &[&Keypair], e: FlaconError) {
        let name = format!("{e:?}");
        match self.send(ixs, extra) {
            Ok(_) => panic!("expected {name}, the transaction succeeded"),
            Err(got) => assert!(got.contains(&format!("Custom({})", code(e))), "expected {name}, got {got}"),
        }
    }

    fn account<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let a = self.svm.get_account(key).expect("account exists");
        T::try_deserialize(&mut a.data.as_slice()).expect("account data")
    }
    fn passport(&self, p: &Pass) -> Passport {
        self.account(&p.passport)
    }
    fn holding(&self, p: &Pass) -> Holding {
        self.account(&p.holding)
    }
    fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).is_some_and(|a| a.lamports > 0)
    }
    fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    // ---- instruction builders ----

    fn init_holder_config_ix(&self, cluster_tag: u8, authority: &Pubkey) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::InitHolderConfig {
                registry: self.registry,
                holder_config: self.holder_config,
                authority: *authority,
                payer: self.relayer.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: flacon::instruction::InitHolderConfig {
                cluster_tag,
                guardian: Pubkey::default(),
                holder_key: Pubkey::default(),
                registrar_key: Pubkey::default(),
            }
            .data(),
        }
    }

    fn set_holder_config_ix(&self, authority: &Pubkey, guardian: Pubkey, claim: i64, notap: i64) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::SetHolderConfig { holder_config: self.holder_config, authority: *authority, registry: self.registry }
                .to_account_metas(None),
            data: flacon::instruction::SetHolderConfig {
                guardian,
                holder_key: Pubkey::new_from_array([7u8; 32]),
                registrar_key: Pubkey::new_from_array([8u8; 32]),
                claim_delay_s: claim,
                notap_delay_s: notap,
            }
            .data(),
        }
    }

    /// `transfer_authority` (registry_admin.rs): the current and the new authority both sign.
    fn transfer_authority_ix(&self, authority: &Pubkey, new_authority: &Pubkey) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::TransferAuthority { registry: self.registry, authority: *authority, new_authority: *new_authority }
                .to_account_metas(None),
            data: flacon::instruction::TransferAuthority {}.data(),
        }
    }

    fn pdas(serial_hash: &[u8; 32]) -> (Pubkey, Pubkey) {
        let passport = Pubkey::find_program_address(&[PASSPORT_SEED, serial_hash], &flacon::ID).0;
        let holding = Pubkey::find_program_address(&[HOLDING_SEED, passport.as_ref()], &flacon::ID).0;
        (passport, holding)
    }

    fn mint_v2_ix(&self, serial_hash: [u8; 32], commitment: [u8; 32], issuer: &Pubkey) -> Instruction {
        let (passport, holding) = Env::pdas(&serial_hash);
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::MintPassportV2 {
                registry: self.registry,
                passport,
                holding,
                issuer: *issuer,
                payer: self.relayer.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: flacon::instruction::MintPassportV2 { serial_hash, binding_hash: sha256(&serial_hash), commitment }.data(),
        }
    }

    /// `mint_passport_v2` by the partner (the relayer pays), under a random commitment unless given.
    fn mint_v2(&mut self, serial: &str, commitment: Option<[u8; 32]>) -> Pass {
        let serial_hash = sha256(serial.as_bytes());
        let (passport, holding) = Env::pdas(&serial_hash);
        let commitment = commitment.unwrap_or_else(|| sha256(format!("commitment:{serial}").as_bytes()));
        let ix = self.mint_v2_ix(serial_hash, commitment, &self.partner.pubkey());
        let partner = self.partner.insecure_clone();
        self.send(vec![ix], &[&partner]).expect("mint_passport_v2");
        Pass { serial_hash, passport, holding, commitment }
    }

    fn attach_v2_ix(&self, p: &Pass, uid_hash: [u8; 32], kind: u8, signer: &Pubkey) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::AttachSealV2 {
                registry: self.registry,
                passport: p.passport,
                seal: Env::seal_pda(&uid_hash),
                signer: *signer,
                payer: self.relayer.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: flacon::instruction::AttachSealV2 { uid_hash, kind }.data(),
        }
    }

    fn seal_pda(uid_hash: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[SEAL_SEED, uid_hash], &flacon::ID).0
    }

    /// v1 `mint_passport` by `issuer` (who pays) of `asset`, a Core asset the issuer must own.
    fn mint_v1_ix(&self, serial_hash: [u8; 32], asset: Pubkey, issuer: &Pubkey) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::MintPassport {
                registry: self.registry,
                passport: Env::pdas(&serial_hash).0,
                issuer: *issuer,
                system_program: anchor_lang::system_program::ID,
                core_asset: asset,
            }
            .to_account_metas(None),
            data: flacon::instruction::MintPassport { serial_hash, binding_hash: sha256(&serial_hash), asset }.data(),
        }
    }

    /// `init_holding_v1` of `passport`: `authority` signs, `payer` pays.
    fn init_holding_v1_ix(&self, passport: Pubkey, authority: &Pubkey, payer: &Pubkey) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::InitHoldingV1 {
                registry: self.registry,
                passport,
                holding: Pubkey::find_program_address(&[HOLDING_SEED, passport.as_ref()], &flacon::ID).0,
                authority: *authority,
                payer: *payer,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: flacon::instruction::InitHoldingV1 {}.data(),
        }
    }

    /// v1 `attach_seal` (the signer pays).
    fn attach_v1_ix(&self, passport: Pubkey, uid_hash: [u8; 32], kind: u8, signer: &Pubkey) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::AttachSeal {
                registry: self.registry,
                passport,
                seal: Env::seal_pda(&uid_hash),
                signer: *signer,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: flacon::instruction::AttachSeal { uid_hash, kind }.data(),
        }
    }

    /// `add_partner` / `remove_partner` by the registry authority.
    fn partner_ix(&self, partner: Pubkey, add: bool) -> Instruction {
        let accounts = flacon::accounts::AdminRegistry { registry: self.registry, authority: self.admin.pubkey() }.to_account_metas(None);
        let data = if add { flacon::instruction::AddPartner { partner }.data() } else { flacon::instruction::RemovePartner { partner }.data() };
        Instruction { program_id: flacon::ID, accounts, data }
    }

    /// `attach_seal_v2` (NECK) by the partner; returns the uid hash.
    fn attach_v2(&mut self, p: &Pass, uid: &[u8]) -> [u8; 32] {
        let uid_hash = sha256(uid);
        let ix = self.attach_v2_ix(p, uid_hash, SEAL_KIND_NECK, &self.partner.pubkey());
        let partner = self.partner.insecure_clone();
        self.send(vec![ix], &[&partner]).expect("attach_seal_v2");
        uid_hash
    }

    /// A minted pass with one seal.
    fn sealed_pass(&mut self, serial: &str) -> (Pass, [u8; 32]) {
        let p = self.mint_v2(serial, None);
        let uid_hash = self.attach_v2(&p, serial.as_bytes());
        (p, uid_hash)
    }

    fn record_scan_v2_ix(&self, p: &Pass, uid_hash: &[u8; 32], key_id: u8, actor_signer: Option<Pubkey>, asset: Option<Pubkey>) -> Instruction {
        Instruction {
            program_id: flacon::ID,
            accounts: flacon::accounts::RecordScanV2 {
                registry: self.registry,
                holder_config: self.holder_config,
                passport: p.passport,
                seal: Env::seal_pda(uid_hash),
                holding: p.holding,
                instructions: solana_instructions_sysvar::ID,
                actor_signer,
                asset,
                event_authority: self.event_authority,
                program: flacon::ID,
            }
            .to_account_metas(None),
            data: flacon::instruction::RecordScanV2 { server_key_id: key_id }.data(),
        }
    }

    /// [Ed25519(server key over msg), record_scan_v2(key 1)] for a visitor or HOLDER / RECIPIENT scan.
    fn scan_ixs(&self, p: &Pass, uid_hash: &[u8; 32], m: &ScanMessageV2) -> Vec<Instruction> {
        let msg = build_scan_message_v2(m);
        let sig = self.server.sign_message(&msg);
        vec![ed25519_ix(&self.server.pubkey().to_bytes(), sig.as_ref(), &msg), self.record_scan_v2_ix(p, uid_hash, 1, None, None)]
    }

    /// A visitor TAP (§3.4 "a P1 TAP") of `p` / `uid_hash` signed at `ts`.
    fn tap(&self, p: &Pass, uid_hash: &[u8; 32], counter: u32, ts: i64) -> ScanMessageV2 {
        ScanMessageV2 {
            program_id: flacon::ID.to_bytes(),
            cluster_tag: CLUSTER_DEVNET,
            serial_hash: p.serial_hash,
            uid_hash: *uid_hash,
            counter,
            tier: TIER_SIGHTING,
            role: ROLE_OWNER,
            tamper: TAMPER_UNKNOWN,
            uv: INDICATOR_MISSING,
            hum: INDICATOR_MISSING,
            heat: INDICATOR_MISSING,
            heat_levels: 0,
            fill: FILL_NONE,
            site_id: 0,
            purpose: PURPOSE_TAP,
            actor_kind: ACTOR_KIND_NONE,
            actor: [0u8; 32],
            media_hash: [0u8; 32],
            bundle_hash: sha256(format!("bundle:{counter}").as_bytes()),
            nonce: sha256(format!("nonce:{counter}:{ts}").as_bytes()),
            ts,
        }
    }

    /// A tier-1 CHECK with a fill reading (indicators INTACT) by `actor_kind` / `actor`.
    fn check(&self, p: &Pass, uid_hash: &[u8; 32], counter: u32, fill: u8, actor_kind: u8, actor: [u8; 32]) -> ScanMessageV2 {
        ScanMessageV2 {
            tier: TIER_SELF,
            purpose: if actor_kind == ACTOR_KIND_RECIPIENT { PURPOSE_RECEIPT } else { PURPOSE_CHECK },
            uv: INDICATOR_INTACT,
            hum: INDICATOR_INTACT,
            heat: INDICATOR_INTACT,
            fill,
            actor_kind,
            actor,
            ..self.tap(p, uid_hash, counter, T0)
        }
    }

    /// Records `m` and returns the transaction metadata; panics on failure.
    fn record(&mut self, p: &Pass, uid_hash: &[u8; 32], m: &ScanMessageV2) -> TransactionMetadata {
        let ixs = self.scan_ixs(p, uid_hash, m);
        self.send(ixs, &[]).unwrap_or_else(|e| panic!("record_scan_v2 counter {}: {e}", m.counter))
    }
}

/// The `ScanRecordedV2` event of the record_scan_v2 instruction at `ix_index` (emit_cpi!: an inner instruction to the
/// program itself with data `EVENT_IX_TAG_LE ‖ discriminator ‖ borsh`).
fn scan_event(meta: &TransactionMetadata, ix_index: usize) -> ScanRecordedV2 {
    let inner = &meta.inner_instructions[ix_index];
    assert_eq!(inner.len(), 1, "one self-CPI per scan");
    let data = &inner[0].instruction.data;
    assert_eq!(&data[..8], anchor_lang::event::EVENT_IX_TAG_LE);
    assert_eq!(&data[8..16], ScanRecordedV2::DISCRIMINATOR);
    assert_eq!(inner[0].stack_height, 2);
    ScanRecordedV2::try_from_slice(&data[16..]).expect("event data")
}

fn scan_proof_pda(uid_hash: &[u8; 32], counter: u32) -> Pubkey {
    let seal = Env::seal_pda(uid_hash);
    Pubkey::find_program_address(&[SCAN_SEED, seal.as_ref(), &counter.to_le_bytes()], &flacon::ID).0
}

/// A Metaplex Core `AssetV1` owned by `owner` (LiteSVM has no Core program; `mint_passport` and the WALLET actor rule
/// only read the account's owner program, key byte and owner field). Returns its address.
fn fake_core_asset(env: &mut Env, owner: &Pubkey) -> Pubkey {
    let asset = Pubkey::new_unique();
    let mut data = vec![MPL_CORE_KEY_ASSET_V1];
    data.extend_from_slice(owner.as_ref());
    data.extend_from_slice(&[0u8; 64]);
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(asset, Account { lamports, data, owner: MPL_CORE_PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
    asset
}

/// Makes `p` look like a pass moved to a wallet (P4): `passport.asset` = a Core `AssetV1` owned by `wallet`, Holding
/// in state WALLET. Returns the asset address.
fn move_to_wallet(env: &mut Env, p: &Pass, wallet: &Pubkey) -> Pubkey {
    let asset = fake_core_asset(env, wallet);
    let mut passport = env.passport(p);
    passport.asset = asset;
    let acc = anchor_account(&env.svm, &passport, 8 + Passport::INIT_SPACE);
    env.svm.set_account(p.passport, acc).unwrap();
    let mut holding = env.holding(p);
    holding.state = HOLDING_STATE_WALLET;
    let acc = anchor_account(&env.svm, &holding, 8 + Holding::INIT_SPACE);
    env.svm.set_account(p.holding, acc).unwrap();
    asset
}

// ---- tests ---------------------------------------------------------------------------------------------------

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn replays_the_v2_vectors() {
    let v = vectors();
    let v2 = &v["v2"];
    assert_eq!(
        v2["programId"].as_str().unwrap(),
        flacon::ID.to_string(),
        "the vectors are signed for the devnet program id: run this test before `anchor keys sync`"
    );
    let seed = |label: &str| Keypair::new_from_array(sha256(label.as_bytes()));
    let server = Keypair::new_from_array(hex32(v["serverTestKey"]["seedHex"].as_str().unwrap()));
    assert_eq!(server.pubkey().to_bytes(), hex32(v["serverTestKey"]["pubkeyHex"].as_str().unwrap()));
    let partner = seed(v2["actors"]["partner"]["seedLabel"].as_str().unwrap());
    assert_eq!(partner.pubkey().to_string(), v2["actors"]["partner"]["pubkey"].as_str().unwrap());
    let wallet = seed(v2["actors"]["wallet"]["seedLabel"].as_str().unwrap());
    assert_eq!(wallet.pubkey().to_string(), v2["actors"]["wallet"]["pubkey"].as_str().unwrap());
    assert_eq!(CLUSTER_DEVNET as u64, v2["clusterTag"].as_u64().unwrap());

    let mut env = Env::new(server, partner, CLUSTER_DEVNET, &[]);
    env.set_time(v2["scans"][0]["input"]["ts"].as_i64().unwrap());
    let input0 = &v2["scans"][0]["input"];
    let c0 = &v2["commitments"][0];
    let p = env.mint_v2(input0["serial"].as_str().unwrap(), Some(hex32(c0["commitmentHex"].as_str().unwrap())));
    let uid_hash = env.attach_v2(&p, &hex(input0["uidHex"].as_str().unwrap()));
    let pdas = &v2["pdas"];
    for (name, key) in [
        ("registry", env.registry),
        ("passport", p.passport),
        ("seal", Env::seal_pda(&uid_hash)),
        ("holderConfig", env.holder_config),
        ("holding", p.holding),
        ("eventAuthority", env.event_authority),
    ] {
        assert_eq!(key.to_string(), pdas[name].as_str().unwrap(), "pda {name}");
    }
    assert_eq!(p.passport.to_bytes(), hex32(c0["passportHex"].as_str().unwrap()));

    let mut head = [0u8; 32];
    for (i, s) in v2["scans"].as_array().unwrap().iter().enumerate() {
        let name = s["name"].as_str().unwrap();
        let input = &s["input"];
        let kind = input["actorKind"].as_u64().unwrap() as u8;
        env.set_time(input["ts"].as_i64().unwrap());
        let (actor_signer, asset) = match kind {
            ACTOR_KIND_PARTNER => (Some(env.partner.pubkey()), None),
            ACTOR_KIND_WALLET => (Some(wallet.pubkey()), Some(move_to_wallet(&mut env, &p, &wallet.pubkey()))),
            _ => (None, None),
        };
        let ed = Instruction { program_id: ED25519_ID, accounts: vec![], data: hex(s["ed25519IxHex"].as_str().unwrap()) };
        let ixs = vec![ed, env.record_scan_v2_ix(&p, &uid_hash, 1, actor_signer, asset)];
        let partner = env.partner.insecure_clone();
        let extra: Vec<&Keypair> = match kind {
            ACTOR_KIND_PARTNER => vec![&partner],
            ACTOR_KIND_WALLET => vec![&wallet],
            _ => vec![],
        };
        let relayer_before = env.balance(&env.relayer.pubkey());
        let meta = env.send(ixs, &extra).unwrap_or_else(|e| panic!("{name}: {e}"));
        // the relayer paid the fee and nothing else: no account was created
        assert_eq!(relayer_before - env.balance(&env.relayer.pubkey()), meta.fee, "{name}: fee only");
        assert!(!env.exists(&scan_proof_pda(&uid_hash, input["counter"].as_u64().unwrap() as u32)), "{name}: no ScanProof");

        let msg = hex(s["msgHex"].as_str().unwrap());
        head = fold_scan_head(&head, &msg.clone().try_into().unwrap());
        assert_eq!(head, hex32(s["headAfterHex"].as_str().unwrap()), "{name}: Rust fold = TS fold");
        let passport = env.passport(&p);
        let holding = env.holding(&p);
        assert_eq!(passport.grade as u64, s["gradeAfter"].as_u64().unwrap(), "{name}: grade");
        assert_eq!(passport.void, s["voidAfter"].as_bool().unwrap(), "{name}: void");
        assert_eq!(passport.scan_count, i as u32 + 1, "{name}: scan_count");
        assert_eq!(holding.scan_head, head, "{name}: scan_head");
        assert_eq!(holding.head_count, i as u32 + 1, "{name}: head_count");
        assert_eq!(holding.last_actor_kind, kind);
        assert_eq!(holding.last_actor, hex32(input["actorHex"].as_str().unwrap()));
        assert_eq!(holding.last_purpose as u64, input["purpose"].as_u64().unwrap());
        assert_eq!(holding.last_scan_ts, input["ts"].as_i64().unwrap());
        let seal: Seal = env.account(&Env::seal_pda(&uid_hash));
        assert_eq!(seal.last_counter as u64, input["counter"].as_u64().unwrap());

        let ev = scan_event(&meta, 1);
        assert_eq!(&ev.message[..], &msg[..], "{name}: the event carries the full message");
        assert_eq!((ev.passport, ev.seal, ev.holding), (p.passport, Env::seal_pda(&uid_hash), p.holding));
        assert_eq!((ev.server_key_id, ev.grade, ev.void, ev.scan_count), (1, passport.grade, passport.void, passport.scan_count));
        assert_eq!((ev.scan_head, ev.head_count), (holding.scan_head, holding.head_count));
        println!("{name}: {} compute units", meta.compute_units_consumed);
    }
    assert_eq!(head, hex32(v2["scanHead"]["finalHex"].as_str().unwrap()));
    assert_eq!(env.holding(&p).head_count as u64, v2["scanHead"]["count"].as_u64().unwrap());
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn visitor_scans_are_evidence_only() {
    let mut env = Env::devnet();
    let (p, uid) = env.sealed_pass("SN-LSVM-VISITOR");
    let holder = p.commitment;
    // the holder reports fill 10 → D
    env.record(&p, &uid, &env.check(&p, &uid, 1, 10, ACTOR_KIND_HOLDER, holder));
    assert_eq!((env.passport(&p).grade, env.passport(&p).void), (GRADE_D, false));
    // visitors cannot lift it, lower it, void it or heat-damage it
    env.record(&p, &uid, &env.check(&p, &uid, 2, 95, ACTOR_KIND_NONE, [0u8; 32]));
    let opened = ScanMessageV2 { tamper: TAMPER_OPENED_NOW, ..env.check(&p, &uid, 3, 95, ACTOR_KIND_NONE, [0u8; 32]) };
    env.record(&p, &uid, &opened);
    let heat = ScanMessageV2 { heat: INDICATOR_TRIGGERED, heat_levels: 0b01_0000, ..env.check(&p, &uid, 4, 95, ACTOR_KIND_NONE, [0u8; 32]) };
    env.record(&p, &uid, &heat);
    env.record(&p, &uid, &env.tap(&p, &uid, 5, T0));
    // a RECIPIENT (P3 buyer) is evidence too
    env.record(&p, &uid, &env.check(&p, &uid, 6, 95, ACTOR_KIND_RECIPIENT, sha256(b"next holder")));
    let passport = env.passport(&p);
    assert_eq!((passport.grade, passport.void), (GRADE_D, false));
    assert_eq!(passport.scan_count, 6, "every accepted scan counts");
    let holding = env.holding(&p);
    assert_eq!(holding.head_count, 6, "every accepted scan is folded");
    assert_eq!((holding.last_actor_kind, holding.last_purpose), (ACTOR_KIND_RECIPIENT, PURPOSE_RECEIPT));
    // the holder's next reading counts again
    env.record(&p, &uid, &env.check(&p, &uid, 7, 95, ACTOR_KIND_HOLDER, holder));
    assert_eq!(env.passport(&p).grade, GRADE_A);
    // a holder TAP has no reading: A stays A (FILL_NONE)
    let holder_claim = ScanMessageV2 { purpose: PURPOSE_CLAIM, actor_kind: ACTOR_KIND_HOLDER, actor: holder, ..env.tap(&p, &uid, 8, T0) };
    env.record(&p, &uid, &holder_claim);
    assert_eq!(env.passport(&p).grade, GRADE_A);
    for c in 1..=8 {
        assert!(!env.exists(&scan_proof_pda(&uid, c)), "no ScanProof for counter {c}");
    }
    // the fold over the eight messages, recomputed off chain, equals the account
    let msgs: Vec<ScanMessageV2> = vec![
        env.check(&p, &uid, 1, 10, ACTOR_KIND_HOLDER, holder),
        env.check(&p, &uid, 2, 95, ACTOR_KIND_NONE, [0u8; 32]),
        opened,
        heat,
        env.tap(&p, &uid, 5, T0),
        env.check(&p, &uid, 6, 95, ACTOR_KIND_RECIPIENT, sha256(b"next holder")),
        env.check(&p, &uid, 7, 95, ACTOR_KIND_HOLDER, holder),
        holder_claim,
    ];
    let head = msgs.iter().fold([0u8; 32], |h, m| fold_scan_head(&h, &build_scan_message_v2(m)));
    assert_eq!(env.holding(&p).scan_head, head);
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn freshness_window_is_600_seconds() {
    let mut env = Env::devnet();
    let (p, uid) = env.sealed_pass("SN-LSVM-SKEW");
    let now = T0 + 10_000;
    env.set_time(now);
    for (counter, ts) in [(1, now - 601), (1, now + 601)] {
        let ixs = env.scan_ixs(&p, &uid, &env.tap(&p, &uid, counter, ts));
        env.expect_error(ixs, &[], FlaconError::StaleScanTimestamp);
    }
    env.record(&p, &uid, &env.tap(&p, &uid, 1, now - 600));
    env.record(&p, &uid, &env.tap(&p, &uid, 2, now + 600));
    // a signature that was fresh when it was made expires with the clock (the relayer stops at ts + 570)
    let late = env.tap(&p, &uid, 3, now);
    env.set_time(now + 601);
    let ixs = env.scan_ixs(&p, &uid, &late);
    env.expect_error(ixs, &[], FlaconError::StaleScanTimestamp);
    env.set_time(now + 600);
    env.record(&p, &uid, &late);
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn server_key_must_be_valid_at_ts_and_now() {
    let server = Keypair::new();
    let pk = server.pubkey().to_bytes();
    let keys = [
        // 2: revoked one second before T0 (revoke_server_key sets valid_to = clock − 1)
        ServerKey { key_id: 2, pubkey: pk, valid_from: 0, valid_to: T0 - 1 },
        // 3: expires at T0 + 100
        ServerKey { key_id: 3, pubkey: pk, valid_from: 0, valid_to: T0 + 100 },
        // 4: valid from tomorrow
        ServerKey { key_id: 4, pubkey: pk, valid_from: T0 + 86_400, valid_to: 0 },
    ];
    let mut env = Env::new(server, Keypair::new(), CLUSTER_DEVNET, &keys);
    let (p, uid) = env.sealed_pass("SN-LSVM-KEYS");
    let with_key = |env: &Env, m: &ScanMessageV2, key_id: u8| {
        let msg = build_scan_message_v2(m);
        let sig = env.server.sign_message(&msg);
        vec![ed25519_ix(&env.server.pubkey().to_bytes(), sig.as_ref(), &msg), env.record_scan_v2_ix(&p, &uid, key_id, None, None)]
    };
    // revoked: dated inside its validity, sent after the revocation
    let ixs = with_key(&env, &env.tap(&p, &uid, 1, T0 - 10), 2);
    env.expect_error(ixs, &[], FlaconError::ServerKeyNotValidNow);
    let ixs = with_key(&env, &env.tap(&p, &uid, 1, T0), 2);
    env.expect_error(ixs, &[], FlaconError::ServerKeyNotValidAtTs);
    // not yet valid
    let ixs = with_key(&env, &env.tap(&p, &uid, 1, T0), 4);
    env.expect_error(ixs, &[], FlaconError::ServerKeyNotValidAtTs);
    // unknown key id, and a key that is not the registry's
    let ixs = with_key(&env, &env.tap(&p, &uid, 1, T0), 9);
    env.expect_error(ixs, &[], FlaconError::UnknownServerKey);
    let other = Keypair::new();
    let msg = build_scan_message_v2(&env.tap(&p, &uid, 1, T0));
    let ixs = vec![ed25519_ix(&other.pubkey().to_bytes(), other.sign_message(&msg).as_ref(), &msg), env.record_scan_v2_ix(&p, &uid, 1, None, None)];
    env.expect_error(ixs, &[], FlaconError::ServerKeyMismatch);

    // expiring key 3: signed at T0 + 50; accepted at T0 + 90, refused once the clock passed valid_to
    let m = env.tap(&p, &uid, 1, T0 + 50);
    env.set_time(T0 + 101);
    let ixs = with_key(&env, &m, 3);
    env.expect_error(ixs, &[], FlaconError::ServerKeyNotValidNow);
    env.set_time(T0 + 90);
    let ixs = with_key(&env, &m, 3);
    env.send(ixs, &[]).expect("key 3 inside its validity");
    // signed after valid_to (the clock is still before it): not valid at ts
    let ixs = with_key(&env, &env.tap(&p, &uid, 2, T0 + 150), 3);
    env.expect_error(ixs, &[], FlaconError::ServerKeyNotValidAtTs);
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn message_domain_counter_and_ed25519_placement() {
    let mut env = Env::devnet();
    let (p, uid) = env.sealed_pass("SN-LSVM-DOMAIN");
    let (q, uid_q) = env.sealed_pass("SN-LSVM-OTHER");
    let tap = env.tap(&p, &uid, 1, T0);
    // another cluster (the HolderConfig says DEVNET), another program id, an FVSCAN1 message padded to 256 bytes
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { cluster_tag: CLUSTER_LOCALNET, ..tap.clone() });
    env.expect_error(ixs, &[], FlaconError::WrongCluster);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { cluster_tag: CLUSTER_MAINNET, ..tap.clone() });
    env.expect_error(ixs, &[], FlaconError::WrongCluster);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { program_id: Pubkey::new_unique().to_bytes(), ..tap.clone() });
    env.expect_error(ixs, &[], FlaconError::WrongProgramId);
    let mut v1 = build_scan_message_v2(&tap);
    v1[..7].copy_from_slice(MSG_PREFIX);
    let sig = env.server.sign_message(&v1);
    let ixs = vec![ed25519_ix(&env.server.pubkey().to_bytes(), sig.as_ref(), &v1), env.record_scan_v2_ix(&p, &uid, 1, None, None)];
    env.expect_error(ixs, &[], FlaconError::InvalidMessagePrefix);
    // a v1-sized (152-byte) signed message is no FVSCAN2 instruction
    let short = &build_scan_message_v2(&tap)[..MSG_LEN_BYTES];
    let sig = env.server.sign_message(short);
    let ixs = vec![ed25519_ix(&env.server.pubkey().to_bytes(), sig.as_ref(), short), env.record_scan_v2_ix(&p, &uid, 1, None, None)];
    env.expect_error(ixs, &[], FlaconError::MalformedEd25519Instruction);
    // the Ed25519 instruction must sit right before record_scan_v2
    let ixs = env.scan_ixs(&p, &uid, &tap);
    env.expect_error(vec![ixs[1].clone()], &[], FlaconError::MissingEd25519Instruction);
    let budget = Instruction { program_id: COMPUTE_BUDGET_ID, accounts: vec![], data: [vec![2u8], 200_000u32.to_le_bytes().to_vec()].concat() };
    env.expect_error(vec![ixs[0].clone(), budget.clone(), ixs[1].clone()], &[], FlaconError::MissingEd25519Instruction);
    // a tampered signature fails in the precompile, before the program runs
    let mut bad = ixs[0].clone();
    bad.data[60] ^= 1;
    assert!(env.send(vec![bad, ixs[1].clone()], &[]).is_err());
    // the message must name this passport and this seal
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { serial_hash: q.serial_hash, ..tap.clone() });
    env.expect_error(ixs, &[], FlaconError::MessageMismatch);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { uid_hash: uid_q, ..tap.clone() });
    env.expect_error(ixs, &[], FlaconError::MessageMismatch);
    // q's seal on p's passport (message bound to p's serial and q's seal)
    let ixs = env.scan_ixs(&p, &uid_q, &env.tap(&p, &uid_q, 1, T0));
    env.expect_error(ixs, &[], FlaconError::SealPassportMismatch);

    // [budget, ed25519, record_scan_v2] is the relayer's shape: accepted
    let ixs = env.scan_ixs(&p, &uid, &tap);
    let meta = env.send(vec![budget, ixs[0].clone(), ixs[1].clone()], &[]).expect("relay shape");
    assert_eq!(scan_event(&meta, 2).message, build_scan_message_v2(&tap));
    // counters: a replay, an older one and one above the 24-bit range
    let ixs = env.scan_ixs(&p, &uid, &env.tap(&p, &uid, 1, T0));
    env.expect_error(ixs, &[], FlaconError::CounterNotIncreasing);
    env.record(&p, &uid, &env.tap(&p, &uid, 5, T0));
    let ixs = env.scan_ixs(&p, &uid, &env.tap(&p, &uid, 4, T0));
    env.expect_error(ixs, &[], FlaconError::CounterNotIncreasing);
    let ixs = env.scan_ixs(&p, &uid, &env.tap(&p, &uid, MAX_COUNTER + 1, T0));
    env.expect_error(ixs, &[], FlaconError::CounterOutOfRange);
    env.record(&p, &uid, &env.tap(&p, &uid, MAX_COUNTER, T0));
    assert_eq!(env.account::<Seal>(&Env::seal_pda(&uid)).last_counter, MAX_COUNTER);

    // a dead seal takes no scan, and its passport is void
    let mark = Instruction {
        program_id: flacon::ID,
        accounts: flacon::accounts::MarkSealDead { registry: env.registry, passport: q.passport, seal: Env::seal_pda(&uid_q), signer: env.partner.pubkey() }
            .to_account_metas(None),
        data: flacon::instruction::MarkSealDead {}.data(),
    };
    let partner = env.partner.insecure_clone();
    env.send(vec![mark], &[&partner]).expect("mark_seal_dead");
    let ixs = env.scan_ixs(&q, &uid_q, &env.tap(&q, &uid_q, 1, T0));
    env.expect_error(ixs, &[], FlaconError::SealDead);
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn field_and_actor_rules_on_chain() {
    let mut env = Env::devnet();
    let (p, uid) = env.sealed_pass("SN-LSVM-ACTORS");
    let check = env.check(&p, &uid, 1, 95, ACTOR_KIND_NONE, [0u8; 32]);
    // visitors: no certified tier, no RECEIPT, nothing that is not a clean sighting at tier 0
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { tier: TIER_CERTIFIED, role: ROLE_VAULT, ..check.clone() });
    env.expect_error(ixs, &[], FlaconError::NotPartner);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { purpose: PURPOSE_RECEIPT, ..check.clone() });
    env.expect_error(ixs, &[], FlaconError::PurposeNotAllowed);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { fill: 50, ..env.tap(&p, &uid, 1, T0) });
    env.expect_error(ixs, &[], FlaconError::InvalidSighting);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { media_hash: [1u8; 32], ..env.tap(&p, &uid, 1, T0) });
    env.expect_error(ixs, &[], FlaconError::InvalidSighting);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { fill: FILL_NONE, ..check.clone() });
    env.expect_error(ixs, &[], FlaconError::InvalidSighting);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { actor: [1u8; 32], ..check.clone() });
    env.expect_error(ixs, &[], FlaconError::ActorMismatch);
    let ixs = env.scan_ixs(&p, &uid, &ScanMessageV2 { site_id: 1, ..check.clone() });
    env.expect_error(ixs, &[], FlaconError::SiteIdNotAllowed);

    // HOLDER: the current commitment only; RECIPIENT: never the current one
    let ixs = env.scan_ixs(&p, &uid, &env.check(&p, &uid, 1, 70, ACTOR_KIND_HOLDER, sha256(b"someone else")));
    env.expect_error(ixs, &[], FlaconError::ActorMismatch);
    let ixs = env.scan_ixs(&p, &uid, &env.check(&p, &uid, 1, 70, ACTOR_KIND_RECIPIENT, p.commitment));
    env.expect_error(ixs, &[], FlaconError::ActorMismatch);
    env.record(&p, &uid, &env.check(&p, &uid, 1, 70, ACTOR_KIND_HOLDER, p.commitment));
    assert_eq!(env.passport(&p).grade, GRADE_B);

    // PARTNER: a co-signed BIRTH at tier 4 with a registered site; without the co-signer, or by a non-partner, refused
    let birth = ScanMessageV2 {
        tier: TIER_BIRTH, role: ROLE_PARTNER, purpose: PURPOSE_BIRTH, site_id: 1, fill: 100, actor_kind: ACTOR_KIND_PARTNER,
        actor: env.partner.pubkey().to_bytes(), media_hash: [3u8; 32], ..env.check(&p, &uid, 2, 100, ACTOR_KIND_PARTNER, [0u8; 32])
    };
    let partner_ixs = |env: &Env, m: &ScanMessageV2, signer: Option<Pubkey>| {
        let mut ixs = env.scan_ixs(&p, &uid, m);
        ixs[1] = env.record_scan_v2_ix(&p, &uid, 1, signer, None);
        ixs
    };
    let ixs = partner_ixs(&env, &birth, None);
    env.expect_error(ixs, &[], FlaconError::MissingActorSigner);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ixs = partner_ixs(&env, &birth, Some(stranger.pubkey()));
    env.expect_error(ixs, &[&stranger], FlaconError::ActorMismatch);
    let ixs = partner_ixs(&env, &ScanMessageV2 { actor: stranger.pubkey().to_bytes(), ..birth.clone() }, Some(stranger.pubkey()));
    env.expect_error(ixs, &[&stranger], FlaconError::NotPartner);
    let ixs = partner_ixs(&env, &ScanMessageV2 { site_id: 7, ..birth.clone() }, Some(env.partner.pubkey()));
    let partner = env.partner.insecure_clone();
    env.expect_error(ixs, &[&partner], FlaconError::UnknownSite);
    let ixs = partner_ixs(&env, &birth, Some(env.partner.pubkey()));
    env.send(ixs, &[&partner]).expect("partner BIRTH");
    assert_eq!(env.passport(&p).grade, GRADE_A);

    // WALLET: the owner of the Core asset at passport.asset co-signs
    let wallet = Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
    let wallet_check = |env: &Env, counter: u32, fill: u8, actor: &Pubkey| env.check(&p, &uid, counter, fill, ACTOR_KIND_WALLET, actor.to_bytes());
    let wallet_ixs = |env: &Env, m: &ScanMessageV2, signer: Option<Pubkey>, asset: Option<Pubkey>| {
        let mut ixs = env.scan_ixs(&p, &uid, m);
        ixs[1] = env.record_scan_v2_ix(&p, &uid, 1, signer, asset);
        ixs
    };
    // still held in the account: the Holding is no Core asset
    let ixs = wallet_ixs(&env, &wallet_check(&env, 3, 70, &wallet.pubkey()), Some(wallet.pubkey()), Some(p.holding));
    env.expect_error(ixs, &[&wallet], FlaconError::NotAssetOwner);
    let asset = move_to_wallet(&mut env, &p, &wallet.pubkey());
    // HOLDER / RECIPIENT scans need the pass in an account
    let ixs = env.scan_ixs(&p, &uid, &env.check(&p, &uid, 3, 70, ACTOR_KIND_HOLDER, p.commitment));
    env.expect_error(ixs, &[], FlaconError::HoldingNotInAccount);
    let ixs = env.scan_ixs(&p, &uid, &env.check(&p, &uid, 3, 70, ACTOR_KIND_RECIPIENT, sha256(b"buyer")));
    env.expect_error(ixs, &[], FlaconError::HoldingNotInAccount);
    let ixs = wallet_ixs(&env, &wallet_check(&env, 3, 70, &wallet.pubkey()), None, Some(asset));
    env.expect_error(ixs, &[], FlaconError::MissingActorSigner);
    let ixs = wallet_ixs(&env, &wallet_check(&env, 3, 70, &wallet.pubkey()), Some(wallet.pubkey()), None);
    env.expect_error(ixs, &[&wallet], FlaconError::AssetMismatch);
    let ixs = wallet_ixs(&env, &wallet_check(&env, 3, 70, &wallet.pubkey()), Some(wallet.pubkey()), Some(Pubkey::new_unique()));
    env.expect_error(ixs, &[&wallet], FlaconError::AssetMismatch);
    let ixs = wallet_ixs(&env, &wallet_check(&env, 3, 70, &stranger.pubkey()), Some(stranger.pubkey()), Some(asset));
    env.expect_error(ixs, &[&stranger], FlaconError::NotAssetOwner);
    let ixs = wallet_ixs(&env, &wallet_check(&env, 3, 70, &wallet.pubkey()), Some(wallet.pubkey()), Some(asset));
    env.send(ixs, &[&wallet]).expect("wallet scan");
    assert_eq!(env.passport(&p).grade, GRADE_B);
    assert_eq!(env.holding(&p).head_count, 3);
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn setup_instructions() {
    let mut env = Env::devnet();
    let admin = env.admin.insecure_clone();
    let partner = env.partner.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    // init_holder_config: done by Env::new (DEVNET, defaults); never twice, never by a stranger, never tag 0 / 4
    let c: HolderConfig = env.account(&env.holder_config);
    assert_eq!((c.authority, c.cluster_tag, c.paused, c.last_heartbeat), (admin.pubkey(), CLUSTER_DEVNET, false, 0));
    assert_eq!((c.claim_delay_s, c.notap_delay_s), (DEFAULT_CLAIM_DELAY_S, DEFAULT_NOTAP_DELAY_S));
    assert!(env.send(vec![env.init_holder_config_ix(CLUSTER_MAINNET, &admin.pubkey())], &[&admin]).is_err(), "second init");
    let mut fresh = Env::devnet();
    let fresh_admin = fresh.admin.insecure_clone();
    let _ = fresh.svm.set_account(fresh.holder_config, Account::default());
    for tag in [0u8, 4] {
        let ix = fresh.init_holder_config_ix(tag, &fresh_admin.pubkey());
        fresh.expect_error(vec![ix], &[&fresh_admin], FlaconError::InvalidClusterTag);
    }
    fresh.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = fresh.init_holder_config_ix(CLUSTER_DEVNET, &stranger.pubkey());
    fresh.expect_error(vec![ix], &[&stranger], FlaconError::Unauthorized);

    // set_holder_config: authority only, delays 1 day ..= 30 days, cluster_tag and authority unchanged
    let ix = env.set_holder_config_ix(&stranger.pubkey(), Pubkey::default(), DEFAULT_CLAIM_DELAY_S, DEFAULT_NOTAP_DELAY_S);
    env.expect_error(vec![ix], &[&stranger], FlaconError::Unauthorized);
    for (claim, notap) in [(MIN_HOLD_DELAY_S - 1, DEFAULT_NOTAP_DELAY_S), (DEFAULT_CLAIM_DELAY_S, MAX_HOLD_DELAY_S + 1)] {
        let ix = env.set_holder_config_ix(&admin.pubkey(), Pubkey::default(), claim, notap);
        env.expect_error(vec![ix], &[&admin], FlaconError::InvalidDelay);
    }
    let guardian = Pubkey::new_unique();
    let ix = env.set_holder_config_ix(&admin.pubkey(), guardian, MIN_HOLD_DELAY_S, MAX_HOLD_DELAY_S);
    env.send(vec![ix], &[&admin]).expect("set_holder_config");
    let c: HolderConfig = env.account(&env.holder_config);
    assert_eq!((c.guardian, c.holder_key, c.registrar_key), (guardian, Pubkey::new_from_array([7u8; 32]), Pubkey::new_from_array([8u8; 32])));
    assert_eq!((c.claim_delay_s, c.notap_delay_s, c.cluster_tag, c.authority), (MIN_HOLD_DELAY_S, MAX_HOLD_DELAY_S, CLUSTER_DEVNET, admin.pubkey()));

    // mint_passport_v2: a partner signs, the relayer pays; asset = Holding, epoch 0, state ACCOUNT
    let serial_hash = sha256(b"SN-LSVM-MINT");
    let ix = env.mint_v2_ix(serial_hash, [1u8; 32], &stranger.pubkey());
    env.expect_error(vec![ix], &[&stranger], FlaconError::NotPartner);
    let ix = env.mint_v2_ix(serial_hash, [0u8; 32], &partner.pubkey());
    env.expect_error(vec![ix], &[&partner], FlaconError::InvalidCommitment);
    let (partner_before, relayer_before) = (env.balance(&partner.pubkey()), env.balance(&env.relayer.pubkey()));
    let ix = env.mint_v2_ix(serial_hash, [1u8; 32], &partner.pubkey());
    env.send(vec![ix], &[&partner]).expect("mint_passport_v2");
    assert_eq!(env.balance(&partner.pubkey()), partner_before, "the issuer pays nothing");
    let rent = env.svm.minimum_balance_for_rent_exemption(8 + Passport::INIT_SPACE) + env.svm.minimum_balance_for_rent_exemption(8 + Holding::INIT_SPACE);
    assert!(relayer_before - env.balance(&env.relayer.pubkey()) >= rent, "the payer pays the rent");
    let (passport_key, holding_key) = Env::pdas(&serial_hash);
    let passport: Passport = env.account(&passport_key);
    let holding: Holding = env.account(&holding_key);
    assert_eq!(passport.asset, holding_key);
    assert_eq!((passport.issuer, passport.grade, passport.scan_count, passport.seal_count, passport.void), (partner.pubkey(), GRADE_A, 0, 0, false));
    assert_eq!((holding.passport, holding.state, holding.epoch, holding.commitment), (passport_key, HOLDING_STATE_ACCOUNT, 0, [1u8; 32]));
    assert_eq!((holding.scan_head, holding.head_count, holding.last_scan_ts, holding.pending_kind, holding.unlock_at), ([0u8; 32], 0, 0, 0, 0));
    let p = Pass { serial_hash, passport: passport_key, holding: holding_key, commitment: [1u8; 32] };
    // a second mint of the same serial fails (the passport exists), and so does init_holding_v1 on it (the Holding exists)
    assert!(env.send(vec![env.mint_v2_ix(serial_hash, [2u8; 32], &partner.pubkey())], &[&partner]).is_err());

    // attach_seal_v2: the issuer (while a partner) or the authority; the payer pays
    let uid_hash = sha256(b"uid-mint");
    let ix = env.attach_v2_ix(&p, uid_hash, SEAL_KIND_NECK, &stranger.pubkey());
    env.expect_error(vec![ix], &[&stranger], FlaconError::NotIssuerOrAuthority);
    let ix = env.attach_v2_ix(&p, uid_hash, 2, &partner.pubkey());
    env.expect_error(vec![ix], &[&partner], FlaconError::InvalidSealKind);
    let partner_before = env.balance(&partner.pubkey());
    let ix = env.attach_v2_ix(&p, uid_hash, SEAL_KIND_NECK, &partner.pubkey());
    env.send(vec![ix], &[&partner]).expect("attach_seal_v2");
    assert_eq!(env.balance(&partner.pubkey()), partner_before);
    let ix = env.attach_v2_ix(&p, sha256(b"uid-box"), SEAL_KIND_BOX, &admin.pubkey());
    env.send(vec![ix], &[&admin]).expect("attach_seal_v2 by the authority");
    let ix = env.attach_v2_ix(&p, sha256(b"uid-third"), SEAL_KIND_BOX, &partner.pubkey());
    env.expect_error(vec![ix], &[&partner], FlaconError::TooManySeals);
    let seal: Seal = env.account(&Env::seal_pda(&uid_hash));
    assert_eq!((seal.passport, seal.kind, seal.uid_hash, seal.last_counter, seal.dead), (passport_key, SEAL_KIND_NECK, uid_hash, 0, false));
    assert_eq!(env.passport(&p).seal_count, 2);

    // init_holding_v1: the Holding of a v1 passport (written as mint_passport would), state WALLET. The registry
    // authority or a registered partner signs (the check mint_passport applies to its issuer), a separate payer pays.
    let v1_passport = |env: &mut Env, serial: &str| {
        let serial_hash = sha256(serial.as_bytes());
        let (passport, bump) = Pubkey::find_program_address(&[PASSPORT_SEED, &serial_hash], &flacon::ID);
        let v1 = Passport {
            serial_hash, binding_hash: [0u8; 32], asset: Pubkey::new_unique(), issuer: partner.pubkey(), grade: GRADE_A,
            scan_count: 3, seal_count: 1, void: false, created_at: T0 - 86_400, bump,
        };
        let acc = anchor_account(&env.svm, &v1, 8 + Passport::INIT_SPACE);
        env.svm.set_account(passport, acc).unwrap();
        (passport, Pubkey::find_program_address(&[HOLDING_SEED, passport.as_ref()], &flacon::ID).0, v1.asset)
    };
    let (v1, v1_holding, v1_asset) = v1_passport(&mut env, "SN-LSVM-V1");
    let (by_admin, by_admin_holding, _) = v1_passport(&mut env, "SN-LSVM-V1-ADMIN");
    let (by_former, by_former_holding, _) = v1_passport(&mut env, "SN-LSVM-V1-FORMER");
    let relayer = env.relayer.pubkey();
    // neither the authority nor a partner
    let ix = env.init_holding_v1_ix(v1, &stranger.pubkey(), &relayer);
    env.expect_error(vec![ix], &[&stranger], FlaconError::Unauthorized);
    assert!(!env.exists(&v1_holding));
    // a partner signs, the relayer pays the rent
    let partner_before = env.balance(&partner.pubkey());
    let ix = env.init_holding_v1_ix(v1, &partner.pubkey(), &relayer);
    env.send(vec![ix], &[&partner]).expect("init_holding_v1 by a partner");
    assert_eq!(env.balance(&partner.pubkey()), partner_before, "the partner pays nothing");
    let h: Holding = env.account(&v1_holding);
    assert_eq!((h.passport, h.state, h.epoch, h.commitment, h.head_count), (v1, HOLDING_STATE_WALLET, 0, [0u8; 32], 0));
    assert_eq!((h.scan_head, h.last_scan_ts, h.pending_kind, h.unlock_at), ([0u8; 32], 0, 0, 0));
    // the registry authority
    let ix = env.init_holding_v1_ix(by_admin, &admin.pubkey(), &relayer);
    env.send(vec![ix], &[&admin]).expect("init_holding_v1 by the authority");
    assert_eq!(env.account::<Holding>(&by_admin_holding).state, HOLDING_STATE_WALLET);
    // the registry's current partner list decides, as for mint_passport: a removed partner is out
    let former = Keypair::new();
    let ix = env.partner_ix(former.pubkey(), true);
    env.send(vec![ix], &[&admin]).expect("add_partner");
    let ix = env.partner_ix(former.pubkey(), false);
    env.send(vec![ix], &[&admin]).expect("remove_partner");
    let ix = env.init_holding_v1_ix(by_former, &former.pubkey(), &relayer);
    env.expect_error(vec![ix], &[&former], FlaconError::Unauthorized);
    assert!(!env.exists(&by_former_holding));
    // once per passport, whoever signs; never for a v2 passport (mint_passport_v2 created its Holding)
    assert!(env.send(vec![env.init_holding_v1_ix(v1, &admin.pubkey(), &relayer)], &[&admin]).is_err(), "only once");
    assert!(env.send(vec![env.init_holding_v1_ix(v1, &partner.pubkey(), &relayer)], &[&partner]).is_err(), "only once");
    assert!(env.send(vec![env.init_holding_v1_ix(passport_key, &partner.pubkey(), &relayer)], &[&partner]).is_err(), "a v2 passport has its Holding");
    // the v1 passport is untouched
    let after: Passport = env.account(&v1);
    assert_eq!((after.asset, after.scan_count), (v1_asset, 3));
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn v1_mint_with_init_holding_takes_relay_scans() {
    // Every v1 mint path (the partner console, scripts/bind-chip.ts, scripts/seed-passports.ts) sends
    // [mint_passport, init_holding_v1] in one transaction, signed by the partner wallet that also pays, so a bottle
    // minted after the public-record rollout takes relay scans at once. Without its Holding no record_scan_v2 lands.
    let mut env = Env::devnet();
    let partner = env.partner.insecure_clone();
    let me = partner.pubkey();
    let mint_v1 = |env: &mut Env, serial: &str, with_holding: bool| -> (Pass, [u8; 32]) {
        let serial_hash = sha256(serial.as_bytes());
        let (passport, holding) = Env::pdas(&serial_hash);
        let asset = fake_core_asset(env, &me);
        let mut ixs = vec![env.mint_v1_ix(serial_hash, asset, &me)];
        if with_holding {
            ixs.push(env.init_holding_v1_ix(passport, &me, &me));
        }
        env.send(ixs, &[&partner]).unwrap_or_else(|e| panic!("mint {serial}: {e}"));
        let uid_hash = sha256(format!("uid:{serial}").as_bytes());
        let ix = env.attach_v1_ix(passport, uid_hash, SEAL_KIND_NECK, &me);
        env.send(vec![ix], &[&partner]).expect("attach_seal");
        (Pass { serial_hash, passport, holding, commitment: [0u8; 32] }, uid_hash)
    };

    // mint_passport + init_holding_v1 in one transaction: a WALLET Holding next to the Core asset
    let (p, uid) = mint_v1(&mut env, "SN-LSVM-V1-MINT", true);
    let passport = env.passport(&p);
    let h = env.holding(&p);
    assert_eq!((h.passport, h.state, h.head_count, h.commitment), (p.passport, HOLDING_STATE_WALLET, 0, [0u8; 32]));
    assert_eq!((passport.issuer, passport.seal_count, passport.scan_count), (me, 1, 0));
    assert_ne!(passport.asset, p.holding, "a v1 pass keeps its Core asset");
    // a visitor TAP sent by the relayer (in no instruction) is recorded and folded
    let tap = env.tap(&p, &uid, 1, T0);
    env.record(&p, &uid, &tap);
    let h = env.holding(&p);
    assert_eq!((h.head_count, h.scan_head), (1, fold_scan_head(&[0u8; 32], &build_scan_message_v2(&tap))));
    assert_eq!((h.last_actor_kind, h.last_purpose, h.last_scan_ts), (ACTOR_KIND_NONE, PURPOSE_TAP, T0));
    assert_eq!(env.passport(&p).scan_count, 1);

    // mint_passport alone (the mint paths before this fix): the Holding is missing and no relay scan can land
    let (q, uid_q) = mint_v1(&mut env, "SN-LSVM-V1-NOHOLDING", false);
    assert!(!env.exists(&q.holding));
    let ixs = env.scan_ixs(&q, &uid_q, &env.tap(&q, &uid_q, 1, T0));
    let not_initialized = anchor_lang::error::ErrorCode::AccountNotInitialized as u32;
    match env.send(ixs, &[]) {
        Ok(_) => panic!("record_scan_v2 without a Holding succeeded"),
        Err(got) => assert!(got.contains(&format!("InstructionError(1, Custom({not_initialized}))")), "expected AccountNotInitialized, got {got}"),
    }
    // the mint paths' recovery (the passport exists, its Holding does not): init_holding_v1 alone, then the scan lands
    let ix = env.init_holding_v1_ix(q.passport, &me, &me);
    env.send(vec![ix], &[&partner]).expect("init_holding_v1 alone");
    env.record(&q, &uid_q, &env.tap(&q, &uid_q, 1, T0));
    assert_eq!(env.holding(&q).head_count, 1);
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn set_holder_config_follows_the_registry_authority() {
    let mut env = Env::devnet();
    let old = env.admin.insecure_clone();
    let new = Keypair::new();
    env.svm.airdrop(&new.pubkey(), 1_000_000_000).unwrap();
    let ix = env.transfer_authority_ix(&old.pubkey(), &new.pubkey());
    env.send(vec![ix], &[&old, &new]).expect("transfer_authority");
    assert_eq!(env.account::<Registry>(&env.registry).authority, new.pubkey());
    // the HolderConfig still holds the old key until the next set: that copy never decides anything
    assert_eq!(env.account::<HolderConfig>(&env.holder_config).authority, old.pubkey());

    // the old authority is out (a leaked key cannot take holder_key / registrar_key / guardian), the new one is in
    let ix = env.set_holder_config_ix(&old.pubkey(), Pubkey::new_unique(), DEFAULT_CLAIM_DELAY_S, DEFAULT_NOTAP_DELAY_S);
    env.expect_error(vec![ix], &[&old], FlaconError::Unauthorized);
    let guardian = Pubkey::new_unique();
    let ix = env.set_holder_config_ix(&new.pubkey(), guardian, DEFAULT_CLAIM_DELAY_S, DEFAULT_NOTAP_DELAY_S);
    env.send(vec![ix], &[&new]).expect("set_holder_config by the new authority");
    let c: HolderConfig = env.account(&env.holder_config);
    assert_eq!((c.authority, c.guardian, c.cluster_tag), (new.pubkey(), guardian, CLUSTER_DEVNET), "authority re-synced");

    // another account at the registry position is refused (seeds), with or without the registry's own data
    let mut ix = env.set_holder_config_ix(&new.pubkey(), guardian, DEFAULT_CLAIM_DELAY_S, DEFAULT_NOTAP_DELAY_S);
    ix.accounts[2].pubkey = env.holder_config;
    assert!(env.send(vec![ix], &[&new]).is_err(), "registry must be the registry PDA");
}

#[test]
#[ignore = "needs an SBPF v2 build of flacon: run scripts/test-flacon-litesvm.sh"]
fn record_scan_v2_refuses_to_run_as_a_cpi() {
    let mut env = Env::devnet();
    let (p, uid) = env.sealed_pass("SN-LSVM-CPI");
    let tap = env.tap(&p, &uid, 1, T0);
    let ixs = env.scan_ixs(&p, &uid, &tap);
    // [Ed25519, wrapper(record_scan_v2's exact accounts and data)]: record_scan_v2 runs as the wrapper's inner instruction
    let wrapped = Instruction { program_id: CPI_FORWARDER_ID, accounts: ixs[1].accounts.clone(), data: ixs[1].data.clone() };
    assert!(wrapped.accounts.iter().any(|a| a.pubkey == flacon::ID), "the callee is among the wrapper's accounts");
    let seal_before: Seal = env.account(&Env::seal_pda(&uid));
    match env.send(vec![ixs[0].clone(), wrapped], &[]) {
        Ok(_) => panic!("record_scan_v2 ran as a CPI"),
        Err(got) => assert!(
            got.contains(&format!("InstructionError(1, Custom({}))", code(FlaconError::CpiNotAllowed))),
            "expected CpiNotAllowed at instruction 1, got {got}"
        ),
    }
    let holding = env.holding(&p);
    assert_eq!(env.account::<Seal>(&Env::seal_pda(&uid)).last_counter, seal_before.last_counter);
    assert_eq!(env.passport(&p).scan_count, 0);
    assert_eq!((holding.scan_head, holding.head_count), ([0u8; 32], 0));
    // the same scan at the top level is accepted: the CPI was the only thing that stopped it
    let meta = env.send(ixs, &[]).expect("top-level record_scan_v2");
    assert_eq!(scan_event(&meta, 1).message, build_scan_message_v2(&tap));
    assert_eq!(env.holding(&p).head_count, 1);
    assert_eq!(TRANSACTION_LEVEL_STACK_HEIGHT, 1, "transaction-level instructions run at stack height 1");
}
