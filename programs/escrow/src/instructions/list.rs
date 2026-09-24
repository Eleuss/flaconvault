//! `list` · `deposit_asset` · `cancel` · `close_order`

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::{AssetDeposited, OrderCancelled, OrderClosed, OrderListed},
    mpl_core::{transfer_v1, CoreTransfer},
    state::{EscrowConfig, Order},
};

#[derive(Accounts)]
pub struct List<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, EscrowConfig>,
    /// flacon `Passport` (owner = flacon program, discriminator checked).
    pub passport: Account<'info, flacon::Passport>,
    #[account(
        init,
        payer = seller,
        space = Order::LEN,
        seeds = [ORDER_SEED, passport.key().as_ref(), seller.key().as_ref()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_list(ctx: Context<List>, price: u64) -> Result<()> {
    require!(price > 0, EscrowError::InvalidPrice);
    require!(!ctx.accounts.passport.void, EscrowError::PassportVoid);
    let now = Clock::get()?.unix_timestamp;

    let order = &mut ctx.accounts.order;
    order.passport = ctx.accounts.passport.key();
    order.seller = ctx.accounts.seller.key();
    order.buyer = Pubkey::default();
    order.asset = ctx.accounts.passport.asset;
    order.price = price;
    order.state = ORDER_STATE_LISTED;
    order.listed_at = now;
    order.reserved_at = 0;
    order.shipped_at = 0;
    order.seller_scan = Pubkey::default();
    order.buyer_scan = Pubkey::default();
    order.dispute_after_s = ctx.accounts.config.dispute_after_s;
    order.asset_deposited = false;
    order.bump = ctx.bumps.order;
    order.vault_bump = 0;

    emit!(OrderListed {
        order: order.key(),
        passport: order.passport,
        seller: order.seller,
        asset: order.asset,
        price,
        dispute_after_s: order.dispute_after_s,
        ts: now,
    });
    Ok(())
}

/// Moves the Core asset into the Order PDA's custody (seller must be its owner).
/// Optional in the hackathon flow: everything else works without it.
#[derive(Accounts)]
pub struct DepositAsset<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump,
        has_one = seller @ EscrowError::NotSeller
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Metaplex Core asset, must equal `order.asset`; ownership is validated by Core.
    #[account(mut, address = order.asset @ EscrowError::AssetMismatch)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: address checked against the Core program id.
    #[account(address = MPL_CORE_PROGRAM_ID @ EscrowError::InvalidCoreProgram)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit_asset(ctx: Context<DepositAsset>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.state == ORDER_STATE_LISTED, EscrowError::InvalidState);
    require!(!order.asset_deposited, EscrowError::AssetAlreadyDeposited);

    transfer_v1(
        &CoreTransfer {
            asset: &ctx.accounts.asset.to_account_info(),
            payer: &ctx.accounts.seller.to_account_info(),
            authority: &ctx.accounts.seller.to_account_info(),
            new_owner: &ctx.accounts.order.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            core_program: &ctx.accounts.mpl_core_program.to_account_info(),
        },
        &[],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.asset_deposited = true;
    emit!(AssetDeposited {
        order: order.key(),
        asset: order.asset,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump,
        has_one = seller @ EscrowError::NotSeller
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: required only when the asset was deposited (returned to the seller).
    #[account(mut)]
    pub asset: Option<UncheckedAccount<'info>>,
    /// CHECK: required only when the asset was deposited.
    pub mpl_core_program: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.state == ORDER_STATE_LISTED, EscrowError::InvalidState);

    if order.asset_deposited {
        let (asset, core) = match (&ctx.accounts.asset, &ctx.accounts.mpl_core_program) {
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
                payer: &ctx.accounts.seller.to_account_info(),
                authority: &order.to_account_info(),
                new_owner: &ctx.accounts.seller.to_account_info(),
                system_program: &ctx.accounts.system_program.to_account_info(),
                core_program: &core.to_account_info(),
            },
            &[seeds],
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.state = ORDER_STATE_CANCELLED;
    order.asset_deposited = false;
    emit!(OrderCancelled {
        order: order.key(),
        seller: order.seller,
        ts: now,
    });
    Ok(())
}

/// Reclaims the Order account (rent → seller) once it is terminal, so the same
/// passport can be listed again by the same seller (the PDA has no nonce).
#[derive(Accounts)]
pub struct CloseOrder<'info> {
    #[account(
        mut,
        close = seller,
        seeds = [ORDER_SEED, order.passport.as_ref(), order.seller.as_ref()],
        bump = order.bump,
        has_one = seller @ EscrowError::NotSeller
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub seller: Signer<'info>,
}

pub fn handle_close_order(ctx: Context<CloseOrder>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(order.is_terminal(), EscrowError::InvalidState);
    emit!(OrderClosed {
        order: order.key(),
        seller: order.seller,
        final_state: order.state,
    });
    Ok(())
}
