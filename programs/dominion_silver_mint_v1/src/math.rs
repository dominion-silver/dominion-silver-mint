// Pricing math. u128 intermediate, floor in protocol's favor, u64 boundary.
// Units convention:
//   USDC and SILV: 6 decimals (raw u64 = atomic unit)
//   oracle price: scaled by 1e9 (PRICE_SCALE) -> u128 USD per oz with 9 decimals
//   Bps: parts per 10_000

use crate::errors::DominionError;
use anchor_lang::prelude::*;

pub const TOKEN_DECIMALS_SCALE: u128 = 1_000_000; // 10^6 for SILV/USDC
pub const PRICE_SCALE_FACTOR: u128 = 1_000_000_000; // 10^9 (must match oracle::PRICE_SCALE)
pub const BPS_DENOM: u128 = 10_000;

/// effective_mint_price_scaled = ceil(oracle * (10_000 + premium_bps_mint) / 10_000).
/// Ceiling division (numerator + denom - 1) / denom rounds the price UP, which makes
/// silv_out round DOWN at the next step (mint_silv_out floor-divides). Protocol favor.
pub fn effective_mint_price_scaled(oracle_scaled: u128, premium_bps_mint: u16) -> Result<u128> {
    let numerator = oracle_scaled
        .checked_mul((BPS_DENOM as u128) + (premium_bps_mint as u128))
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    numerator
        .checked_add(BPS_DENOM - 1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?
        .checked_div(BPS_DENOM)
        .ok_or(error!(DominionError::ArithmeticOverflow))
}

/// effective_redeem_price_scaled = oracle * (10_000 - premium_bps_redeem) / 10_000
pub fn effective_redeem_price_scaled(oracle_scaled: u128, premium_bps_redeem: u16) -> Result<u128> {
    let factor = (BPS_DENOM as u128)
        .checked_sub(premium_bps_redeem as u128)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    oracle_scaled
        .checked_mul(factor)
        .ok_or(error!(DominionError::ArithmeticOverflow))?
        .checked_div(BPS_DENOM)
        .ok_or(error!(DominionError::ArithmeticOverflow))
}

/// silv_out (in SILV atomic, 6dec) = floor(amount_usdc * 10^9 / effective_mint_price_scaled)
/// where amount_usdc is USDC atomic (6dec) and price scaled 1e9.
/// Result units: USDC_atomic * 1e9 / (USD/oz * 1e9) = SILV_atomic.
pub fn mint_silv_out(amount_usdc: u64, effective_price_scaled: u128) -> Result<u64> {
    require!(effective_price_scaled > 0, DominionError::PriceOutOfBounds);
    let num = (amount_usdc as u128)
        .checked_mul(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = num
        .checked_div(effective_price_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

/// usdc_out (USDC atomic, 6dec) = floor(amount_silv * effective_redeem_price_scaled / 10^9)
pub fn redeem_usdc_out(amount_silv: u64, effective_price_scaled: u128) -> Result<u64> {
    let num = (amount_silv as u128)
        .checked_mul(effective_price_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = num
        .checked_div(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

/// Convert a USDC amount (6dec) to its equivalent SILV amount (6dec) at oracle.
/// Used for translating per-tx caps from USDC into SILV bound at runtime (D43).
pub fn usdc_to_silv_at_oracle(amount_usdc: u64, oracle_scaled: u128) -> Result<u64> {
    require!(oracle_scaled > 0, DominionError::PriceOutOfBounds);
    let num = (amount_usdc as u128)
        .checked_mul(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = num
        .checked_div(oracle_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

/// Convert SILV amount (6dec) to its USDC-equivalent at oracle (used to credit redeem caps).
pub fn silv_to_usdc_at_oracle(amount_silv: u64, oracle_scaled: u128) -> Result<u64> {
    let num = (amount_silv as u128)
        .checked_mul(oracle_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = num
        .checked_div(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

/// Treasury min-reserve invariant check (post-state).
/// Returns Ok(()) if `treasury_balance >= silv_supply * reserve_check_price_scaled * bps / (10_000 * 10^9)`.
/// In u128 units: treasury * 10_000 * 10^9 >= silv_supply * reserve_check_price_scaled * bps.
pub fn check_reserve_invariant_post_state(
    treasury_balance_post: u64,
    silv_supply_post: u64,
    reserve_check_price_scaled: u128,
    treasury_min_reserve_bps: u16,
) -> Result<()> {
    let lhs = (treasury_balance_post as u128)
        .checked_mul(BPS_DENOM)
        .ok_or(error!(DominionError::ArithmeticOverflow))?
        .checked_mul(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let rhs = (silv_supply_post as u128)
        .checked_mul(reserve_check_price_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?
        .checked_mul(treasury_min_reserve_bps as u128)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(lhs >= rhs, DominionError::TreasuryBelowReserve);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_math_basic() {
        // Oracle $30.000_000_000 scaled => 30_000_000_000.
        // Premium 10% => effective $33.000... (clean math, ceil = same).
        // 100 USDC (100_000_000 atomic) -> 100 * 1e9 / 33e9 = 3.030303 SILV (3_030_303 atomic).
        let oracle = 30_000_000_000u128;
        let eff = effective_mint_price_scaled(oracle, 1000).unwrap();
        assert_eq!(eff, 33_000_000_000u128);
        let out = mint_silv_out(100_000_000, eff).unwrap();
        assert_eq!(out, 3_030_303);
    }

    #[test]
    fn mint_price_ceils_in_protocol_favor() {
        // oracle = 30_000_000_001 (1 unit above $30), premium = 1 bps.
        // numerator = 30_000_000_001 * 10_001 = 300_030_000_010_001
        // floor / 10_000 = 30_003_000_001 (with remainder 1)
        // ceil = 30_003_000_002 (one higher because remainder != 0)
        // CODEX 3rd-pass L-1: previous expectation 30_003_000_005 was wrong arithmetic;
        //   the correct ceil is 30_003_000_002. Fixed.
        let oracle = 30_000_000_001u128;
        let eff = effective_mint_price_scaled(oracle, 1).unwrap();
        assert_eq!(eff, 30_003_000_002u128);
    }

    #[test]
    fn redeem_math_basic() {
        // Oracle $30. Redeem fee 2% => effective $29.40.
        // 1 SILV (1_000_000 atomic) -> 1 * 29_400_000_000 / 1e9 = 29_400_000 USDC atomic ($29.40).
        let oracle = 30_000_000_000u128;
        let eff = effective_redeem_price_scaled(oracle, 200).unwrap();
        assert_eq!(eff, 29_400_000_000u128);
        let out = redeem_usdc_out(1_000_000, eff).unwrap();
        assert_eq!(out, 29_400_000);
    }

    #[test]
    fn reserve_invariant_passes_when_backed() {
        // Treasury $10_000 (10_000_000_000 atomic), supply 1212 SILV (1_212_000_000 atomic), price $33, 20% reserve.
        // Required = 1212 * 33 * 0.20 = $7999.20 ≈ $8000. Treasury > req, passes.
        let r =
            check_reserve_invariant_post_state(10_000_000_000, 1_212_000_000, 33_000_000_000, 2000);
        assert!(r.is_ok());
    }

    #[test]
    fn reserve_invariant_fails_when_under() {
        // Treasury $1k, supply 1212 SILV at $33, 30% reserve -> required ~$12k. Fails.
        let r =
            check_reserve_invariant_post_state(1_000_000_000, 1_212_000_000, 33_000_000_000, 3000);
        assert!(r.is_err());
    }
}
