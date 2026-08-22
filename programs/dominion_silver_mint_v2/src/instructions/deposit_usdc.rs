// deposit_usdc: anyone can deposit USDC to refill the treasury.
// User signs the classic SPL transfer directly. Program reads pre/post and emits actual delta.
// Pinned accounts protect against account-confusion (must use real USDC mint + real treasury).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};

use crate::cpi::usdc_transfer_user_to_treasury;
use crate::errors::DominionError;
use crate::events::TreasuryDeposit;
use crate::state::*;

const MIN_DEPOSIT_USDC: u64 = 1_000_000; // 1 USDC

#[derive(Accounts)]
pub struct DepositUsdc<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Account<'info, ClassicMint>,

    #[account(mut, address = config.usdc_treasury)]
    pub usdc_treasury: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::token_program = classic_token_program,
    )]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
    // deposit_usdc is INTENTIONALLY
    // allowed while paused. A deposit only ADDS USDC to the treasury; it
    // cannot drain funds, cannot mint SILV, and touches no price/oracle path.
    // A paused protocol is precisely when an operator needs to refill the
    // treasury to recover an incident (e.g. to cover queued OTC IOUs before
    // unpausing). Blocking it had no upside and actively hurt incident
    // recovery. The pause matrix was re-reviewed for this relaxation: no
    // value-extracting path is reachable from this handler.
    require!(amount >= MIN_DEPOSIT_USDC, DominionError::BelowMinimum);

    let pre = ctx.accounts.usdc_treasury.amount;

    usdc_transfer_user_to_treasury(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.user_usdc_ata.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    ctx.accounts.usdc_treasury.reload()?;
    let post = ctx.accounts.usdc_treasury.amount;
    let delta = post.saturating_sub(pre);
    require!(delta > 0, DominionError::ZeroAmount);

    emit!(TreasuryDeposit {
        amount: delta,
        from: ctx.accounts.user.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
