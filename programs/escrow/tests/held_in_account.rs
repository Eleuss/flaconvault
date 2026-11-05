//! `PassHeldInAccount` (docs/public-record.md §7.9): a pass minted with flacon `mint_passport_v2` is held in a
//! FlaconVault account (`passport.asset` is its flacon `Holding` PDA, no Core asset). Without the guard,
//! `core_asset_owner` returns `None` for the Holding and the issuer rule would let the issuer sell a pass that belongs
//! to an account holder. Both `list` and `reserve` (through `check_seller_of`) refuse it.
//!
//! `tests/escrow.ts` shows `list` refusing a real `mint_passport_v2` pass on the local validator; `reserve` needs an
//! order, which `list` can no longer create for such a pass, so this LiteSVM test writes the accounts straight into
//! the SVM: flacon registry, a v2 passport and its Holding (owned by the flacon program), the escrow config, a LISTED
//! order, the buyer's USDC account. A v1 passport without a Core asset is the control case: its issuer may still list.
//!
//! Needs the SBPF v2 build of escrow from scripts/test-escrow-time-travel.sh (see tests/time_travel.rs); the tests
//! are `#[ignore]`d so a plain `cargo test` skips them visibly. `FV_ESCROW_SO` points them at another build.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{prelude::*, solana_program::program_pack::Pack, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use escrow::{constants::*, EscrowConfig, EscrowError, Order};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PRICE: u64 = 480_000_000;
const T0: i64 = 1_790_000_000;

fn program_so() -> String {
    let path = std::env::var("FV_ESCROW_SO")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/sbf-v2/escrow.so").to_string());
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} is missing: run scripts/test-escrow-time-travel.sh (builds it for SBPF v2, see tests/time_travel.rs)"
    );
    path
}

fn code(e: EscrowError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

fn anchor_account<T: AccountSerialize>(svm: &LiteSVM, value: &T, owner: Pubkey, space: usize) -> Account {
    let mut data = Vec::with_capacity(space);
    value.try_serialize(&mut data).expect("serialize");
    data.resize(space, 0);
    Account { lamports: svm.minimum_balance_for_rent_exemption(space), data, owner, executable: false, rent_epoch: 0 }
}

fn packed<T: Pack>(svm: &LiteSVM, value: T) -> Account {
    let mut data = vec![0u8; T::LEN];
    value.pack_into_slice(&mut data);
    Account { lamports: svm.minimum_balance_for_rent_exemption(data.len()), data, owner: spl_token::ID, executable: false, rent_epoch: 0 }
}

struct Env {
    svm: LiteSVM,
    issuer: Keypair,
    buyer: Keypair,
    config: Pubkey,
    registry: Pubkey,
    mint: Pubkey,
    buyer_token: Pubkey,
}

/// Stands in for sha256(serial): the escrow only needs a passport PDA, not a real serial hash.
fn serial_hash(serial: &[u8]) -> [u8; 32] {
    let mut h = [0u8; 32];
    h[..serial.len()].copy_from_slice(serial);
    h
}

/// A passport (owner flacon) whose `asset` is `asset`; returns its address.
fn write_passport(env: &mut Env, serial: &[u8], asset: Pubkey) -> Pubkey {
    let serial_hash = serial_hash(serial);
    let (passport, bump) = Pubkey::find_program_address(&[flacon::PASSPORT_SEED, &serial_hash], &flacon::ID);
    let p = flacon::Passport {
        serial_hash,
        binding_hash: [0u8; 32],
        asset,
        issuer: env.issuer.pubkey(),
        grade: flacon::GRADE_A,
        scan_count: 0,
        seal_count: 1,
        void: false,
        created_at: T0,
        bump,
    };
    let acc = anchor_account(&env.svm, &p, flacon::ID, 8 + flacon::Passport::INIT_SPACE);
    env.svm.set_account(passport, acc).unwrap();
    passport
}

/// A pass held in an account, as `mint_passport_v2` leaves it: passport + Holding, `passport.asset` = the Holding.
fn write_v2_pass(env: &mut Env, serial: &[u8]) -> (Pubkey, Pubkey) {
    let passport = Pubkey::find_program_address(&[flacon::PASSPORT_SEED, &serial_hash(serial)], &flacon::ID).0;
    let (holding, bump) = Pubkey::find_program_address(&[flacon::HOLDING_SEED, passport.as_ref()], &flacon::ID);
    write_passport(env, serial, holding);
    let h = flacon::Holding {
        passport,
        state: flacon::HOLDING_STATE_ACCOUNT,
        epoch: 0,
        commitment: [7u8; 32],
        scan_head: [0u8; 32],
        head_count: 0,
        last_actor_kind: 0,
        last_actor: [0u8; 32],
        last_purpose: 0,
        last_scan_ts: 0,
        pending_kind: 0,
        pending_target: [0u8; 32],
        unlock_at: 0,
        bump,
        reserved: [0u8; 32],
    };
    let acc = anchor_account(&env.svm, &h, flacon::ID, 8 + flacon::Holding::INIT_SPACE);
    env.svm.set_account(holding, acc).unwrap();
    (passport, holding)
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(escrow::ID, program_so()).expect("load escrow.so");
    let (issuer, buyer) = (Keypair::new(), Keypair::new());
    svm.airdrop(&issuer.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&buyer.pubkey(), 10_000_000_000).unwrap();

    let (registry, bump) = Pubkey::find_program_address(&[flacon::REGISTRY_SEED], &flacon::ID);
    let reg = flacon::Registry { authority: Pubkey::new_unique(), server_keys: vec![], partners: vec![issuer.pubkey()], sites: vec![], bump };
    let acc = anchor_account(&svm, &reg, flacon::ID, 8 + flacon::Registry::INIT_SPACE);
    svm.set_account(registry, acc).unwrap();

    let mint = Pubkey::new_unique();
    let m = spl_token::state::Mint { mint_authority: Some(Pubkey::new_unique()).into(), supply: PRICE, decimals: 6, is_initialized: true, ..Default::default() };
    let acc = packed(&svm, m);
    svm.set_account(mint, acc).unwrap();
    let (config, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], &escrow::ID);
    let cfg = EscrowConfig { admin: Pubkey::new_unique(), usdc_mint: mint, dispute_after_s: 7 * 86_400, bump: config_bump };
    let acc = anchor_account(&svm, &cfg, escrow::ID, 8 + EscrowConfig::INIT_SPACE);
    svm.set_account(config, acc).unwrap();
    let buyer_token = Pubkey::new_unique();
    let t = spl_token::state::Account { mint, owner: buyer.pubkey(), amount: PRICE, state: spl_token::state::AccountState::Initialized, ..Default::default() };
    let acc = packed(&svm, t);
    svm.set_account(buyer_token, acc).unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = T0;
    svm.set_sysvar(&clock);
    Env { svm, issuer, buyer, config, registry, mint, buyer_token }
}

impl Env {
    fn send(&mut self, ix: Instruction, payer: &Keypair) -> std::result::Result<(), String> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn list_ix(&self, passport: Pubkey, asset: Pubkey) -> Instruction {
        let order = Pubkey::find_program_address(&[ORDER_SEED, passport.as_ref(), self.issuer.pubkey().as_ref()], &escrow::ID).0;
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::List {
                config: self.config,
                passport,
                order,
                seller: self.issuer.pubkey(),
                system_program: anchor_lang::system_program::ID,
                asset,
                registry: self.registry,
            }
            .to_account_metas(None),
            data: escrow::instruction::List { price: PRICE }.data(),
        }
    }

    /// A LISTED order of the issuer for `passport` (as `list` wrote it before the guard existed).
    fn write_listed_order(&mut self, passport: Pubkey, asset: Pubkey) -> Pubkey {
        let seller = self.issuer.pubkey();
        let (order, bump) = Pubkey::find_program_address(&[ORDER_SEED, passport.as_ref(), seller.as_ref()], &escrow::ID);
        let vault_bump = Pubkey::find_program_address(&[VAULT_SEED, order.as_ref()], &escrow::ID).1;
        let o = Order {
            passport,
            seller,
            buyer: Pubkey::default(),
            asset,
            price: PRICE,
            state: ORDER_STATE_LISTED,
            listed_at: T0 - 60,
            reserved_at: 0,
            shipped_at: 0,
            seller_scan: Pubkey::default(),
            buyer_scan: Pubkey::default(),
            dispute_after_s: 7 * 86_400,
            asset_deposited: false,
            bump,
            vault_bump,
        };
        let acc = anchor_account(&self.svm, &o, escrow::ID, Order::LEN);
        self.svm.set_account(order, acc).unwrap();
        order
    }

    fn reserve_ix(&self, order: Pubkey, passport: Pubkey, asset: Pubkey) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Reserve {
                config: self.config,
                order,
                buyer: self.buyer.pubkey(),
                buyer_token: self.buyer_token,
                usdc_mint: self.mint,
                vault: Pubkey::find_program_address(&[VAULT_SEED, order.as_ref()], &escrow::ID).0,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
                passport,
                asset,
                registry: self.registry,
            }
            .to_account_metas(None),
            data: escrow::instruction::Reserve { expected_price: PRICE }.data(),
        }
    }
}

fn expect_error(r: std::result::Result<(), String>, e: EscrowError) {
    let name = format!("{e:?}");
    match r {
        Ok(()) => panic!("expected {name}, the transaction succeeded"),
        Err(got) => assert!(got.contains(&format!("Custom({})", code(e))), "expected {name}, got {got}"),
    }
}

#[test]
#[ignore = "needs an SBPF v2 build of escrow: run scripts/test-escrow-time-travel.sh"]
fn list_refuses_a_pass_held_in_an_account() {
    let mut env = setup();
    let (passport, holding) = write_v2_pass(&mut env, b"SN-HELD-LIST");
    // the issuer is a partner, and there is no Core asset: v1 rules alone would let it list
    let issuer = env.issuer.insecure_clone();
    let ix = env.list_ix(passport, holding);
    expect_error(env.send(ix, &issuer), EscrowError::PassHeldInAccount);
    // control: a v1 passport without a Core asset (burned or a placeholder) is still listed by its issuer
    let v1_asset = Pubkey::new_unique();
    let v1 = write_passport(&mut env, b"SN-V1-LIST", v1_asset);
    let ix = env.list_ix(v1, v1_asset);
    env.send(ix, &issuer).expect("v1 issuer listing");
}

#[test]
#[ignore = "needs an SBPF v2 build of escrow: run scripts/test-escrow-time-travel.sh"]
fn reserve_refuses_a_pass_held_in_an_account() {
    let mut env = setup();
    let (passport, holding) = write_v2_pass(&mut env, b"SN-HELD-RESERVE");
    let order = env.write_listed_order(passport, holding);
    let buyer = env.buyer.insecure_clone();
    let ix = env.reserve_ix(order, passport, holding);
    expect_error(env.send(ix, &buyer), EscrowError::PassHeldInAccount);
    let o: Order = anchor_lang::AccountDeserialize::try_deserialize(&mut env.svm.get_account(&order).unwrap().data.as_slice()).unwrap();
    assert_eq!(o.state, ORDER_STATE_LISTED);
    let t = spl_token::state::Account::unpack(&env.svm.get_account(&env.buyer_token).unwrap().data).unwrap();
    assert_eq!(t.amount, PRICE, "the buyer keeps the USDC");
    // control: the same order shape for a v1 passport without a Core asset can be reserved
    let v1_asset = Pubkey::new_unique();
    let v1 = write_passport(&mut env, b"SN-V1-RESERVE", v1_asset);
    let order = env.write_listed_order(v1, v1_asset);
    let ix = env.reserve_ix(order, v1, v1_asset);
    env.send(ix, &buyer).expect("v1 reserve");
}
