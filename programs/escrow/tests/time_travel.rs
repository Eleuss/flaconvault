//! Time-travel tests for the escrow's window branches, which move money: the buyer's TIMEOUT refund
//! (`dispute` after `reserved_at + window`) and `release_after_timeout` (after `shipped_at + window`).
//!
//! The local validator of `anchor test` cannot move its clock, so these run the built program in
//! LiteSVM with a `Clock` override. Each order is written straight into the SVM in the state under test
//! (config, order, USDC vault and token accounts), with `reserved_at` and `shipped_at` weeks apart, so a
//! handler that passed the wrong timestamp to `rules.rs` fails here.
//!
//! Needs an SBF build of the program that LiteSVM 0.10 (Agave 3.1) can load. `anchor build` targets
//! SBPF v3 by default, which this runtime refuses, so the test builds the same source for SBPF v2:
//!   scripts/test-escrow-time-travel.sh
//! which runs
//!   cargo build-sbf --manifest-path programs/escrow/Cargo.toml --tools-version v1.57 --arch v2 \
//!     --sbf-out-dir target/sbf-v2 -- --locked
//!   cargo test -p escrow --test time_travel -- --ignored
//! The tests are `#[ignore]`d so a plain `cargo test` (no SBF toolchain) skips them visibly.
//! `FV_ESCROW_SO` points them at another build.

use anchor_lang::{
    prelude::*, solana_program::program_pack::Pack, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_spl::token::spl_token;
use escrow::{constants::*, EscrowConfig, EscrowError, Order};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const DAY: i64 = 86_400;
const WINDOW: i64 = 7 * DAY;
const PRICE: u64 = 480_000_000;
/// Some point in time well after the epoch (the exact value does not matter).
const T0: i64 = 1_790_000_000;

fn program_so() -> String {
    let path = std::env::var("FV_ESCROW_SO")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/sbf-v2/escrow.so").to_string());
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} is missing: run scripts/test-escrow-time-travel.sh (builds it for SBPF v2, see the module docs)"
    );
    path
}

fn code(e: EscrowError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    buyer: Keypair,
    seller: Pubkey,
    config: Pubkey,
    order: Pubkey,
    vault: Pubkey,
    seller_token: Pubkey,
    buyer_token: Pubkey,
}

fn anchor_account<T: AccountSerialize>(svm: &LiteSVM, value: &T, owner: Pubkey, space: usize) -> Account {
    let mut data = Vec::with_capacity(space);
    value.try_serialize(&mut data).expect("serialize");
    data.resize(space, 0);
    Account {
        lamports: svm.minimum_balance_for_rent_exemption(space),
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn token_account(svm: &LiteSVM, mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        state: spl_token::state::AccountState::Initialized,
        ..Default::default()
    }
    .pack_into_slice(&mut data);
    Account {
        lamports: svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: spl_token::ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// A funded order in `state` (vault holds `PRICE`) with the given timestamps and stored window.
fn setup(state: u8, reserved_at: i64, shipped_at: i64, dispute_after_s: i64) -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(escrow::ID, program_so()).expect("load escrow.so");
    let payer = Keypair::new();
    let buyer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&buyer.pubkey(), 1_000_000_000).unwrap();
    let admin = Pubkey::new_unique();
    let seller = Pubkey::new_unique();
    let passport = Pubkey::new_unique();
    let mint = Pubkey::new_unique();

    let (config, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], &escrow::ID);
    let cfg = EscrowConfig { admin, usdc_mint: mint, dispute_after_s: WINDOW, bump: config_bump };
    let acc = anchor_account(&svm, &cfg, escrow::ID, 8 + EscrowConfig::INIT_SPACE);
    svm.set_account(config, acc).unwrap();

    let (order, order_bump) =
        Pubkey::find_program_address(&[ORDER_SEED, passport.as_ref(), seller.as_ref()], &escrow::ID);
    let (vault, vault_bump) = Pubkey::find_program_address(&[VAULT_SEED, order.as_ref()], &escrow::ID);
    let o = Order {
        passport,
        seller,
        buyer: buyer.pubkey(),
        asset: Pubkey::new_unique(),
        price: PRICE,
        state,
        listed_at: reserved_at - DAY,
        reserved_at,
        shipped_at,
        seller_scan: Pubkey::default(),
        buyer_scan: Pubkey::default(),
        dispute_after_s,
        asset_deposited: false,
        bump: order_bump,
        vault_bump,
    };
    let acc = anchor_account(&svm, &o, escrow::ID, Order::LEN);
    svm.set_account(order, acc).unwrap();
    let acc = token_account(&svm, mint, order, PRICE);
    svm.set_account(vault, acc).unwrap();

    let seller_token = Pubkey::new_unique();
    let acc = token_account(&svm, mint, seller, 0);
    svm.set_account(seller_token, acc).unwrap();
    let buyer_token = Pubkey::new_unique();
    let acc = token_account(&svm, mint, buyer.pubkey(), 0);
    svm.set_account(buyer_token, acc).unwrap();

    Env { svm, payer, buyer, seller, config, order, vault, seller_token, buyer_token }
}

impl Env {
    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Sends one instruction (payer + extra signers); `Err(debug text)` when the transaction failed.
    fn send(&mut self, ix: Instruction, extra: &[&Keypair]) -> std::result::Result<(), String> {
        // a fresh blockhash per attempt, so a retried identical transaction is not "already processed"
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&self.payer.pubkey()), &signers, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn expect_error(&mut self, ix: Instruction, extra: &[&Keypair], e: EscrowError) {
        let name = format!("{e:?}");
        match self.send(ix, extra) {
            Ok(()) => panic!("expected {name}, the transaction succeeded"),
            Err(got) => assert!(got.contains(&format!("Custom({})", code(e))), "expected {name}, got {got}"),
        }
    }

    fn release_after_timeout_ix(&self) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Release {
                config: self.config,
                order: self.order,
                vault: self.vault,
                seller_token: self.seller_token,
                buyer: self.buyer.pubkey(),
                caller: self.payer.pubkey(),
                asset: None,
                mpl_core_program: None,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::ReleaseAfterTimeout {}.data(),
        }
    }

    /// The buyer's `dispute` without a seal (the TIMEOUT branch).
    fn buyer_dispute_ix(&self) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Dispute {
                config: self.config,
                order: self.order,
                vault: self.vault,
                buyer_token: self.buyer_token,
                buyer: self.buyer.pubkey(),
                seller: self.seller,
                signer: self.buyer.pubkey(),
                seal: None,
                asset: None,
                mpl_core_program: None,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::Dispute {}.data(),
        }
    }

    fn token_amount(&self, account: &Pubkey) -> u64 {
        let a = self.svm.get_account(account).expect("token account");
        spl_token::state::Account::unpack(&a.data).expect("token data").amount
    }

    fn order_state(&self) -> u8 {
        let a = self.svm.get_account(&self.order).expect("order");
        Order::try_deserialize(&mut a.data.as_slice()).expect("order data").state
    }

    fn vault_closed(&self) -> bool {
        self.svm.get_account(&self.vault).map_or(true, |a| a.lamports == 0)
    }
}

#[test]
#[ignore = "needs an SBPF v2 build of escrow: run scripts/test-escrow-time-travel.sh"]
fn release_after_timeout_counts_from_shipped_at() {
    // reserved three weeks before shipping: the window after the reservation has long passed
    let shipped_at = T0 + 21 * DAY;
    let mut env = setup(ORDER_STATE_SHIPPED, T0, shipped_at, WINDOW);

    env.set_time(T0 + WINDOW + 1);
    let ix = env.release_after_timeout_ix();
    env.expect_error(ix, &[], EscrowError::DisputeWindowNotElapsed);
    // the last second of the buyer's window
    env.set_time(shipped_at + WINDOW);
    let ix = env.release_after_timeout_ix();
    env.expect_error(ix, &[], EscrowError::DisputeWindowNotElapsed);
    // shipped: the buyer gets no TIMEOUT refund, whatever the clock says
    env.set_time(shipped_at + 10 * WINDOW);
    let ix = env.buyer_dispute_ix();
    let buyer = env.buyer.insecure_clone();
    env.expect_error(ix, &[&buyer], EscrowError::InvalidState);
    assert_eq!(env.order_state(), ORDER_STATE_SHIPPED);

    env.set_time(shipped_at + WINDOW + 1);
    let ix = env.release_after_timeout_ix();
    env.send(ix, &[]).expect("release after the window");
    assert_eq!(env.order_state(), ORDER_STATE_RELEASED);
    assert_eq!(env.token_amount(&env.seller_token), PRICE);
    assert_eq!(env.token_amount(&env.buyer_token), 0);
    assert!(env.vault_closed(), "vault closed");
}

#[test]
#[ignore = "needs an SBPF v2 build of escrow: run scripts/test-escrow-time-travel.sh"]
fn buyer_timeout_refund_counts_from_reserved_at() {
    for state in [ORDER_STATE_RESERVED, ORDER_STATE_PRESHIP_SCANNED] {
        // shipped_at is 0 until ship(), as on chain
        let mut env = setup(state, T0, 0, WINDOW);
        let buyer = env.buyer.insecure_clone();

        env.set_time(T0 + 1);
        let ix = env.buyer_dispute_ix();
        env.expect_error(ix, &[&buyer], EscrowError::DisputeWindowNotElapsed);
        // the last second of the seller's window
        env.set_time(T0 + WINDOW);
        let ix = env.buyer_dispute_ix();
        env.expect_error(ix, &[&buyer], EscrowError::DisputeWindowNotElapsed);
        // not shipped: nothing to release to the seller, however late
        env.set_time(T0 + 10 * WINDOW);
        let ix = env.release_after_timeout_ix();
        env.expect_error(ix, &[], EscrowError::InvalidState);

        env.set_time(T0 + WINDOW + 1);
        let ix = env.buyer_dispute_ix();
        env.send(ix, &[&buyer]).expect("refund after the window");
        assert_eq!(env.order_state(), ORDER_STATE_DISPUTE, "state {state}");
        assert_eq!(env.token_amount(&env.buyer_token), PRICE);
        assert_eq!(env.token_amount(&env.seller_token), 0);
        assert!(env.vault_closed(), "vault closed");
    }
}

#[test]
#[ignore = "needs an SBPF v2 build of escrow: run scripts/test-escrow-time-travel.sh"]
fn a_stored_window_below_one_hour_still_gives_one_hour() {
    // orders listed before the bounds existed may hold any window; the program clamps it to 1 h ..= 60 days
    let mut env = setup(ORDER_STATE_RESERVED, T0, 0, 1);
    let buyer = env.buyer.insecure_clone();
    env.set_time(T0 + 2);
    let ix = env.buyer_dispute_ix();
    env.expect_error(ix, &[&buyer], EscrowError::DisputeWindowNotElapsed);
    env.set_time(T0 + MIN_DISPUTE_AFTER_S + 1);
    let ix = env.buyer_dispute_ix();
    env.send(ix, &[&buyer]).expect("refund after one hour");
    assert_eq!(env.order_state(), ORDER_STATE_DISPUTE);

    let shipped_at = T0 + 3 * DAY;
    let mut env = setup(ORDER_STATE_SHIPPED, T0, shipped_at, 1);
    env.set_time(shipped_at + 2);
    let ix = env.release_after_timeout_ix();
    env.expect_error(ix, &[], EscrowError::DisputeWindowNotElapsed);
    env.set_time(shipped_at + MIN_DISPUTE_AFTER_S + 1);
    let ix = env.release_after_timeout_ix();
    env.send(ix, &[]).expect("release after one hour");
    assert_eq!(env.order_state(), ORDER_STATE_RELEASED);
}
