// Option B instant admin parameter setters (CONFIRMED_SPEC.md §6, change-path
// = "instant"). The Option A per-tx min/max + daily + hourly cap setters are
// gone (those config fields no longer exist). These are the "parametrable
// within hardcoded safe bounds" surface (D14): every value is admin-tunable
// from the panel with NO timelock (they only tune rate-limits / the supply
// cap; none moves money), but each is clamped by a compile-time ceiling so a
// compromised or fat-finger admin cannot set a catastrophic value.
//
// Float (treasury_min_float_usdc) and premiums/oracle-guards are NOT here:
// those are sensitive and go through the 24h timelock (propose/execute).

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::*;

#[derive(Accounts)]
pub struct SetParam<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,
}

/// D2: raise/lower the HARD SILV supply cap, in atomic SILV (oz * 1e6). The
/// panel sends "increase by N oz" as a new absolute value. Raising is low
/// risk (cap can only gate NEW mints, can't harm holders); instant.
pub fn set_max_silv_supply_handler(ctx: Context<SetParam>, new_max: u64) -> Result<()> {
    require!(
        new_max <= MAX_SILV_SUPPLY_CEILING,
        DominionError::AboveMaximum
    );
    ctx.accounts.config.max_silv_supply = new_max;
    Ok(())
}

/// D11: the manual redemptions on/off switch (no auto-expiry, Mark's explicit
/// choice). Disabling blocks NEW instant + queued redemptions; already-queued
/// claims stay claimable (§8). Instant.
pub fn set_redemptions_enabled_handler(ctx: Context<SetParam>, enabled: bool) -> Result<()> {
    ctx.accounts.config.redemptions_enabled = enabled;
    Ok(())
}

/// D10: the GLOBAL rolling-window instant-redeem budget (atomic USDC, all
/// users combined). The Sybil-proof structuring defense. Instant.
pub fn set_instant_redeem_budget_handler(
    ctx: Context<SetParam>,
    new_budget_usdc: u64,
) -> Result<()> {
    require!(
        new_budget_usdc <= INSTANT_BUDGET_CEILING_USDC,
        DominionError::AboveMaximum
    );
    ctx.accounts.config.instant_redeem_budget_usdc = new_budget_usdc;
    Ok(())
}

/// D10: the rolling-window length in seconds. Bounded [1 min, 7 days].
pub fn set_instant_redeem_window_handler(
    ctx: Context<SetParam>,
    new_window_seconds: u32,
) -> Result<()> {
    require!(
        new_window_seconds >= INSTANT_WINDOW_MIN_SECONDS
            && new_window_seconds <= INSTANT_WINDOW_MAX_SECONDS,
        DominionError::AboveMaximum
    );
    ctx.accounts.config.instant_redeem_window_seconds = new_window_seconds;
    Ok(())
}

/// D10: single-redeem size at/above which a redeem is forced to the T+3 queue.
/// 0 = force ALL redemptions to queue (valid admin choice). No upper bound:
/// the rolling-window budget is the real protection regardless of this value.
pub fn set_large_redeem_threshold_handler(
    ctx: Context<SetParam>,
    new_threshold_usdc: u64,
) -> Result<()> {
    ctx.accounts.config.large_redeem_threshold_usdc = new_threshold_usdc;
    Ok(())
}

/// D8: the queued-redemption delay (T+N) in seconds. Bounded [0, 30 days];
/// 0 = claimable immediately after queueing (valid but unusual).
pub fn set_redeem_queue_delay_handler(
    ctx: Context<SetParam>,
    new_delay_seconds: u32,
) -> Result<()> {
    require!(
        new_delay_seconds <= REDEEM_QUEUE_DELAY_MAX_SECONDS,
        DominionError::AboveMaximum
    );
    ctx.accounts.config.redeem_queue_delay_seconds = new_delay_seconds;
    Ok(())
}
