// DEV-MODE ADMIN INSTRUCTIONS.
//
// REMOVE OR FEATURE-GATE BEFORE MAINNET. These bypass the 24h timelock
// that normally protects security-sensitive parameters. They exist to
// make devnet/testnet UX testing tractable (e.g. browser-flow staleness
// budget vs. the 15s default).
//
// Mainnet path: use propose_set_oracle_guards + execute_set_oracle_guards
// (24h timelock, see admin/propose.rs).
//
// SAFETY: even though these are dev-only, we enforce the SAME PRODUCTION
// BOUNDS that the timelocked path enforces (PREMIUM_BPS_MINT_CEILING /
// PREMIUM_BPS_REDEEM_CEILING, PREMIUM_BPS_COMBINED_FLOOR, sane staleness
// floor/ceiling). This way a
// fat-fingered devnet call cannot push the contract into a state that
// would never be reachable via mainnet governance. (REVIEW_REPORT.md
// SC-C1, SC-H4, SC-M1, SC-M7.)

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

/// Bumps `max_staleness_seconds` instantly (no timelock).
/// Bound: 30..=120 sec.
///   - Floor 30s: anything lower would brick the protocol (every Pyth
///     update arrives stale, all mints/redeems revert). SC-H4.
///   - Ceiling 120s: anything higher defeats the oracle-freshness
///     threat-model assumption. SC-M1.
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

/// Sets mint and redeem premiums instantly (no timelock).
///
/// Same bounds as the timelocked path's `assert_premium_within_bounds`:
///   - mint <= PREMIUM_BPS_MINT_CEILING (2000 bps), redeem <= PREMIUM_BPS_REDEEM_CEILING (1000 bps)
///   - sum >= PREMIUM_BPS_COMBINED_FLOOR (500 bps = 5%)
///
/// Without these bounds (SC-C1) a single fat-finger could:
///   - set 100% mint premium -> users mint 0 SILV per 100 USDC (loss),
///   - set 0/0 premiums -> zero-cost arbitrage between mint + redeem.
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
