//! `record_pre_ship_scan` · `ship` · `record_receipt_scan`

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::{OrderShipped, PreShipScanRecorded, ReceiptScanRecorded},
    state::Order,
};

/// Shared checks: the ScanProof belongs to `seal`, the seal to the order's passport,
/// and the scan was attested by `expected_attester`.
fn check_scan(
    order: &Order,
    scan_proof: &flacon::ScanProof,
    seal_key: Pubkey,
    seal: &flacon::Seal,
    expected_attester: Pubkey,
) -> Result<()> {
    require_keys_eq!(scan_proof.seal, seal_key, EscrowError::ScanSealMismatch);
    require_keys_eq!(seal.passport, order.passport, EscrowError::SealPassportMismatch);
    require_keys_eq!(
        scan_proof.attester,
        expected_attester,
        EscrowError::ScanAttesterMismatch
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RecordPreShipScan<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump,
        has_one = seller @ EscrowError::NotSeller
    )]
    pub order: Account<'info, Order>,
    pub seller: Signer<'info>,
    /// flacon `ScanProof` of the seller's pre-ship scan.
    pub scan_proof: Account<'info, flacon::ScanProof>,
    /// flacon `Seal` the scan was made on.
    pub seal: Account<'info, flacon::Seal>,
}

pub fn handle_record_pre_ship_scan(ctx: Context<RecordPreShipScan>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.state == ORDER_STATE_RESERVED, EscrowError::InvalidState);
    check_scan(
        order,
        &ctx.accounts.scan_proof,
        ctx.accounts.seal.key(),
        &ctx.accounts.seal,
        order.seller,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.seller_scan = ctx.accounts.scan_proof.key();
    order.state = ORDER_STATE_PRESHIP_SCANNED;
    emit!(PreShipScanRecorded {
        order: order.key(),
        scan_proof: order.seller_scan,
        counter: ctx.accounts.scan_proof.counter,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Ship<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump,
        has_one = seller @ EscrowError::NotSeller
    )]
    pub order: Account<'info, Order>,
    pub seller: Signer<'info>,
}

pub fn handle_ship(ctx: Context<Ship>) -> Result<()> {
    let order = &mut ctx.accounts.order;
    require!(
        order.state == ORDER_STATE_PRESHIP_SCANNED,
        EscrowError::InvalidState
    );
    let now = Clock::get()?.unix_timestamp;
    order.shipped_at = now;
    order.state = ORDER_STATE_SHIPPED;
    emit!(OrderShipped {
        order: order.key(),
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordReceiptScan<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump,
        has_one = buyer @ EscrowError::NotBuyer
    )]
    pub order: Account<'info, Order>,
    pub buyer: Signer<'info>,
    /// flacon `ScanProof` of the buyer's receipt scan.
    pub scan_proof: Account<'info, flacon::ScanProof>,
    /// flacon `Seal` the receipt scan was made on.
    pub seal: Account<'info, flacon::Seal>,
    /// The seller's pre-ship `ScanProof` recorded on the order.
    #[account(address = order.seller_scan @ EscrowError::SellerScanMismatch)]
    pub seller_scan: Account<'info, flacon::ScanProof>,
}

/// Compares the receipt scan with the pre-ship scan (briefing §11): `heat` equal,
/// `hum` equal, |fill difference| ≤ FILL_TOLERANCE → RECEIPT_SCANNED, else MISMATCH.
pub fn handle_record_receipt_scan(ctx: Context<RecordReceiptScan>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.state == ORDER_STATE_SHIPPED, EscrowError::InvalidState);
    let buyer_scan = &ctx.accounts.scan_proof;
    let seller_scan = &ctx.accounts.seller_scan;
    check_scan(
        order,
        buyer_scan,
        ctx.accounts.seal.key(),
        &ctx.accounts.seal,
        order.buyer,
    )?;
    // Same seal ⇒ the receipt tap must be newer than the pre-ship tap.
    if buyer_scan.seal == seller_scan.seal {
        require!(
            buyer_scan.counter > seller_scan.counter,
            EscrowError::ReceiptScanNotNewer
        );
    }

    let fill_diff = buyer_scan.fill.abs_diff(seller_scan.fill);
    let matched = buyer_scan.heat == seller_scan.heat
        && buyer_scan.hum == seller_scan.hum
        && fill_diff <= FILL_TOLERANCE;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.buyer_scan = buyer_scan.key();
    order.state = if matched {
        ORDER_STATE_RECEIPT_SCANNED
    } else {
        ORDER_STATE_MISMATCH
    };
    emit!(ReceiptScanRecorded {
        order: order.key(),
        scan_proof: order.buyer_scan,
        counter: buyer_scan.counter,
        matched,
        seller_fill: seller_scan.fill,
        buyer_fill: buyer_scan.fill,
        seller_heat: seller_scan.heat,
        buyer_heat: buyer_scan.heat,
        seller_hum: seller_scan.hum,
        buyer_hum: buyer_scan.hum,
        ts: now,
    });
    Ok(())
}
