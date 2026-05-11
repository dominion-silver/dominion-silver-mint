use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct SetCaps<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,
}

pub fn set_mint_caps_handler(
    ctx: Context<SetCaps>,
    min_tx_usdc: u64,
    max_tx_usdc: u64,
    daily_cap_usdc: u64,
) -> Result<()> {
    require!(min_tx_usdc > 0, crate::errors::DominionError::ZeroAmount);
    require!(
        max_tx_usdc >= min_tx_usdc,
        crate::errors::DominionError::AboveMaximum
    );
    require!(
        daily_cap_usdc >= max_tx_usdc,
        crate::errors::DominionError::AboveMaximum
    );
    let config = &mut ctx.accounts.config;
    config.min_mint_amount_usdc = min_tx_usdc;
    config.max_mint_amount_per_tx_usdc = max_tx_usdc;
    config.daily_mint_cap_usdc = daily_cap_usdc;
    Ok(())
}

pub fn set_redeem_caps_handler(
    ctx: Context<SetCaps>,
    min_tx_usdc: u64,
    max_tx_usdc: u64,
    daily_cap_usdc: u64,
) -> Result<()> {
    require!(min_tx_usdc > 0, crate::errors::DominionError::ZeroAmount);
    require!(
        max_tx_usdc >= min_tx_usdc,
        crate::errors::DominionError::AboveMaximum
    );
    require!(
        daily_cap_usdc >= max_tx_usdc,
        crate::errors::DominionError::AboveMaximum
    );
    let config = &mut ctx.accounts.config;
    config.min_redeem_amount_usdc = min_tx_usdc;
    config.max_redeem_amount_per_tx_usdc = max_tx_usdc;
    config.daily_redeem_cap_usdc = daily_cap_usdc;
    Ok(())
}

pub fn set_hourly_redeem_cap_handler(ctx: Context<SetCaps>, bps: u16) -> Result<()> {
    require!(bps <= 10_000, crate::errors::DominionError::AboveMaximum);
    let config = &mut ctx.accounts.config;
    config.hourly_redeem_cap_bps_of_snapshot = bps;
    Ok(())
}
