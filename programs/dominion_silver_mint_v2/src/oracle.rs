use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::lazer::{self, LazerError};
use crate::lazer_cpi::{self, LazerVerifyAccounts};
use crate::lazer_price::{self, LazerPolicyError, LazerPolicyParams, LazerPriceResult};
use crate::state::{ConfigAccount, LAZER_CHANNEL_ID, LAZER_FUTURE_SKEW_US};

// Oracle internal scale: silver price stored as u128, USD per oz with 9 decimals.
// e.g. $30.245 => 30_245_000_000.
pub const PRICE_SCALE: u32 = 9;

/// Reads the SILV price from Pyth Lazer and applies all guards.
///
/// Glues the three Lazer modules: verify the signed message via the upgradeable
/// Lazer program (isolated fee-payer PDA), parse the returned payload, apply the
/// Sections 5.4-5.6 policy. Returns the normalized 9-decimal price + the print's
/// feedUpdateTimestamp; the CALLER persists that as the non-decreasing
/// high-water mark (`config.last_used_feed_update_timestamp_us`) on an accepted
/// op. `message_data` is the SAME buffer passed to the verify CPI (one-buffer
/// invariant) - the policy parses ONLY the CPI-returned payload.
#[allow(clippy::too_many_arguments)]
pub fn read_silver_price_lazer(
    lazer_accts: &LazerVerifyAccounts,
    fee_payer_bump: u8,
    config: &ConfigAccount,
    clock: &Clock,
    message_data: Vec<u8>,
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<LazerPriceResult> {
    let payload = lazer_cpi::verify_and_get_payload(
        lazer_accts,
        fee_payer_bump,
        message_data,
        ed25519_instruction_index,
        signature_index,
    )?;

    let lp = lazer::extract_feed_price(&payload, config.pyth_lazer_feed_id, LAZER_CHANNEL_ID)
        .map_err(map_parse_err)?;

    let now_us = (clock.unix_timestamp.max(0) as u64).saturating_mul(1_000_000);
    let params = LazerPolicyParams {
        max_staleness_us: (config.max_staleness_seconds as u64).saturating_mul(1_000_000),
        future_skew_us: LAZER_FUTURE_SKEW_US,
        max_confidence_bps: config.max_confidence_bps,
        min_publishers: config.min_publishers,
        min_price_scaled: config.min_price_usd_scaled as u128,
        max_price_scaled: config.max_price_usd_scaled as u128,
        now_us,
    };

    lazer_price::price_from_lazer(&lp, &params, config.last_used_feed_update_timestamp_us)
        .map_err(map_policy_err)
}

fn map_parse_err(_e: LazerError) -> Error {
    error!(DominionError::LazerPayloadInvalid)
}

fn map_policy_err(e: LazerPolicyError) -> Error {
    match e {
        LazerPolicyError::NonPositivePrice => error!(DominionError::NegativeOraclePrice),
        LazerPolicyError::ConfidenceMissing
        | LazerPolicyError::ConfidenceNonPositive
        | LazerPolicyError::ConfidenceTooWide => error!(DominionError::OracleLowConfidence),
        LazerPolicyError::TooFewPublishers => error!(DominionError::LazerTooFewPublishers),
        LazerPolicyError::CarriedForward | LazerPolicyError::NonMonotonic => {
            error!(DominionError::LazerCarriedForward)
        }
        LazerPolicyError::Stale | LazerPolicyError::FutureTimestamp => {
            error!(DominionError::StaleOracle)
        }
        LazerPolicyError::ExponentOutOfRange => error!(DominionError::OracleScalingOutOfBounds),
        LazerPolicyError::Overflow => error!(DominionError::ArithmeticOverflow),
        LazerPolicyError::PriceOutOfBounds => error!(DominionError::PriceOutOfBounds),
    }
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
