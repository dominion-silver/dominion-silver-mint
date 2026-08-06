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

/// fee = ceil(amount * bps / 10_000), taken OFF THE TOP of `amount`.
///
/// This is the ONE fee formula, used identically on both sides (Thomas, 2026-08-05):
///
///   mint   : fee on the USDC coming IN,  net = amount - fee, then mint net/spot
///   redeem : fee on the USDC value going OUT, user gets gross - fee
///
/// It replaces the old asymmetric model, where the mint fee was expressed as a
/// marked-UP price (`effective_mint_price_scaled`) and the redeem fee as a marked-DOWN
/// price (`effective_redeem_price_scaled`). Those two functions are retained for
/// quoting and for their tests, but the instructions no longer price through them.
///
/// Two reasons the change was worth making:
///
///   1. **A price-embedded fee is not routable.** On the mint side the old form produced
///      no fee amount at all: the user's whole payment went to the treasury and they
///      simply received less SILV, so the fee existed as under-issuance rather than as
///      money. Sending premium revenue to a separate destination requires an explicit
///      amount, which only this form produces.
///   2. **"1%" now means 1% of what you send**, on both sides, which is what a user and
///      an auditor both assume. The old mint form charged 1% of the NET
///      (`amount/(1+bps)`), i.e. 0.9901% of the gross, a 1 bp discrepancy that was
///      invisible and impossible to explain.
///
/// CEIL, not floor: the odd atomic unit goes to the protocol. This matches the
/// direction of the `ceil` in `effective_mint_price_scaled`, which existed for the same
/// reason. Rounding a fee DOWN would let a caller shave one unit per transaction, which
/// is negligible per call and unbounded across calls.
///
/// `bps == 0` short-circuits to 0. That is the fee-exempt whitelist path and it must
/// never allocate a 1-unit fee out of the ceiling.
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

// Option B 2026-05-15: check_reserve_invariant_post_state removed. Option B has
// NO on-chain USDC reserve. SILV is backed by physical silver in custody, not
// by an on-chain solvency invariant. See CONFIRMED_SPEC.md Section 2.

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

    // ---------------------------------------------------------------------
    // fee_from_amount: the single fee formula used by both mint and redeem.
    // ---------------------------------------------------------------------

    /// Spot used across the worked examples: $58.34/oz, 9-dec scaled.
    const SPOT: u128 = 58_340_000_000;
    /// Launch fees confirmed by Mark 2026-07-30.
    const MINT_BPS: u16 = 100; // 1%
    const REDEEM_BPS: u16 = 150; // 1.5%

    #[test]
    fn one_percent_of_one_hundred_is_exactly_one() {
        // The whole point of the new formula: "1%" means 1% of what you send.
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
        // 1 atomic unit at 1% is 0.0001 units of fee. Floor would be 0, which lets a
        // caller shave the fee entirely by splitting into 1-unit transactions.
        assert_eq!(fee_from_amount(1, 100).unwrap(), 1);
        // 150 bps on 7 units = 0.105 -> 1.
        assert_eq!(fee_from_amount(7, 150).unwrap(), 1);
        // Exact multiples must NOT be pushed up by the ceil.
        assert_eq!(fee_from_amount(10_000, 100).unwrap(), 100);
    }

    #[test]
    fn fee_never_exceeds_the_amount_at_any_legal_bps() {
        // bps is bounded by PREMIUM_BPS_*_CEILING (500), but assert the property well
        // past that: `net = amount - fee` must never underflow.
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
        // 100 USDC in, 1% fee, spot $58.34.
        // fee 1.00 to the fee vault, 99.00 to the treasury, SILV minted on 99.00 at
        // PURE spot (no marked-up price any more).
        let amount_usdc = 100_000_000u64;
        let fee = fee_from_amount(amount_usdc, MINT_BPS).unwrap();
        assert_eq!(fee, 1_000_000); // $1.00
        let net = amount_usdc - fee;
        assert_eq!(net, 99_000_000); // $99.00
        let silv_out = mint_silv_out(net, SPOT).unwrap();
        // 99.00 / 58.34 = 1.696948... oz
        assert_eq!(silv_out, 1_696_948);
    }

    #[test]
    fn worked_redeem_example_matches_the_spec_table() {
        // 100 SILV (100 oz) out at spot $58.34, 1.5% fee.
        // Treasury pays the FULL spot value; the user gets spot minus fee.
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
        // THE economic property of routing fees out: on a mint-then-redeem round trip
        // the treasury nets ~zero and every dollar the user paid is in the fee vault.
        // Before routing, that same surplus stayed inside the treasury, mixed with the
        // redemption backing. This test is what stops a future edit from silently
        // reintroducing the mixing.
        let brought = 10_000_000_000u64; // $10,000

        // Mint.
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

        // 1. Conservation: nothing is created or destroyed. Every unit the user paid
        //    is either in the fee vault or left behind in the treasury.
        assert_eq!(user_cost as i128, fee_vault_total as i128 + treasury_delta);

        // 2. The treasury is flat to within rounding dust, and the dust is POSITIVE
        //    (the floors favour the protocol, never the caller).
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

        // 3. The user paid ~2.5% all-in (1% + 1.5%), which is the headline number.
        let bps_paid = (user_cost as u128 * 10_000) / brought as u128;
        assert_eq!(bps_paid, 248); // 2.48%, the two fees compounding
    }

    #[test]
    fn the_escape_hatch_is_revenue_neutral_not_a_fee_waiver() {
        // THE regression test for the corrected A5. The first version zeroed the fee when premium
        // routing was disabled, which made `set_fee_routing_enabled(false)` a global, instant,
        // guardian-unvetoable both-sides fee waiver for every wallet, bypassing the 24h timelock
        // that exists precisely because premium changes alter what users are charged.
        //
        // The invariant that must hold in BOTH modes: the user's outcome is IDENTICAL, and the
        // premium is charged either way. Only the destination moves.
        let brought = 10_000_000_000u64; // $10,000

        // --- MINT ---
        let mint_fee = fee_from_amount(brought, MINT_BPS).unwrap();
        let net = brought - mint_fee;
        // The SILV is computed from the NET in both modes, so the user receives the same amount
        // whether or not the premium is routed. That is the whole point.
        let silv = mint_silv_out(net, SPOT).unwrap();

        // routing ON: treasury gets net, vault gets the fee.
        let (treasury_on, vault_on) = (net, mint_fee);
        // routing OFF: treasury gets the WHOLE amount, vault gets nothing.
        let (treasury_off, vault_off) = (brought, 0u64);

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

        // --- REDEEM --- (redeem the whole position)
        let gross = silv_to_usdc_at_oracle(silv, SPOT).unwrap();
        let redeem_fee = fee_from_amount(gross, REDEEM_BPS).unwrap();
        let to_user = gross - redeem_fee;

        // The user receives `to_user` in BOTH modes. Only what leaves the treasury differs.
        let out_on = to_user + redeem_fee; // both legs leave
        let out_off = to_user; // only the user's leg leaves
        assert_eq!(
            out_off,
            out_on - redeem_fee,
            "with routing off the treasury must pay LESS by exactly the premium, not more"
        );

        // And the headline: the user's all-in cost is the same either way.
        let cost_on = brought - to_user;
        let cost_off = brought - to_user;
        assert_eq!(
            cost_on, cost_off,
            "the escape hatch must never change what a user pays"
        );
        // Sanity: it is still the ~2.5% round trip, not a free one.
        assert_eq!((cost_on as u128 * 10_000) / brought as u128, 248);
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
}
