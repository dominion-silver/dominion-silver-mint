use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::errors::DominionError;
use crate::state::ConfigAccount;

// Oracle internal scale: silver price stored as u128, USD per oz with 9 decimals.
// e.g. $30.245 => 30_245_000_000.
pub const PRICE_SCALE: u32 = 9;

/// Reads the Pyth XAG/USD price and applies all guards.
/// Returns the normalized u128 price (scaled to 9 decimals).
///
/// Guards enforced:
///   - Anchor `owner = config.pyth_receiver_program` constraint on the price_update account (caller-side).
///   - Atomic feed_id match + staleness via `get_price_no_older_than`.
///   - Verification level == Full.
///   - Price > 0 (rejects negative i64 cast bug).
///   - Confidence interval within `max_confidence_bps` of price.
///   - Exponent branch: `combined_exp = 9 + price.exponent` is bounded |x| <= 18 to prevent u128 overflow on pow.
///   - Sanity bounds: `min_price_usd_scaled <= normalized <= max_price_usd_scaled`.
pub fn read_silver_price(
    price_update: &Account<PriceUpdateV2>,
    config: &ConfigAccount,
    clock: &Clock,
) -> Result<u128> {
    let price_data = price_update
        .get_price_no_older_than(
            clock,
            config.max_staleness_seconds as u64,
            &config.pyth_feed_id,
        )
        .map_err(|_| error!(DominionError::StaleOracle))?;

    require!(
        price_update.verification_level == VerificationLevel::Full,
        DominionError::OracleNotFullyVerified
    );

    require!(price_data.price > 0, DominionError::NegativeOraclePrice);

    let price_u128 = price_data.price as u128;
    let conf_u128 = price_data.conf as u128;

    // confidence (in price units) must be within max_confidence_bps of price.
    let lhs = conf_u128
        .checked_mul(10_000)
        .ok_or(DominionError::ArithmeticOverflow)?;
    let rhs = price_u128
        .checked_mul(config.max_confidence_bps as u128)
        .ok_or(DominionError::ArithmeticOverflow)?;
    require!(lhs <= rhs, DominionError::OracleLowConfidence);

    let combined_exp: i32 = (PRICE_SCALE as i32) + price_data.exponent;
    require!(
        combined_exp.unsigned_abs() <= 18,
        DominionError::OracleScalingOutOfBounds
    );

    let normalized: u128 = if combined_exp >= 0 {
        price_u128
            .checked_mul(10u128.pow(combined_exp as u32))
            .ok_or(DominionError::ArithmeticOverflow)?
    } else {
        price_u128
            .checked_div(10u128.pow(combined_exp.unsigned_abs()))
            .ok_or(DominionError::ArithmeticOverflow)?
    };

    require!(
        normalized >= config.min_price_usd_scaled as u128,
        DominionError::PriceOutOfBounds
    );
    require!(
        normalized <= config.max_price_usd_scaled as u128,
        DominionError::PriceOutOfBounds
    );

    Ok(normalized)
}

/// Price-delta circuit breaker (D11).
/// If the last recorded price is newer than the decay window, reject big moves.
/// Initial state (last_recorded_price == 0) bypasses (first tx bootstraps).
pub fn check_price_delta(config: &ConfigAccount, new_price: u128, now: i64) -> Result<()> {
    if config.last_recorded_price_scaled == 0 {
        return Ok(()); // bootstrap
    }
    let elapsed = now.saturating_sub(config.last_price_update_at);
    if elapsed > config.price_delta_decay_seconds as i64 {
        return Ok(()); // decayed; re-arms on next accepted tx
    }

    let last = config.last_recorded_price_scaled;
    let delta = if new_price >= last {
        new_price - last
    } else {
        last - new_price
    };
    let lhs = delta
        .checked_mul(10_000)
        .ok_or(DominionError::ArithmeticOverflow)?;
    let rhs = last
        .checked_mul(config.max_price_delta_bps as u128)
        .ok_or(DominionError::ArithmeticOverflow)?;
    require!(lhs <= rhs, DominionError::PriceDeltaExceeded);
    Ok(())
}

/// D38 dust filter: only update last_recorded_price if amount is large enough.
pub fn maybe_update_last_price(
    config: &mut ConfigAccount,
    new_price: u128,
    amount_usdc_equiv: u64,
    now: i64,
) {
    if amount_usdc_equiv >= config.price_update_min_amount_usdc {
        config.last_recorded_price_scaled = new_price;
        config.last_price_update_at = now;
    }
}

// Option B 2026-05-15: update_reserve_check_price (D41 slow-track) removed.
// Option B has no on-chain reserve, so there is no reserve-check price to
// slow-track. Pricing uses the live oracle directly. See CONFIRMED_SPEC.md
// Section 2.
