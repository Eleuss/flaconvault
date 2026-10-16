//! Pure decision rules of the escrow (no accounts, no clock), so they can be unit-tested with
//! `cargo test -p escrow`; the instruction handlers only gather the inputs and apply the result.
//!
//! ```text
//! seller never ships   RESERVED / PRESHIP_SCANNED, now > reserved_at + window → buyer refund (TIMEOUT)
//! buyer never scans    SHIPPED,                     now > shipped_at  + window → anyone: pay the SELLER
//! scans disagree       MISMATCH                                               → only the admin: resolve(to_seller)
//! seal dead            RESERVED / PRESHIP_SCANNED                             → buyer refund (SEAL_DEAD)
//! seal dead, shipped   SHIPPED                                                → only the admin (dispute)
//! receipt matched      RECEIPT_SCANNED                                        → release only (no dispute)
//! admin                RESERVED / PRESHIP_SCANNED / SHIPPED                   → refund (ADMIN)
//! ```
//!
//! A dead seal after `ship` is left to the admin: the program cannot tell whether the seal died before
//! the parcel left or after it arrived (a `Seal` has no `dead_at`, and its layout is frozen), and the
//! issuer and the registry authority may mark a seal dead. A buyer who is (or works with) one of them
//! could otherwise keep the delivered bottle, kill its seal and take the USDC back.
//!
//! Scans: the shipping scan must be dated no earlier than `reserved_at − MAX_SCAN_TS_SKEW_S` and the
//! receipt scan no earlier than `shipped_at − MAX_SCAN_TS_SKEW_S` (`check_scan_not_before`), so an old
//! ScanProof (for example the scan from when the seller bought the bottle) never stands in for them.

use anchor_lang::prelude::*;

use crate::{constants::*, error::EscrowError};

/// The dispute window an order actually uses: the stored value clamped to
/// `MIN_DISPUTE_AFTER_S..=MAX_DISPUTE_AFTER_S` (orders listed before the bounds existed may hold
/// anything; clamping never shortens a window below one hour).
pub fn effective_window(dispute_after_s: i64) -> i64 {
    dispute_after_s.clamp(MIN_DISPUTE_AFTER_S, MAX_DISPUTE_AFTER_S)
}

/// `init_config` / `set_dispute_window` accept only 1 h ..= 60 days.
pub fn check_window(dispute_after_s: i64) -> Result<()> {
    require!(
        (MIN_DISPUTE_AFTER_S..=MAX_DISPUTE_AFTER_S).contains(&dispute_after_s),
        EscrowError::InvalidDisputeWindow
    );
    Ok(())
}

/// `now > start + window` (overflow-safe).
pub fn elapsed(start: i64, dispute_after_s: i64, now: i64) -> Result<bool> {
    let deadline = start
        .checked_add(effective_window(dispute_after_s))
        .ok_or(EscrowError::MathOverflow)?;
    Ok(now > deadline)
}

/// States in which the admin may refund the buyer through `dispute` (MISMATCH goes through `resolve`).
pub fn admin_may_refund(state: u8) -> bool {
    matches!(
        state,
        ORDER_STATE_RESERVED | ORDER_STATE_PRESHIP_SCANNED | ORDER_STATE_SHIPPED
    )
}

/// Inputs of a buyer's `dispute`.
pub struct BuyerDispute {
    pub state: u8,
    /// `Some(dead)` when a seal of the order's passport was passed.
    pub seal_dead: Option<bool>,
    pub reserved_at: i64,
    pub dispute_after_s: i64,
    pub now: i64,
}

/// The reason code of a buyer's refund, or the error that forbids it.
pub fn buyer_dispute_reason(d: &BuyerDispute) -> Result<u8> {
    if d.state == ORDER_STATE_RECEIPT_SCANNED {
        // the buyer's own receipt scan matched the shipping scan: the sale completes, nothing to dispute
        return err!(EscrowError::ReceiptMatched);
    }
    match d.seal_dead {
        Some(dead) => {
            require!(dead, EscrowError::SealNotDead);
            // shipped: the bottle may already be with the buyer; only the admin refunds (see module docs)
            require!(d.state != ORDER_STATE_SHIPPED, EscrowError::DeadSealAfterShipping);
            require!(
                d.state == ORDER_STATE_RESERVED || d.state == ORDER_STATE_PRESHIP_SCANNED,
                EscrowError::InvalidState
            );
            Ok(DISPUTE_REASON_SEAL_DEAD)
        }
        None => {
            // the seller never shipped: refund once the window after the reservation has passed
            require!(
                d.state == ORDER_STATE_RESERVED || d.state == ORDER_STATE_PRESHIP_SCANNED,
                EscrowError::InvalidState
            );
            require!(
                elapsed(d.reserved_at, d.dispute_after_s, d.now)?,
                EscrowError::DisputeWindowNotElapsed
            );
            Ok(DISPUTE_REASON_TIMEOUT)
        }
    }
}

/// `release_after_timeout`: SHIPPED and the buyer let the window after shipping pass without a receipt scan.
pub fn check_release_after_timeout(state: u8, shipped_at: i64, dispute_after_s: i64, now: i64) -> Result<()> {
    require!(state == ORDER_STATE_SHIPPED, EscrowError::InvalidState);
    require!(
        elapsed(shipped_at, dispute_after_s, now)?,
        EscrowError::DisputeWindowNotElapsed
    );
    Ok(())
}

/// Owner of a Metaplex Core `AssetV1` account (`Key` byte 1, owner at bytes 1..33), or `None` when the
/// account is not one (missing account, placeholder pubkey, collection, foreign program).
pub fn core_asset_owner(owner_program: &Pubkey, data: &[u8]) -> Option<Pubkey> {
    if owner_program != &MPL_CORE_PROGRAM_ID || data.len() < 33 || data[0] != MPL_CORE_KEY_ASSET_V1 {
        return None;
    }
    Pubkey::try_from(&data[1..33]).ok()
}

/// Who may sell a passport (checked by `list`, and again by `reserve` unless the asset is in the order's
/// custody): the owner of its Core asset when the asset exists; only when there is no Core asset behind
/// `passport.asset` (passports minted before the program checked it) the issuer, and only while the
/// issuer is still a registry partner or the authority (`issuer_active`), so a removed partner loses the
/// right to sell the bottles it issued. While the asset sits in an order's custody its owner is that
/// Order PDA, so nobody else can sell it.
pub fn check_seller(seller: &Pubkey, issuer: &Pubkey, asset_owner: Option<Pubkey>, issuer_active: bool) -> Result<()> {
    let allowed = match asset_owner {
        Some(owner) => &owner == seller,
        None => issuer == seller && issuer_active,
    };
    require!(allowed, EscrowError::NotPassportOwner);
    Ok(())
}

/// A scan linked to an order step must not predate it: `scan_ts >= step_at − MAX_SCAN_TS_SKEW_S`
/// (`step_at` = `reserved_at` for the shipping scan, `shipped_at` for the receipt scan). The allowance is
/// the clock skew flacon accepts between the server's signed ts and the cluster clock, so an honest scan
/// made after the step always passes.
pub fn check_scan_not_before(scan_ts: i64, step_at: i64) -> Result<()> {
    let earliest = step_at.saturating_sub(flacon::MAX_SCAN_TS_SKEW_S);
    require!(scan_ts >= earliest, EscrowError::ScanBeforeOrderStep);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600;
    const DAY: i64 = 86_400;

    fn code<T>(r: Result<T>) -> Option<u32> {
        match r {
            Ok(_) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Err(_) => Some(0),
        }
    }
    fn err(e: EscrowError) -> Option<u32> {
        Some(anchor_lang::error::ERROR_CODE_OFFSET + e as u32)
    }
    fn buyer(state: u8, seal_dead: Option<bool>, now: i64) -> Result<u8> {
        buyer_dispute_reason(&BuyerDispute { state, seal_dead, reserved_at: 1_000, dispute_after_s: 7 * DAY, now })
    }

    #[test]
    fn window_bounds() {
        assert!(check_window(H).is_ok());
        assert!(check_window(60 * DAY).is_ok());
        assert_eq!(code(check_window(H - 1)), err(EscrowError::InvalidDisputeWindow));
        assert_eq!(code(check_window(60 * DAY + 1)), err(EscrowError::InvalidDisputeWindow));
        assert_eq!(code(check_window(0)), err(EscrowError::InvalidDisputeWindow));
        assert_eq!(effective_window(1), H);
        assert_eq!(effective_window(7 * DAY), 7 * DAY);
        assert_eq!(effective_window(i64::MAX), 60 * DAY);
        assert_eq!(code(elapsed(i64::MAX, 7 * DAY, 0)), err(EscrowError::MathOverflow));
    }

    #[test]
    fn buyer_may_leave_when_the_seller_never_ships() {
        let after = 1_000 + 7 * DAY + 1;
        assert_eq!(buyer(ORDER_STATE_RESERVED, None, after).unwrap(), DISPUTE_REASON_TIMEOUT);
        assert_eq!(buyer(ORDER_STATE_PRESHIP_SCANNED, None, after).unwrap(), DISPUTE_REASON_TIMEOUT);
        assert_eq!(code(buyer(ORDER_STATE_RESERVED, None, 1_000 + 7 * DAY)), err(EscrowError::DisputeWindowNotElapsed));
        // a 1-second window stored on an old order still gives the seller one hour
        let short = BuyerDispute { state: ORDER_STATE_RESERVED, seal_dead: None, reserved_at: 1_000, dispute_after_s: 1, now: 1_002 };
        assert_eq!(code(buyer_dispute_reason(&short)), err(EscrowError::DisputeWindowNotElapsed));
    }

    #[test]
    fn buyer_cannot_refund_after_shipping_or_on_mismatch() {
        let late = 1_000 + 100 * DAY;
        // SHIPPED + timeout pays the seller (release_after_timeout), not the buyer
        assert_eq!(code(buyer(ORDER_STATE_SHIPPED, None, late)), err(EscrowError::InvalidState));
        // MISMATCH is settled by the admin (resolve)
        assert_eq!(code(buyer(ORDER_STATE_MISMATCH, None, late)), err(EscrowError::InvalidState));
        assert_eq!(code(buyer(ORDER_STATE_MISMATCH, Some(true), late)), err(EscrowError::InvalidState));
        assert_eq!(code(buyer(ORDER_STATE_LISTED, None, late)), err(EscrowError::InvalidState));
    }

    #[test]
    fn dead_seal_refund_only_before_shipping() {
        for s in [ORDER_STATE_RESERVED, ORDER_STATE_PRESHIP_SCANNED] {
            assert_eq!(buyer(s, Some(true), 0).unwrap(), DISPUTE_REASON_SEAL_DEAD);
            assert_eq!(code(buyer(s, Some(false), 0)), err(EscrowError::SealNotDead));
        }
        // shipped: the bottle may be with the buyer already — the admin decides, not the buyer
        assert_eq!(code(buyer(ORDER_STATE_SHIPPED, Some(true), 0)), err(EscrowError::DeadSealAfterShipping));
        assert_eq!(code(buyer(ORDER_STATE_SHIPPED, Some(true), i64::MAX / 2)), err(EscrowError::DeadSealAfterShipping));
        assert_eq!(code(buyer(ORDER_STATE_SHIPPED, Some(false), 0)), err(EscrowError::SealNotDead));
        assert!(admin_may_refund(ORDER_STATE_SHIPPED));
        assert_eq!(code(buyer(ORDER_STATE_RECEIPT_SCANNED, Some(true), 0)), err(EscrowError::ReceiptMatched));
        assert_eq!(code(buyer(ORDER_STATE_RECEIPT_SCANNED, None, i64::MAX / 2)), err(EscrowError::ReceiptMatched));
        for s in [ORDER_STATE_LISTED, ORDER_STATE_RELEASED, ORDER_STATE_DISPUTE, ORDER_STATE_CANCELLED] {
            assert_eq!(code(buyer(s, Some(true), 0)), err(EscrowError::InvalidState), "state {s}");
        }
    }

    #[test]
    fn scans_must_not_predate_the_order_step() {
        let step = 1_000_000;
        assert!(check_scan_not_before(step, step).is_ok());
        assert!(check_scan_not_before(step + DAY, step).is_ok());
        // the flacon clock-skew allowance: a scan signed up to 600 s before the step still counts
        assert!(check_scan_not_before(step - 600, step).is_ok());
        assert_eq!(code(check_scan_not_before(step - 601, step)), err(EscrowError::ScanBeforeOrderStep));
        // an old scan (e.g. from when the seller bought the bottle) never does
        assert_eq!(code(check_scan_not_before(step - 30 * DAY, step)), err(EscrowError::ScanBeforeOrderStep));
        assert_eq!(code(check_scan_not_before(i64::MIN, i64::MIN)), None);
        assert_eq!(code(check_scan_not_before(i64::MIN, 0)), err(EscrowError::ScanBeforeOrderStep));
    }

    #[test]
    fn admin_refund_states() {
        assert!(admin_may_refund(ORDER_STATE_RESERVED));
        assert!(admin_may_refund(ORDER_STATE_PRESHIP_SCANNED));
        assert!(admin_may_refund(ORDER_STATE_SHIPPED));
        for s in [ORDER_STATE_LISTED, ORDER_STATE_RECEIPT_SCANNED, ORDER_STATE_MISMATCH, ORDER_STATE_RELEASED, ORDER_STATE_DISPUTE, ORDER_STATE_CANCELLED] {
            assert!(!admin_may_refund(s), "state {s}");
        }
    }

    #[test]
    fn release_after_timeout_pays_the_seller_only_after_the_window() {
        assert!(check_release_after_timeout(ORDER_STATE_SHIPPED, 1_000, 2 * DAY, 1_000 + 2 * DAY + 1).is_ok());
        assert_eq!(code(check_release_after_timeout(ORDER_STATE_SHIPPED, 1_000, 2 * DAY, 1_000 + 2 * DAY)), err(EscrowError::DisputeWindowNotElapsed));
        assert_eq!(code(check_release_after_timeout(ORDER_STATE_MISMATCH, 1_000, H, i64::MAX / 2)), err(EscrowError::InvalidState));
        assert_eq!(code(check_release_after_timeout(ORDER_STATE_RECEIPT_SCANNED, 1_000, H, i64::MAX / 2)), err(EscrowError::InvalidState));
    }

    #[test]
    fn seller_rule() {
        let (a, b, issuer) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        for active in [true, false] {
            assert!(check_seller(&a, &issuer, Some(a), active).is_ok());
            assert_eq!(code(check_seller(&b, &issuer, Some(a), active)), err(EscrowError::NotPassportOwner));
            // once the asset changed hands the issuer can no longer sell it
            assert_eq!(code(check_seller(&issuer, &issuer, Some(a), active)), err(EscrowError::NotPassportOwner));
            assert_eq!(code(check_seller(&a, &issuer, None, active)), err(EscrowError::NotPassportOwner));
        }
        // no Core asset behind passport.asset: the issuer, while still a partner (or the authority)
        assert!(check_seller(&issuer, &issuer, None, true).is_ok());
        assert_eq!(code(check_seller(&issuer, &issuer, None, false)), err(EscrowError::NotPassportOwner));
    }

    #[test]
    fn core_asset_owner_parsing() {
        let owner = Pubkey::new_unique();
        let mut data = vec![MPL_CORE_KEY_ASSET_V1];
        data.extend_from_slice(owner.as_ref());
        data.push(0);
        assert_eq!(core_asset_owner(&MPL_CORE_PROGRAM_ID, &data), Some(owner));
        assert_eq!(core_asset_owner(&anchor_lang::system_program::ID, &data), None);
        assert_eq!(core_asset_owner(&MPL_CORE_PROGRAM_ID, &data[..32]), None);
        let mut collection = data.clone();
        collection[0] = 5;
        assert_eq!(core_asset_owner(&MPL_CORE_PROGRAM_ID, &collection), None);
        assert_eq!(core_asset_owner(&anchor_lang::system_program::ID, &[]), None);
    }
}
