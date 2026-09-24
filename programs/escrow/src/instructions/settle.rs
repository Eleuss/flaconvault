//! `release` · `dispute` (the latter also covers the briefing's `refund_mismatch`)

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::EscrowError,
    events::{OrderDisputed, OrderReleased},
    mpl_core::{transfer_v1, CoreTransfer},
    state::{EscrowConfig, Order},
};

/// Moves the whole vault balance to `to` and closes the vault (rent → `rent_to`), signed by the Order PDA.
fn drain_vault<'info>(
    order: &Account<'info, Order>,
    vault: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    rent_to: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
) -> Result<u64> {
    let amount = vault.amount;
    let seeds: &[&[u8]] = &[
        ORDER_SEED,
        order.passport.as_ref(),
        order.seller.as_ref(),
        &[order.bump],
    ];
    let signer: &[&[&[u8]]] = &[seeds];
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer {
                    from: vault.to_account_info(),
                    to,
                    authority: order.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to,
            authority: order.to_account_info(),
        },
        signer,
    ))?;
    Ok(amount)
}

/// Transfers the deposited Core asset from the Order PDA to `new_owner` (if any was deposited).
fn return_asset<'info>(
    order: &Account<'info, Order>,
    asset: &Option<UncheckedAccount<'info>>,
    core: &Option<UncheckedAccount<'info>>,
    payer: AccountInfo<'info>,
    new_owner: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
) -> Result<bool> {
    if !order.asset_deposited {
        return Ok(false);
    }
    let (asset, core) = match (asset, core) {
        (Some(a), Some(c)) => (a, c),
        _ => return err!(EscrowError::MissingAssetAccounts),
    };
    require_keys_eq!(asset.key(), order.asset, EscrowError::AssetMismatch);
    let seeds: &[&[u8]] = &[
        ORDER_SEED,
        order.passport.as_ref(),
        order.seller.as_ref(),
        &[order.bump],
    ];
    transfer_v1(
        &CoreTransfer {
            asset: &asset.to_account_info(),
            payer: &payer,
            authority: &order.to_account_info(),
            new_owner: &new_owner,
            system_program: &system_program,
            core_program: &core.to_account_info(),
        },
        &[seeds],
    )?;
    Ok(true)
}

/// Permissionless once the receipt scan matched: USDC → seller, Core asset → buyer.
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,
    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    /// Seller's USDC token account (destination).
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = order.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,
    /// CHECK: the order's buyer — receives the vault rent and (if deposited) the asset.
    #[account(mut, address = order.buyer @ EscrowError::NotBuyer)]
    pub buyer: UncheckedAccount<'info>,
    /// Anyone; pays the Core CPI fee if the asset is transferred.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: required only when the asset was deposited.
    #[account(mut)]
    pub asset: Option<UncheckedAccount<'info>>,
    /// CHECK: required only when the asset was deposited.
    pub mpl_core_program: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(
        order.state == ORDER_STATE_RECEIPT_SCANNED,
        EscrowError::InvalidState
    );

    let amount = drain_vault(
        order,
        &ctx.accounts.vault,
        ctx.accounts.seller_token.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.token_program,
    )?;
    let asset_transferred = return_asset(
        order,
        &ctx.accounts.asset,
        &ctx.accounts.mpl_core_program,
        ctx.accounts.caller.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    )?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.state = ORDER_STATE_RELEASED;
    order.asset_deposited = false;
    emit!(OrderReleased {
        order: order.key(),
        seller: order.seller,
        buyer: order.buyer,
        amount,
        asset_transferred,
        ts: now,
    });
    Ok(())
}

/// USDC → buyer, Core asset → seller (if deposited), state DISPUTE. Allowed for:
/// - the admin from RESERVED / PRESHIP_SCANNED / SHIPPED / MISMATCH;
/// - the buyer from MISMATCH (this is the briefing's `refund_mismatch`);
/// - the buyer from SHIPPED once `clock > shipped_at + dispute_after_s` (no receipt scan);
/// - the buyer from any funded state when the passed flacon `Seal` is dead.
#[derive(Accounts)]
pub struct Dispute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,
    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,
    /// Buyer's USDC token account (refund destination).
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = order.buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    /// CHECK: the order's buyer — receives the vault rent.
    #[account(mut, address = order.buyer @ EscrowError::NotBuyer)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: the order's seller — gets the asset back if it was deposited.
    #[account(address = order.seller @ EscrowError::NotSeller)]
    pub seller: UncheckedAccount<'info>,
    /// Admin or buyer (see rules above); pays the Core CPI fee if the asset is returned.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// flacon `Seal` of the order's passport — pass it to dispute on a dead seal.
    pub seal: Option<Account<'info, flacon::Seal>>,
    /// CHECK: required only when the asset was deposited.
    #[account(mut)]
    pub asset: Option<UncheckedAccount<'info>>,
    /// CHECK: required only when the asset was deposited.
    pub mpl_core_program: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_dispute(ctx: Context<Dispute>) -> Result<()> {
    let order = &ctx.accounts.order;
    let signer = ctx.accounts.signer.key();
    let now = Clock::get()?.unix_timestamp;
    let admin_states = matches!(
        order.state,
        ORDER_STATE_RESERVED | ORDER_STATE_PRESHIP_SCANNED | ORDER_STATE_SHIPPED | ORDER_STATE_MISMATCH
    );

    let reason = if signer == ctx.accounts.config.admin {
        require!(admin_states, EscrowError::InvalidState);
        DISPUTE_REASON_ADMIN
    } else if signer == order.buyer {
        if order.state == ORDER_STATE_MISMATCH {
            DISPUTE_REASON_MISMATCH
        } else if let Some(seal) = &ctx.accounts.seal {
            require_keys_eq!(seal.passport, order.passport, EscrowError::SealPassportMismatch);
            require!(seal.dead, EscrowError::SealNotDead);
            require!(order.is_funded(), EscrowError::InvalidState);
            DISPUTE_REASON_SEAL_DEAD
        } else {
            require!(order.state == ORDER_STATE_SHIPPED, EscrowError::InvalidState);
            let deadline = order
                .shipped_at
                .checked_add(order.dispute_after_s)
                .ok_or(EscrowError::MathOverflow)?;
            require!(now > deadline, EscrowError::DisputeWindowNotElapsed);
            DISPUTE_REASON_TIMEOUT
        }
    } else {
        return err!(EscrowError::Unauthorized);
    };

    let refunded = drain_vault(
        order,
        &ctx.accounts.vault,
        ctx.accounts.buyer_token.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.token_program,
    )?;
    let asset_returned = return_asset(
        order,
        &ctx.accounts.asset,
        &ctx.accounts.mpl_core_program,
        ctx.accounts.signer.to_account_info(),
        ctx.accounts.seller.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    )?;

    let previous_state = order.state;
    let order = &mut ctx.accounts.order;
    order.state = ORDER_STATE_DISPUTE;
    order.asset_deposited = false;
    emit!(OrderDisputed {
        order: order.key(),
        by: signer,
        reason,
        previous_state,
        refunded,
        asset_returned,
        ts: now,
    });
    Ok(())
}
