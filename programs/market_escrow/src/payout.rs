//! Token movements out of an order vault. Every payout amount comes from `rules.rs`; the recipients
//! are fixed by the accounts (`associated_token::authority = order.buyer / order.seller`, the fee vault
//! PDA), so a caller can only choose *when* a payout happens, never *where* it goes.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    events::{OrderRefunded, OrderReleased},
    rules::{refund_payout, release_payout},
    state::MarketOrder,
};

/// Transfers `amount` from the order vault to `to`, signed by the order PDA (nothing for 0).
pub fn pay<'info>(
    order: &Account<'info, MarketOrder>,
    vault: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    amount: u64,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [order.bump];
    let seeds: &[&[u8]] = &[
        ORDER_SEED,
        order.buyer.as_ref(),
        order.order_id.as_ref(),
        &bump,
    ];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to,
                authority: order.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Release: `amount − seller_fee` to the seller, `buyer_fee + seller_fee` to the fee vault.
pub fn release<'info>(
    order: &mut Account<'info, MarketOrder>,
    vault: &Account<'info, TokenAccount>,
    seller_token: AccountInfo<'info>,
    fee_vault: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    resolution: u8,
    now: i64,
) -> Result<()> {
    let p = release_payout(order.amount, order.buyer_fee, order.seller_fee)?;
    pay(order, vault, seller_token, p.to_seller, token_program)?;
    pay(order, vault, fee_vault, p.to_fees, token_program)?;
    order.state = STATE_RELEASED;
    order.resolution = resolution;
    order.ended_at = now;
    emit!(OrderReleased {
        order: order.key(),
        resolution,
        to_seller: p.to_seller,
        fees: p.to_fees,
        ts: now,
    });
    Ok(())
}

/// Full refund: the whole deposit (buyer fee included) back to the buyer.
pub fn refund<'info>(
    order: &mut Account<'info, MarketOrder>,
    vault: &Account<'info, TokenAccount>,
    buyer_token: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    resolution: u8,
    now: i64,
) -> Result<()> {
    let p = refund_payout(order.amount, order.buyer_fee)?;
    pay(order, vault, buyer_token, p.to_buyer, token_program)?;
    order.state = STATE_REFUNDED;
    order.resolution = resolution;
    order.ended_at = now;
    emit!(OrderRefunded {
        order: order.key(),
        resolution,
        to_buyer: p.to_buyer,
        ts: now,
    });
    Ok(())
}
