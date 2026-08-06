// DEV-MODE ADMIN INSTRUCTIONS. These bypass the 24h timelock that normally protects these
// parameters, and exist to make devnet UX testing tractable (e.g. a browser-flow staleness budget
// larger than the 15s default). Compiled ONLY under the non-default `dev-hatch` feature (see lib.rs),
// so they are absent from release builds and from the IDL. The mainnet path is
// propose_set_oracle_guards + execute_set_oracle_guards. They still enforce the SAME PRODUCTION
// BOUNDS as the timelocked path, so a fat-fingered devnet call cannot reach a state mainnet
// governance could not.

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::DevParamSet;
use crate::state::*;

#[derive(Accounts)]
pub struct DevSetOracleParam<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,
}

/// Bumps `max_staleness_seconds` instantly (no timelock). Bound 30..=120s: below 30 every update
/// arrives stale and all mints/redeems revert, above 120 the threat model's freshness assumption goes.
pub fn dev_set_max_staleness_handler(ctx: Context<DevSetOracleParam>, secs: u32) -> Result<()> {
    require!(secs >= 30, DominionError::BelowMinimum);
    require!(secs <= 120, DominionError::AboveMaximum);
    let config = &mut ctx.accounts.config;
    config.max_staleness_seconds = secs;
    let now = Clock::get()?.unix_timestamp;
    emit!(DevParamSet {
        admin: ctx.accounts.admin.key(),
        param: 1, // 1 = max_staleness_seconds
        value_a: secs as u64,
        value_b: 0,
        timestamp: now,
    });
    Ok(())
}

/// Sets both premiums instantly (no timelock), under the same bounds as the timelocked path. Without
/// them one fat-finger could set a 100% mint premium (users mint 0 SILV) or 0/0 (free arbitrage).
pub fn dev_set_premiums_handler(
    ctx: Context<DevSetOracleParam>,
    mint_bps: u16,
    redeem_bps: u16,
) -> Result<()> {
    require!(
        mint_bps <= PREMIUM_BPS_MINT_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        redeem_bps <= PREMIUM_BPS_REDEEM_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (mint_bps as u32) + (redeem_bps as u32) >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );
    let config = &mut ctx.accounts.config;
    config.premium_bps_mint = mint_bps;
    config.premium_bps_redeem = redeem_bps;
    // POST-WRITE invariant: the checks above validate the CANDIDATE, this the STORED pair.
    config.assert_premium_within_bounds()?;
    let now = Clock::get()?.unix_timestamp;
    emit!(DevParamSet {
        admin: ctx.accounts.admin.key(),
        param: 2, // 2 = premiums (mint, redeem)
        value_a: mint_bps as u64,
        value_b: redeem_bps as u64,
        timestamp: now,
    });
    Ok(())
}
