//! `release` · `release_after_timeout` · `dispute` · `resolve` (admin settlement of MISMATCH, which
//! replaces the briefing's automatic `refund_mismatch`). Decision rules: `crate::rules`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::EscrowError,
    events::{OrderDisputed, OrderReleased, OrderResolved},
    mpl_core::{transfer_v1, CoreTransfer},
    rules::{admin_may_refund, buyer_dispute_reason, check_release_after_timeout, BuyerDispute},
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
    require!(
        ctx.accounts.order.state == ORDER_STATE_RECEIPT_SCANNED,
        EscrowError::InvalidState
    );
    settle_to_seller(ctx)
}

/// SHIPPED and the buyer let the window after shipping pass without a receipt scan: the seller is paid.
pub fn handle_release_after_timeout(ctx: Context<Release>) -> Result<()> {
    let order = &ctx.accounts.order;
    let now = Clock::get()?.unix_timestamp;
    check_release_after_timeout(order.state, order.shipped_at, order.dispute_after_s, now)?;
    settle_to_seller(ctx)
}

/// USDC → seller, vault rent → buyer, Core asset (if deposited) → buyer, state RELEASED.
fn settle_to_seller(ctx: Context<Release>) -> Result<()> {
    let order = &ctx.accounts.order;
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
/// - the admin from RESERVED / PRESHIP_SCANNED / SHIPPED (MISMATCH is settled with `resolve`);
/// - the buyer from RESERVED / PRESHIP_SCANNED once `clock > reserved_at + dispute_after_s` (the
///   seller did not ship in time);
/// - the buyer from RESERVED / PRESHIP_SCANNED / SHIPPED when the passed flacon `Seal` of the order's
///   passport is dead — never after a matching receipt scan (RECEIPT_SCANNED: release instead).
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

    let reason = if signer == ctx.accounts.config.admin {
        require!(admin_may_refund(order.state), EscrowError::InvalidState);
        DISPUTE_REASON_ADMIN
    } else if signer == order.buyer {
        let seal_dead = match &ctx.accounts.seal {
            Some(seal) => {
                require_keys_eq!(seal.passport, order.passport, EscrowError::SealPassportMismatch);
                Some(seal.dead)
            }
            None => None,
        };
        buyer_dispute_reason(&BuyerDispute {
            state: order.state,
            seal_dead,
            reserved_at: order.reserved_at,
            dispute_after_s: order.dispute_after_s,
            now,
        })?
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

/// The escrow admin settles a MISMATCH order (the scans disagreed): `to_seller` → USDC to the seller and
/// the deposited asset to the buyer (RELEASED); otherwise USDC back to the buyer and the asset back to
/// the seller (DISPUTE). The vault rent goes to the buyer, who paid it.
#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ EscrowError::Unauthorized
    )]
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
    /// USDC account of the seller (`to_seller`) or of the buyer (otherwise).
    #[account(mut, token::mint = config.usdc_mint)]
    pub recipient_token: Account<'info, TokenAccount>,
    /// CHECK: the order's buyer — receives the vault rent (and the asset when `to_seller`).
    #[account(mut, address = order.buyer @ EscrowError::NotBuyer)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: the order's seller — gets the asset back when the buyer is refunded.
    #[account(address = order.seller @ EscrowError::NotSeller)]
    pub seller: UncheckedAccount<'info>,
    /// The escrow admin; pays the Core CPI fee if the asset moves.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: required only when the asset was deposited.
    #[account(mut)]
    pub asset: Option<UncheckedAccount<'info>>,
    /// CHECK: required only when the asset was deposited.
    pub mpl_core_program: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_resolve(ctx: Context<Resolve>, to_seller: bool) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.state == ORDER_STATE_MISMATCH, EscrowError::InvalidState);
    let recipient = if to_seller { order.seller } else { order.buyer };
    require_keys_eq!(
        ctx.accounts.recipient_token.owner,
        recipient,
        EscrowError::WrongTokenOwner
    );

    let amount = drain_vault(
        order,
        &ctx.accounts.vault,
        ctx.accounts.recipient_token.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.token_program,
    )?;
    let asset_to = if to_seller {
        ctx.accounts.buyer.to_account_info()
    } else {
        ctx.accounts.seller.to_account_info()
    };
    let asset_transferred = return_asset(
        order,
        &ctx.accounts.asset,
        &ctx.accounts.mpl_core_program,
        ctx.accounts.admin.to_account_info(),
        asset_to,
        ctx.accounts.system_program.to_account_info(),
    )?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.state = if to_seller {
        ORDER_STATE_RELEASED
    } else {
        ORDER_STATE_DISPUTE
    };
    order.asset_deposited = false;
    emit!(OrderResolved {
        order: order.key(),
        admin: ctx.accounts.admin.key(),
        to_seller,
        amount,
        asset_transferred,
        ts: now,
    });
    Ok(())
}
