//! Pure decision rules of the market escrow (no accounts, no clock), unit-tested with
//! `cargo test -p market_escrow`; the instruction handlers only gather the inputs and apply the result.
//!
//! ```text
//! open_and_deposit (buyer + offer key's terms) ──▶ PAID
//! PAID     ──mark_shipped (seller, now ≤ ship_deadline)──▶ SHIPPED
//! PAID     ──refund_unshipped (anyone, now > ship_deadline)──▶ REFUNDED   (everything to the buyer)
//! SHIPPED  ──confirm (buyer)──▶ RELEASED                                  (seller + fee vault)
//! SHIPPED  ──release_after_window (anyone, now > shipped_at + review window)──▶ RELEASED
//! SHIPPED  ──dispute (buyer or arbiter, now ≤ shipped_at + review window)──▶ DISPUTED
//! DISPUTED ──confirm (buyer withdraws)──▶ RELEASED
//! DISPUTED ──rule (arbiter, RELEASE | REFUND, now ≤ disputed_at + ruling window = T_max)──▶ RULED
//! DISPUTED ──refund_after_tmax (anyone, now > T_max)──▶ REFUNDED
//! RULED    ──execute_ruling (anyone, now > ruled_at + timelock)──▶ RELEASED | REFUNDED
//! DISPUTED | RULED ──propose_settlement (buyer or seller) + accept_settlement (the other one)──▶ SETTLED
//! RELEASED | REFUNDED | SETTLED ──close_order (anyone, now > offer expiry)──▶ accounts closed, rent back
//! ```
//!
//! Every non-terminal state has an exit that anyone may trigger after a bounded time (`PAID` → refund,
//! `SHIPPED` → release, `DISPUTED` → refund, `RULED` → its ruling), so no key — not the offer key, not
//! the arbiter, not the upgrade authority — is needed for the money to leave the vault. Money only ever
//! goes to the buyer, the seller, or (on release) the fee vault; a full refund returns the buyer fee too,
//! and a settlement splits the whole deposit between buyer and seller without fees.

use anchor_lang::prelude::*;

use crate::{constants::*, error::MarketEscrowError as E, offer::OfferArgs};

/// `start + duration` (overflow-checked).
pub fn deadline(start: i64, duration_s: i64) -> Result<i64> {
    start.checked_add(duration_s).ok_or_else(|| E::MathOverflow.into())
}

/// The review window of a lane (blueprint §7.2: S 10 days, A 14 days; G not with crypto).
pub fn review_window_s(lane: u8) -> Result<u32> {
    match lane {
        LANE_S => Ok(REVIEW_WINDOW_S_LANE_S),
        LANE_A => Ok(REVIEW_WINDOW_S_LANE_A),
        LANE_G => err!(E::LaneNotSupported),
        _ => err!(E::InvalidLane),
    }
}

/// `fee ≤ amount × MAX_FEE_BPS / 10 000` (exact, in u128).
pub fn fee_within_cap(fee: u64, amount: u64) -> bool {
    (fee as u128) * (BPS_DENOMINATOR as u128) <= (amount as u128) * (MAX_FEE_BPS as u128)
}

/// What the buyer deposits: `amount + buyer_fee`.
pub fn deposit_total(amount: u64, buyer_fee: u64) -> Result<u64> {
    amount.checked_add(buyer_fee).ok_or_else(|| E::InvalidAmount.into())
}

/// Every check on the signed terms at `open_and_deposit` except the signature itself. Returns the
/// review window of the lane, which the order stores.
pub fn check_terms(a: &OfferArgs, buyer: &Pubkey, arbiter: &Pubkey, now: i64) -> Result<u32> {
    require!(now <= a.expiry, E::OfferExpired);
    require!(
        a.expiry.checked_sub(now).is_some_and(|ttl| ttl <= MAX_OFFER_TTL_S),
        E::OfferExpiryTooFar
    );
    require!(a.amount > 0, E::InvalidAmount);
    deposit_total(a.amount, a.buyer_fee)?;
    require!(
        fee_within_cap(a.buyer_fee, a.amount) && fee_within_cap(a.seller_fee, a.amount),
        E::FeeTooHigh
    );
    let review = review_window_s(a.lane)?;
    require!(
        a.ship_deadline >= deadline(now, MIN_SHIP_WINDOW_S)?
            && a.ship_deadline <= deadline(now, MAX_SHIP_WINDOW_S)?,
        E::InvalidShipDeadline
    );
    require!(
        (MIN_RULING_WINDOW_S..=MAX_RULING_WINDOW_S).contains(&a.ruling_window_s),
        E::InvalidRulingWindow
    );
    require!(
        (MIN_TIMELOCK_S..=MAX_TIMELOCK_S).contains(&a.timelock_s),
        E::InvalidTimelock
    );
    require!(
        a.seller != Pubkey::default() && a.seller != *buyer && a.seller != *arbiter,
        E::InvalidSeller
    );
    require!(buyer != arbiter, E::BuyerIsArbiter);
    Ok(review)
}

// ---- payouts -----------------------------------------------------------------------

/// Where the deposit goes. `to_buyer + to_seller + to_fees` always equals the deposit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payout {
    pub to_buyer: u64,
    pub to_seller: u64,
    pub to_fees: u64,
}

/// Release: the seller gets `amount − seller_fee`, the fee vault `buyer_fee + seller_fee`.
pub fn release_payout(amount: u64, buyer_fee: u64, seller_fee: u64) -> Result<Payout> {
    Ok(Payout {
        to_buyer: 0,
        to_seller: amount.checked_sub(seller_fee).ok_or(E::MathOverflow)?,
        to_fees: buyer_fee.checked_add(seller_fee).ok_or(E::MathOverflow)?,
    })
}

/// Full refund: the buyer gets everything back, buyer fee included.
pub fn refund_payout(amount: u64, buyer_fee: u64) -> Result<Payout> {
    Ok(Payout {
        to_buyer: deposit_total(amount, buyer_fee)?,
        to_seller: 0,
        to_fees: 0,
    })
}

/// Settlement: `to_buyer` to the buyer, the rest of the deposit to the seller, no fees.
pub fn settlement_payout(deposit: u64, to_buyer: u64) -> Result<Payout> {
    require!(to_buyer <= deposit, E::SettlementTooLarge);
    Ok(Payout {
        to_buyer,
        to_seller: deposit - to_buyer,
        to_fees: 0,
    })
}

// ---- who is signing ------------------------------------------------------------------

/// `PARTY_BUYER` / `PARTY_SELLER` / `PARTY_ARBITER`, or `PARTY_NONE` (the three are distinct keys,
/// `check_terms` makes sure of it).
pub fn party_of(signer: &Pubkey, buyer: &Pubkey, seller: &Pubkey, arbiter: &Pubkey) -> u8 {
    if signer == buyer {
        PARTY_BUYER
    } else if signer == seller {
        PARTY_SELLER
    } else if signer == arbiter {
        PARTY_ARBITER
    } else {
        PARTY_NONE
    }
}

// ---- transitions ---------------------------------------------------------------------

/// `mark_shipped`: PAID and the ship deadline has not passed.
pub fn check_mark_shipped(state: u8, ship_deadline: i64, now: i64) -> Result<()> {
    require!(state == STATE_PAID, E::InvalidState);
    require!(now <= ship_deadline, E::ShipDeadlinePassed);
    Ok(())
}

/// `refund_unshipped`: PAID and the ship deadline has passed.
pub fn check_refund_unshipped(state: u8, ship_deadline: i64, now: i64) -> Result<()> {
    require!(state == STATE_PAID, E::InvalidState);
    require!(now > ship_deadline, E::ShipDeadlineNotPassed);
    Ok(())
}

/// `confirm`: the buyer releases a shipped order, or withdraws an open dispute. Not after a ruling
/// (during the timelock only a settlement is possible).
pub fn check_confirm(state: u8) -> Result<()> {
    require!(
        state == STATE_SHIPPED || state == STATE_DISPUTED,
        E::InvalidState
    );
    Ok(())
}

/// `release_after_window`: SHIPPED and the review window has passed without a dispute.
pub fn check_release_after_window(state: u8, shipped_at: i64, review_window_s: u32, now: i64) -> Result<()> {
    require!(state == STATE_SHIPPED, E::InvalidState);
    require!(
        now > deadline(shipped_at, review_window_s as i64)?,
        E::ReviewWindowOpen
    );
    Ok(())
}

/// `dispute`: the buyer or the arbiter halts a SHIPPED order while its review window is open.
pub fn check_dispute(state: u8, party: u8, shipped_at: i64, review_window_s: u32, now: i64) -> Result<()> {
    require!(
        party == PARTY_BUYER || party == PARTY_ARBITER,
        E::NotParty
    );
    require!(state == STATE_SHIPPED, E::InvalidState);
    require!(
        now <= deadline(shipped_at, review_window_s as i64)?,
        E::ReviewWindowClosed
    );
    Ok(())
}

/// T_max of a disputed order.
pub fn ruling_deadline(disputed_at: i64, ruling_window_s: u32) -> Result<i64> {
    deadline(disputed_at, ruling_window_s as i64)
}

/// `rule` (the arbiter is checked by the accounts): DISPUTED, RELEASE or REFUND with a reason hash,
/// and not after T_max (then the buyer's fallback refund is due).
pub fn check_rule(
    state: u8,
    disputed_at: i64,
    ruling_window_s: u32,
    ruling: u8,
    reason_hash: &[u8; 32],
    now: i64,
) -> Result<()> {
    require!(state == STATE_DISPUTED, E::InvalidState);
    require!(
        ruling == RULING_RELEASE || ruling == RULING_REFUND,
        E::InvalidRuling
    );
    require!(reason_hash != &[0u8; 32], E::MissingReasonHash);
    require!(
        now <= ruling_deadline(disputed_at, ruling_window_s)?,
        E::RulingDeadlinePassed
    );
    Ok(())
}

/// `execute_ruling`: RULED and the timelock has passed. Returns the resolution to record.
pub fn check_execute_ruling(state: u8, ruling: u8, ruled_at: i64, timelock_s: u32, now: i64) -> Result<u8> {
    require!(state == STATE_RULED, E::InvalidState);
    require!(
        now > deadline(ruled_at, timelock_s as i64)?,
        E::TimelockActive
    );
    match ruling {
        RULING_RELEASE => Ok(RESOLUTION_RULING_RELEASE),
        RULING_REFUND => Ok(RESOLUTION_RULING_REFUND),
        _ => err!(E::InvalidRuling),
    }
}

/// `refund_after_tmax`: DISPUTED and no ruling by T_max.
pub fn check_refund_after_tmax(state: u8, disputed_at: i64, ruling_window_s: u32, now: i64) -> Result<()> {
    require!(state == STATE_DISPUTED, E::InvalidState);
    require!(
        now > ruling_deadline(disputed_at, ruling_window_s)?,
        E::RulingDeadlineNotPassed
    );
    Ok(())
}

fn settlement_open(state: u8) -> bool {
    state == STATE_DISPUTED || state == STATE_RULED
}

/// `propose_settlement`: buyer or seller, on a DISPUTED or RULED order, at most the deposit to the buyer.
pub fn check_propose(state: u8, party: u8, to_buyer: u64, deposit: u64) -> Result<()> {
    require!(
        party == PARTY_BUYER || party == PARTY_SELLER,
        E::NotParty
    );
    require!(settlement_open(state), E::InvalidState);
    require!(to_buyer <= deposit, E::SettlementTooLarge);
    Ok(())
}

/// `accept_settlement`: the other party accepts exactly the open proposal (`expected_to_buyer`, so a
/// proposal changed while the acceptance was in flight is not accepted).
pub fn check_accept(state: u8, party: u8, proposal_by: u8, proposal_to_buyer: u64, expected_to_buyer: u64) -> Result<()> {
    require!(
        party == PARTY_BUYER || party == PARTY_SELLER,
        E::NotParty
    );
    require!(settlement_open(state), E::InvalidState);
    require!(proposal_by != PARTY_NONE, E::NoProposal);
    require!(proposal_by != party, E::OwnProposal);
    require!(
        proposal_to_buyer == expected_to_buyer,
        E::ProposalMismatch
    );
    Ok(())
}

/// `close_order`: terminal, and the offer has expired (so the same signed offer cannot open the order
/// again once the account is gone).
pub fn check_close(state: u8, offer_expiry: i64, now: i64) -> Result<()> {
    require!(
        matches!(state, STATE_RELEASED | STATE_REFUNDED | STATE_SETTLED),
        E::InvalidState
    );
    require!(now > offer_expiry, E::OfferNotExpired);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_790_000_000;
    const ALL_STATES: [u8; 8] = [
        0,
        STATE_PAID,
        STATE_SHIPPED,
        STATE_DISPUTED,
        STATE_RULED,
        STATE_RELEASED,
        STATE_REFUNDED,
        STATE_SETTLED,
    ];

    fn code<T>(r: Result<T>) -> Option<u32> {
        match r {
            Ok(_) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Err(_) => Some(0),
        }
    }
    fn err(e: E) -> Option<u32> {
        Some(anchor_lang::error::ERROR_CODE_OFFSET + e as u32)
    }

    fn keys() -> (Pubkey, Pubkey, Pubkey) {
        (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique())
    }

    fn terms(seller: Pubkey) -> OfferArgs {
        OfferArgs {
            order_id: [7; 16],
            seller,
            amount: 300_000_000,
            buyer_fee: 15_000_000,
            seller_fee: 9_000_000,
            lane: LANE_S,
            ship_deadline: T0 + 7 * DAY,
            ruling_window_s: (21 * DAY) as u32,
            timelock_s: (48 * HOUR) as u32,
            expiry: T0 + 600,
        }
    }

    #[test]
    fn lanes_fix_the_review_window() {
        assert_eq!(review_window_s(LANE_S).unwrap(), 10 * 86_400);
        assert_eq!(review_window_s(LANE_A).unwrap(), 14 * 86_400);
        assert_eq!(code(review_window_s(LANE_G)), err(E::LaneNotSupported));
        assert_eq!(code(review_window_s(0)), err(E::InvalidLane));
        assert_eq!(code(review_window_s(4)), err(E::InvalidLane));
    }

    #[test]
    fn valid_terms() {
        let (buyer, seller, arbiter) = keys();
        assert_eq!(check_terms(&terms(seller), &buyer, &arbiter, T0).unwrap(), REVIEW_WINDOW_S_LANE_S);
        let a = OfferArgs { lane: LANE_A, ..terms(seller) };
        assert_eq!(check_terms(&a, &buyer, &arbiter, T0).unwrap(), REVIEW_WINDOW_S_LANE_A);
        // exactly at the bounds
        let edge = OfferArgs {
            buyer_fee: 60_000_000,
            seller_fee: 60_000_000,
            ship_deadline: T0 + DAY,
            ruling_window_s: MIN_RULING_WINDOW_S,
            timelock_s: MIN_TIMELOCK_S,
            expiry: T0 + HOUR,
            ..terms(seller)
        };
        assert!(check_terms(&edge, &buyer, &arbiter, T0).is_ok());
        let edge = OfferArgs {
            buyer_fee: 0,
            seller_fee: 0,
            ship_deadline: T0 + 30 * DAY,
            ruling_window_s: MAX_RULING_WINDOW_S,
            timelock_s: MAX_TIMELOCK_S,
            expiry: T0,
            ..terms(seller)
        };
        assert!(check_terms(&edge, &buyer, &arbiter, T0).is_ok());
    }

    #[test]
    fn invalid_terms() {
        let (buyer, seller, arbiter) = keys();
        let t = terms(seller);
        let chk = |a: OfferArgs| code(check_terms(&a, &buyer, &arbiter, T0));
        assert_eq!(chk(OfferArgs { expiry: T0 - 1, ..t.clone() }), err(E::OfferExpired));
        assert_eq!(chk(OfferArgs { expiry: T0 + HOUR + 1, ..t.clone() }), err(E::OfferExpiryTooFar));
        assert_eq!(chk(OfferArgs { expiry: i64::MAX, ..t.clone() }), err(E::OfferExpiryTooFar));
        assert_eq!(chk(OfferArgs { amount: 0, buyer_fee: 0, seller_fee: 0, ..t.clone() }), err(E::InvalidAmount));
        assert_eq!(chk(OfferArgs { amount: u64::MAX, buyer_fee: 1, seller_fee: 0, ..t.clone() }), err(E::InvalidAmount));
        assert_eq!(chk(OfferArgs { buyer_fee: 60_000_001, ..t.clone() }), err(E::FeeTooHigh));
        assert_eq!(chk(OfferArgs { seller_fee: 60_000_001, ..t.clone() }), err(E::FeeTooHigh));
        assert_eq!(chk(OfferArgs { seller_fee: t.amount, ..t.clone() }), err(E::FeeTooHigh));
        assert_eq!(chk(OfferArgs { lane: LANE_G, ..t.clone() }), err(E::LaneNotSupported));
        assert_eq!(chk(OfferArgs { lane: 0, ..t.clone() }), err(E::InvalidLane));
        assert_eq!(chk(OfferArgs { ship_deadline: T0 + DAY - 1, ..t.clone() }), err(E::InvalidShipDeadline));
        assert_eq!(chk(OfferArgs { ship_deadline: T0 + 30 * DAY + 1, ..t.clone() }), err(E::InvalidShipDeadline));
        assert_eq!(chk(OfferArgs { ship_deadline: T0 - 1, ..t.clone() }), err(E::InvalidShipDeadline));
        assert_eq!(chk(OfferArgs { ruling_window_s: MIN_RULING_WINDOW_S - 1, ..t.clone() }), err(E::InvalidRulingWindow));
        assert_eq!(chk(OfferArgs { ruling_window_s: MAX_RULING_WINDOW_S + 1, ..t.clone() }), err(E::InvalidRulingWindow));
        assert_eq!(chk(OfferArgs { timelock_s: MIN_TIMELOCK_S - 1, ..t.clone() }), err(E::InvalidTimelock));
        assert_eq!(chk(OfferArgs { timelock_s: MAX_TIMELOCK_S + 1, ..t.clone() }), err(E::InvalidTimelock));
        assert_eq!(chk(OfferArgs { seller: buyer, ..t.clone() }), err(E::InvalidSeller));
        assert_eq!(chk(OfferArgs { seller: arbiter, ..t.clone() }), err(E::InvalidSeller));
        assert_eq!(chk(OfferArgs { seller: Pubkey::default(), ..t.clone() }), err(E::InvalidSeller));
        assert_eq!(code(check_terms(&t, &arbiter, &arbiter, T0)), err(E::BuyerIsArbiter));
    }

    #[test]
    fn fee_cap_is_exact() {
        assert!(fee_within_cap(20, 100));
        assert!(!fee_within_cap(21, 100));
        assert!(fee_within_cap(0, 0));
        assert!(!fee_within_cap(1, 4)); // 20 % of 4 base units is 0.8
        assert!(fee_within_cap(u64::MAX / 5, u64::MAX));
        assert!(!fee_within_cap(u64::MAX / 5 + 1, u64::MAX));
    }

    #[test]
    fn payouts_always_add_up_to_the_deposit() {
        for (amount, buyer_fee, seller_fee) in [(300_000_000u64, 15_000_000u64, 9_000_000u64), (1, 0, 0), (40_000_000, 2_000_000, 1_200_000), (u64::MAX - 10, 10, 0)] {
            let deposit = deposit_total(amount, buyer_fee).unwrap();
            let r = release_payout(amount, buyer_fee, seller_fee).unwrap();
            assert_eq!(r.to_buyer + r.to_seller + r.to_fees, deposit);
            assert_eq!(r.to_seller, amount - seller_fee);
            assert_eq!(r.to_fees, buyer_fee + seller_fee);
            let f = refund_payout(amount, buyer_fee).unwrap();
            assert_eq!(f, Payout { to_buyer: deposit, to_seller: 0, to_fees: 0 });
            for to_buyer in [0, 1, deposit / 3, deposit] {
                let s = settlement_payout(deposit, to_buyer).unwrap();
                assert_eq!(s.to_buyer + s.to_seller, deposit);
                assert_eq!(s.to_fees, 0);
            }
            assert_eq!(code(settlement_payout(deposit, deposit.saturating_add(1)).map(|_| ())), if deposit == u64::MAX { None } else { err(E::SettlementTooLarge) });
        }
        // the 300 € example of blueprint §8: 315 deposited, 291 to the seller, 24 fees
        let r = release_payout(300_000_000, 15_000_000, 9_000_000).unwrap();
        assert_eq!((r.to_seller, r.to_fees), (291_000_000, 24_000_000));
    }

    #[test]
    fn parties() {
        let (buyer, seller, arbiter) = keys();
        assert_eq!(party_of(&buyer, &buyer, &seller, &arbiter), PARTY_BUYER);
        assert_eq!(party_of(&seller, &buyer, &seller, &arbiter), PARTY_SELLER);
        assert_eq!(party_of(&arbiter, &buyer, &seller, &arbiter), PARTY_ARBITER);
        assert_eq!(party_of(&Pubkey::new_unique(), &buyer, &seller, &arbiter), PARTY_NONE);
    }

    #[test]
    fn shipping_and_the_ship_deadline() {
        let dl = T0 + 5 * DAY;
        assert!(check_mark_shipped(STATE_PAID, dl, dl).is_ok());
        assert_eq!(code(check_mark_shipped(STATE_PAID, dl, dl + 1)), err(E::ShipDeadlinePassed));
        assert_eq!(code(check_refund_unshipped(STATE_PAID, dl, dl)), err(E::ShipDeadlineNotPassed));
        assert!(check_refund_unshipped(STATE_PAID, dl, dl + 1).is_ok());
        // at every instant exactly one of the two is possible
        for now in [T0, dl - 1, dl, dl + 1, dl + 100 * DAY] {
            assert_ne!(check_mark_shipped(STATE_PAID, dl, now).is_ok(), check_refund_unshipped(STATE_PAID, dl, now).is_ok());
        }
        for s in ALL_STATES.into_iter().filter(|s| *s != STATE_PAID) {
            assert_eq!(code(check_mark_shipped(s, dl, T0)), err(E::InvalidState), "state {s}");
            assert_eq!(code(check_refund_unshipped(s, dl, dl + 1)), err(E::InvalidState), "state {s}");
        }
    }

    #[test]
    fn review_window_dispute_or_release() {
        let shipped = T0;
        let w = REVIEW_WINDOW_S_LANE_A;
        let end = T0 + w as i64;
        assert!(check_dispute(STATE_SHIPPED, PARTY_BUYER, shipped, w, end).is_ok());
        assert!(check_dispute(STATE_SHIPPED, PARTY_ARBITER, shipped, w, shipped).is_ok());
        assert_eq!(code(check_dispute(STATE_SHIPPED, PARTY_BUYER, shipped, w, end + 1)), err(E::ReviewWindowClosed));
        assert_eq!(code(check_dispute(STATE_SHIPPED, PARTY_SELLER, shipped, w, shipped)), err(E::NotParty));
        assert_eq!(code(check_dispute(STATE_SHIPPED, PARTY_NONE, shipped, w, shipped)), err(E::NotParty));
        assert_eq!(code(check_release_after_window(STATE_SHIPPED, shipped, w, end)), err(E::ReviewWindowOpen));
        assert!(check_release_after_window(STATE_SHIPPED, shipped, w, end + 1).is_ok());
        // lane S: 10 days, so day 11 is past it while lane A is still open
        let day11 = T0 + 11 * DAY;
        assert!(check_release_after_window(STATE_SHIPPED, shipped, REVIEW_WINDOW_S_LANE_S, day11).is_ok());
        assert_eq!(code(check_release_after_window(STATE_SHIPPED, shipped, REVIEW_WINDOW_S_LANE_A, day11)), err(E::ReviewWindowOpen));
        // at every instant exactly one of dispute and release is possible
        for now in [shipped, end - 1, end, end + 1, end + 365 * DAY] {
            assert_ne!(check_dispute(STATE_SHIPPED, PARTY_BUYER, shipped, w, now).is_ok(), check_release_after_window(STATE_SHIPPED, shipped, w, now).is_ok());
        }
        for s in ALL_STATES.into_iter().filter(|s| *s != STATE_SHIPPED) {
            assert_eq!(code(check_dispute(s, PARTY_BUYER, shipped, w, shipped)), err(E::InvalidState), "state {s}");
            assert_eq!(code(check_release_after_window(s, shipped, w, end + 1)), err(E::InvalidState), "state {s}");
        }
        assert_eq!(code(check_release_after_window(STATE_SHIPPED, i64::MAX, w, i64::MAX)), err(E::MathOverflow));
    }

    #[test]
    fn confirm_states() {
        assert!(check_confirm(STATE_SHIPPED).is_ok());
        assert!(check_confirm(STATE_DISPUTED).is_ok());
        for s in [0, STATE_PAID, STATE_RULED, STATE_RELEASED, STATE_REFUNDED, STATE_SETTLED] {
            assert_eq!(code(check_confirm(s)), err(E::InvalidState), "state {s}");
        }
    }

    #[test]
    fn ruling_tmax_and_timelock() {
        let disputed = T0;
        let rw = MIN_RULING_WINDOW_S;
        let tmax = disputed + rw as i64;
        let h = [1u8; 32];
        assert!(check_rule(STATE_DISPUTED, disputed, rw, RULING_RELEASE, &h, tmax).is_ok());
        assert!(check_rule(STATE_DISPUTED, disputed, rw, RULING_REFUND, &h, disputed).is_ok());
        assert_eq!(code(check_rule(STATE_DISPUTED, disputed, rw, RULING_REFUND, &h, tmax + 1)), err(E::RulingDeadlinePassed));
        assert_eq!(code(check_rule(STATE_DISPUTED, disputed, rw, RULING_NONE, &h, disputed)), err(E::InvalidRuling));
        assert_eq!(code(check_rule(STATE_DISPUTED, disputed, rw, 3, &h, disputed)), err(E::InvalidRuling));
        assert_eq!(code(check_rule(STATE_DISPUTED, disputed, rw, RULING_RELEASE, &[0u8; 32], disputed)), err(E::MissingReasonHash));
        for s in ALL_STATES.into_iter().filter(|s| *s != STATE_DISPUTED) {
            assert_eq!(code(check_rule(s, disputed, rw, RULING_RELEASE, &h, disputed)), err(E::InvalidState), "state {s}");
            assert_eq!(code(check_refund_after_tmax(s, disputed, rw, tmax + 1)), err(E::InvalidState), "state {s}");
        }
        // T_max fallback
        assert_eq!(code(check_refund_after_tmax(STATE_DISPUTED, disputed, rw, tmax)), err(E::RulingDeadlineNotPassed));
        assert!(check_refund_after_tmax(STATE_DISPUTED, disputed, rw, tmax + 1).is_ok());
        for now in [disputed, tmax, tmax + 1, tmax + 365 * DAY] {
            assert_ne!(check_rule(STATE_DISPUTED, disputed, rw, RULING_RELEASE, &h, now).is_ok(), check_refund_after_tmax(STATE_DISPUTED, disputed, rw, now).is_ok());
        }
        // timelock
        let ruled = T0 + 3 * DAY;
        let tl = MAX_TIMELOCK_S;
        let open = ruled + tl as i64;
        assert_eq!(code(check_execute_ruling(STATE_RULED, RULING_RELEASE, ruled, tl, open)), err(E::TimelockActive));
        assert_eq!(check_execute_ruling(STATE_RULED, RULING_RELEASE, ruled, tl, open + 1).unwrap(), RESOLUTION_RULING_RELEASE);
        assert_eq!(check_execute_ruling(STATE_RULED, RULING_REFUND, ruled, tl, open + 1).unwrap(), RESOLUTION_RULING_REFUND);
        assert_eq!(code(check_execute_ruling(STATE_RULED, RULING_NONE, ruled, tl, open + 1)), err(E::InvalidRuling));
        for s in ALL_STATES.into_iter().filter(|s| *s != STATE_RULED) {
            assert_eq!(code(check_execute_ruling(s, RULING_RELEASE, ruled, tl, open + 1)), err(E::InvalidState), "state {s}");
        }
    }

    #[test]
    fn during_the_timelock_only_a_settlement_is_possible() {
        let (s, ruled_at, disputed_at, shipped_at) = (STATE_RULED, T0, T0 - DAY, T0 - 2 * DAY);
        let now = ruled_at + 1;
        let h = [1u8; 32];
        assert!(check_confirm(s).is_err());
        assert!(check_dispute(s, PARTY_BUYER, shipped_at, REVIEW_WINDOW_S_LANE_S, now).is_err());
        assert!(check_rule(s, disputed_at, MIN_RULING_WINDOW_S, RULING_REFUND, &h, now).is_err());
        assert!(check_refund_after_tmax(s, disputed_at, MIN_RULING_WINDOW_S, now + 365 * DAY).is_err());
        assert!(check_execute_ruling(s, RULING_REFUND, ruled_at, MIN_TIMELOCK_S, now).is_err());
        assert!(check_release_after_window(s, shipped_at, REVIEW_WINDOW_S_LANE_S, now).is_err());
        assert!(check_refund_unshipped(s, T0, now).is_err());
        assert!(check_propose(s, PARTY_SELLER, 10, 100).is_ok());
        assert!(check_accept(s, PARTY_BUYER, PARTY_SELLER, 10, 10).is_ok());
    }

    #[test]
    fn settlement_rules() {
        for s in [STATE_DISPUTED, STATE_RULED] {
            assert!(check_propose(s, PARTY_BUYER, 0, 100).is_ok());
            assert!(check_propose(s, PARTY_SELLER, 100, 100).is_ok());
            assert_eq!(code(check_propose(s, PARTY_SELLER, 101, 100)), err(E::SettlementTooLarge));
            assert_eq!(code(check_propose(s, PARTY_ARBITER, 50, 100)), err(E::NotParty));
            assert_eq!(code(check_propose(s, PARTY_NONE, 50, 100)), err(E::NotParty));
            assert!(check_accept(s, PARTY_BUYER, PARTY_SELLER, 40, 40).is_ok());
            assert!(check_accept(s, PARTY_SELLER, PARTY_BUYER, 40, 40).is_ok());
            assert_eq!(code(check_accept(s, PARTY_BUYER, PARTY_BUYER, 40, 40)), err(E::OwnProposal));
            assert_eq!(code(check_accept(s, PARTY_BUYER, PARTY_NONE, 0, 0)), err(E::NoProposal));
            assert_eq!(code(check_accept(s, PARTY_BUYER, PARTY_SELLER, 40, 41)), err(E::ProposalMismatch));
            assert_eq!(code(check_accept(s, PARTY_ARBITER, PARTY_SELLER, 40, 40)), err(E::NotParty));
        }
        for s in [0, STATE_PAID, STATE_SHIPPED, STATE_RELEASED, STATE_REFUNDED, STATE_SETTLED] {
            assert_eq!(code(check_propose(s, PARTY_BUYER, 0, 100)), err(E::InvalidState), "state {s}");
            assert_eq!(code(check_accept(s, PARTY_BUYER, PARTY_SELLER, 0, 0)), err(E::InvalidState), "state {s}");
        }
    }

    #[test]
    fn close_only_terminal_orders_after_the_offer_expired() {
        for s in [STATE_RELEASED, STATE_REFUNDED, STATE_SETTLED] {
            assert!(check_close(s, T0, T0 + 1).is_ok());
            assert_eq!(code(check_close(s, T0, T0)), err(E::OfferNotExpired));
        }
        for s in [0, STATE_PAID, STATE_SHIPPED, STATE_DISPUTED, STATE_RULED] {
            assert_eq!(code(check_close(s, T0, T0 + 365 * DAY)), err(E::InvalidState), "state {s}");
        }
    }

    /// No key is needed for the money to leave the vault: from every non-terminal state some
    /// instruction anyone may send becomes valid after a bounded time, whatever the signed terms are.
    #[test]
    fn every_state_has_a_permissionless_exit() {
        let worst_ship = MAX_SHIP_WINDOW_S;
        let worst_review = REVIEW_WINDOW_S_LANE_A as i64;
        let worst_ruling = MAX_RULING_WINDOW_S as i64;
        let worst_timelock = MAX_TIMELOCK_S as i64;
        let opened = T0;
        let ship_deadline = opened + worst_ship;
        assert!(check_refund_unshipped(STATE_PAID, ship_deadline, ship_deadline + 1).is_ok());
        let shipped = ship_deadline;
        assert!(check_release_after_window(STATE_SHIPPED, shipped, REVIEW_WINDOW_S_LANE_A, shipped + worst_review + 1).is_ok());
        let disputed = shipped + worst_review;
        assert!(check_refund_after_tmax(STATE_DISPUTED, disputed, MAX_RULING_WINDOW_S, disputed + worst_ruling + 1).is_ok());
        let ruled = disputed + worst_ruling;
        assert!(check_execute_ruling(STATE_RULED, RULING_REFUND, ruled, MAX_TIMELOCK_S, ruled + worst_timelock + 1).is_ok());
        // the longest possible life of the deposit: 30 + 14 + 60 days + 72 h
        assert_eq!(ruled + worst_timelock + 1 - opened, 107 * DAY + 1);
    }
}
