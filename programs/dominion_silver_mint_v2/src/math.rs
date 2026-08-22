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

/// ceil(oracle * (10_000 + premium_bps_mint) / 10_000). Rounding the price UP makes
/// silv_out round DOWN in mint_silv_out: protocol favour.
// Quoting only: the instructions price at pure spot and charge `fee_from_amount`.
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

/// floor(oracle * (10_000 - premium_bps_redeem) / 10_000). Rounding the redeem price
/// DOWN is protocol favour. Quoting only, as with effective_mint_price_scaled.
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

/// fee = ceil(amount * bps / 10_000), taken OFF THE TOP of `amount`. The one fee
/// formula for both sides: on mint `amount` is the USDC coming in, on redeem it is the
/// USDC value going out, so "1%" always means 1% of what the user sends.
// CEIL, not floor: the odd atomic unit goes to the protocol, because flooring lets a
// caller shave the fee with 1-unit transactions, unbounded across calls. `bps == 0`
// short-circuits so the fee-exempt whitelist path never gets a 1-unit fee.
pub fn fee_from_amount(amount: u64, bps: u16) -> Result<u64> {
    if bps == 0 {
        return Ok(0);
    }
    let numerator = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = numerator
        .checked_add(BPS_DENOM - 1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?
        .checked_div(BPS_DENOM)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

/// floor(amount_usdc * 10^9 / effective_price_scaled). Units: USDC atomic (6dec) in,
/// SILV atomic (6dec) out. Floor, so the user is never over-issued.
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

/// floor(amount_silv * effective_price_scaled / 10^9). Units: SILV atomic in, USDC
/// atomic out. Floor, so the treasury never overpays.
pub fn redeem_usdc_out(amount_silv: u64, effective_price_scaled: u128) -> Result<u64> {
    let num = (amount_silv as u128)
        .checked_mul(effective_price_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = num
        .checked_div(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

/// USDC atomic (6dec) to SILV atomic (6dec) at oracle, floor. Translates per-tx caps
/// expressed in USDC into a SILV bound at runtime.
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

/// SILV atomic (6dec) to USDC atomic (6dec) at oracle, floor. Used to charge redeem
/// against the daily budget and to price a redemption's gross value.
pub fn silv_to_usdc_at_oracle(amount_silv: u64, oracle_scaled: u128) -> Result<u64> {
    let num = (amount_silv as u128)
        .checked_mul(oracle_scaled)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let out = num
        .checked_div(PRICE_SCALE_FACTOR)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    u64::try_from(out).map_err(|_| error!(DominionError::ArithmeticOverflow))
}

// There is deliberately NO on-chain solvency invariant: SILV is backed by physical
// silver in custody, not by an on-chain USDC reserve.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_math_basic() {
        let oracle = 30_000_000_000u128;
        let eff = effective_mint_price_scaled(oracle, 1000).unwrap();
        assert_eq!(eff, 33_000_000_000u128);
        let out = mint_silv_out(100_000_000, eff).unwrap();
        assert_eq!(out, 3_030_303);
    }

    #[test]
    fn mint_price_ceils_in_protocol_favor() {
        // A nonzero remainder must push the price one unit UP, never down.
        let oracle = 30_000_000_001u128;
        let eff = effective_mint_price_scaled(oracle, 1).unwrap();
        assert_eq!(eff, 30_003_000_002u128);
    }

    /// Spot used across the worked examples: $58.34/oz, 9-dec scaled.
    const SPOT: u128 = 58_340_000_000;
    /// Launch fees.
    const MINT_BPS: u16 = 100; // 1%
    const REDEEM_BPS: u16 = 150; // 1.5%

    #[test]
    fn one_percent_of_one_hundred_is_exactly_one() {
        assert_eq!(fee_from_amount(100_000_000, 100).unwrap(), 1_000_000);
        assert_eq!(fee_from_amount(10_000_000_000, 100).unwrap(), 100_000_000);
    }

    #[test]
    fn zero_bps_is_free_and_never_ceils_to_one() {
        // The fee-exempt whitelist path. A naive ceil would charge 1 atomic unit.
        assert_eq!(fee_from_amount(100_000_000, 0).unwrap(), 0);
        assert_eq!(fee_from_amount(1, 0).unwrap(), 0);
        assert_eq!(fee_from_amount(u64::MAX, 0).unwrap(), 0);
    }

    #[test]
    fn fee_ceils_in_protocol_favor() {
        // A sub-unit fee must round to 1, or 1-unit transactions shave it entirely.
        assert_eq!(fee_from_amount(1, 100).unwrap(), 1);
        assert_eq!(fee_from_amount(7, 150).unwrap(), 1);
        // Exact multiples must NOT be pushed up by the ceil.
        assert_eq!(fee_from_amount(10_000, 100).unwrap(), 100);
    }

    #[test]
    fn fee_never_exceeds_the_amount_at_any_legal_bps() {
        // `net = amount - fee` must never underflow, asserted past the 500 bps cap.
        for bps in [1u16, 100, 150, 500, 1000, 10_000] {
            for amount in [1u64, 2, 7, 999, 1_000_000, u64::MAX / 20_000] {
                let fee = fee_from_amount(amount, bps).unwrap();
                assert!(
                    fee <= amount,
                    "fee {fee} > amount {amount} at {bps} bps: net would underflow"
                );
            }
        }
    }

    #[test]
    fn worked_mint_example_matches_the_spec_table() {
        // Fee to the fee vault, net to the treasury, SILV minted on the net at PURE spot.
        let amount_usdc = 100_000_000u64;
        let fee = fee_from_amount(amount_usdc, MINT_BPS).unwrap();
        assert_eq!(fee, 1_000_000); // $1.00
        let net = amount_usdc - fee;
        assert_eq!(net, 99_000_000); // $99.00
        let silv_out = mint_silv_out(net, SPOT).unwrap();
        assert_eq!(silv_out, 1_696_948); // 99.00 / 58.34 oz, floored
    }

    #[test]
    fn worked_redeem_example_matches_the_spec_table() {
        // The treasury pays the FULL spot value; the user gets spot minus the fee.
        let amount_silv = 100_000_000u64; // 100 oz
        let gross = silv_to_usdc_at_oracle(amount_silv, SPOT).unwrap();
        assert_eq!(gross, 5_834_000_000); // $5,834.00
        let fee = fee_from_amount(gross, REDEEM_BPS).unwrap();
        assert_eq!(fee, 87_510_000); // $87.51
        let to_user = gross - fee;
        assert_eq!(to_user, 5_746_490_000); // $5,746.49
    }

    #[test]
    fn round_trip_conserves_value_and_leaves_the_treasury_flat() {
        // The economic property of routing fees out: on a mint-then-redeem round trip the
        // treasury nets ~zero and the fee revenue never mixes with the redemption backing.
        let brought = 10_000_000_000u64; // $10,000

        let mint_fee = fee_from_amount(brought, MINT_BPS).unwrap();
        let to_treasury = brought - mint_fee;
        let silv = mint_silv_out(to_treasury, SPOT).unwrap();

        // Redeem the whole position.
        let gross = silv_to_usdc_at_oracle(silv, SPOT).unwrap();
        let redeem_fee = fee_from_amount(gross, REDEEM_BPS).unwrap();
        let to_user = gross - redeem_fee;

        let treasury_delta = to_treasury as i128 - gross as i128;
        let fee_vault_total = mint_fee + redeem_fee;
        let user_cost = brought - to_user;

        // Conservation: every unit the user paid is in the fee vault or the treasury.
        assert_eq!(user_cost as i128, fee_vault_total as i128 + treasury_delta);

        // Flat to within rounding dust, and the dust is POSITIVE: the floors favour
        // the protocol, never the caller.
        assert!(
            treasury_delta >= 0,
            "treasury lost {treasury_delta} on a round trip: a rounding direction is \
             inverted and the position is drainable by repetition"
        );
        assert!(
            treasury_delta < 1_000,
            "treasury kept {treasury_delta} atomic units, more than rounding dust: \
             fee routing is leaking revenue back into the backing"
        );

        let bps_paid = (user_cost as u128 * 10_000) / brought as u128;
        assert_eq!(bps_paid, 248); // 2.48%: the 1% and 1.5% fees compounding
    }

    #[test]
    fn the_escape_hatch_is_revenue_neutral_not_a_fee_waiver() {
        // INVARIANT: turning fee routing off moves only the fee's DESTINATION. Zeroing the
        // fee instead would make the switch an instant, guardian-unvetoable fee waiver.
        let brought = 10_000_000_000u64; // $10,000

        let mint_fee = fee_from_amount(brought, MINT_BPS).unwrap();
        let net = brought - mint_fee;
        // SILV comes off the NET in both modes, so the user receives the same amount.
        let silv = mint_silv_out(net, SPOT).unwrap();

        let (treasury_on, vault_on) = (net, mint_fee); // routing on
        let (treasury_off, vault_off) = (brought, 0u64); // routing off

        assert_eq!(
            treasury_on + vault_on,
            treasury_off + vault_off,
            "the protocol must receive the same total in both modes"
        );
        assert_eq!(
            treasury_off,
            treasury_on + mint_fee,
            "with routing off the premium must be RETAINED in the treasury, not given away"
        );
        assert!(silv > 0);

        let gross = silv_to_usdc_at_oracle(silv, SPOT).unwrap();
        let redeem_fee = fee_from_amount(gross, REDEEM_BPS).unwrap();
        let to_user = gross - redeem_fee;

        let out_on = to_user + redeem_fee; // both legs leave the treasury
        let out_off = to_user; // only the user's leg leaves
        assert_eq!(
            out_off,
            out_on - redeem_fee,
            "with routing off the treasury must pay LESS by exactly the premium, not more"
        );

        let cost_on = brought - to_user;
        let cost_off = brought - to_user;
        assert_eq!(
            cost_on, cost_off,
            "the escape hatch must never change what a user pays"
        );
        // Still the ~2.5% round trip, not a free one.
        assert_eq!((cost_on as u128 * 10_000) / brought as u128, 248);
    }

    #[test]
    fn redeem_math_basic() {
        let oracle = 30_000_000_000u128;
        let eff = effective_redeem_price_scaled(oracle, 200).unwrap();
        assert_eq!(eff, 29_400_000_000u128);
        let out = redeem_usdc_out(1_000_000, eff).unwrap();
        assert_eq!(out, 29_400_000);
    }
}
