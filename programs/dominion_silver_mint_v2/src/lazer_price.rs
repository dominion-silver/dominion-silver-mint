// Pyth Lazer oracle POLICY + pricing (Sections 5.4-5.6 of the migration plan).
// Pure: takes the parsed `LazerPrice` (crate::lazer) + the policy parameters and
// returns the normalized 9-decimal USD price, applying EVERY on-chain guard.
// Kept separate from parsing (lazer.rs) and the CPI (lazer_cpi.rs) so the
// security policy lives in one auditable place. Host-unit-tested below; the
// oracle.rs instruction layer wires the real ConfigAccount fields + clock and
// maps LazerPolicyError -> DominionError.

use crate::lazer::LazerPrice;

/// Internal price scale: 9 decimals (USD per oz). Same as the Core oracle.
pub const PRICE_SCALE: u32 = 9;

/// Tier A structural hard floor on publishers (plan 5.5): the policy enforces
/// this regardless of the caller-supplied operating value, so a misconfigured
/// `config.min_publishers` below the floor cannot weaken the guard. The
/// OPERATING floor (Tier B, from live data) is `>= ` this and is what the
/// caller passes in `params.min_publishers`.
// Launch spec 2026-07 (FIX D): raised 1 -> 2. This is the code-enforced floor,
// applied via `max(config.min_publishers, FLOOR_HARD)` on every price read, so a
// price backed by fewer than 2 distinct publishers is rejected regardless of the
// configured operating value. The old floor of 1 gave zero margin (a single
// publisher passed).
pub const MIN_PUBLISHERS_FLOOR_HARD: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LazerPolicyError {
    /// Price mantissa <= 0 (the parser allows negative; policy rejects it).
    NonPositivePrice,
    /// Confidence absent (None) - required for fund flows (5.5).
    ConfidenceMissing,
    /// Confidence mantissa <= 0 (a signed Lazer confidence can be negative).
    ConfidenceNonPositive,
    /// Confidence too wide relative to price (> max_confidence_bps).
    ConfidenceTooWide,
    /// publisherCount below the required floor (5.5).
    TooFewPublishers,
    /// The print is carried-forward (feedUpdateTimestamp != payload timestamp) (5.4).
    CarriedForward,
    /// feedUpdateTimestamp is in the future beyond the allowed skew (5.4).
    FutureTimestamp,
    /// The print is older than max_staleness (5.4).
    Stale,
    /// feedUpdateTimestamp is strictly older than the high-water mark (5.4).
    NonMonotonic,
    /// Exponent scaling would overflow the safe u128 range (5.6).
    ExponentOutOfRange,
    /// Arithmetic overflow while normalizing.
    Overflow,
    /// Normalized price outside the [min, max] sanity band (5.6).
    PriceOutOfBounds,
}

/// Policy parameters (the oracle wires these from ConfigAccount + Clock).
pub struct LazerPolicyParams {
    /// Max allowed `feedUpdateTimestamp` age vs `now_us` (Tier B operating value).
    pub max_staleness_us: u64,
    /// Allowed forward clock skew of the publisher vs Solana clock.
    pub future_skew_us: u64,
    /// Max confidence as bps of price (Tier B operating value).
    pub max_confidence_bps: u16,
    /// Minimum publishers in this aggregate (>= MIN_PUBLISHERS_FLOOR).
    pub min_publishers: u16,
    /// Sanity band, 9-decimal scaled USD (Tier B operating values).
    pub min_price_scaled: u128,
    pub max_price_scaled: u128,
    /// Solana clock time in MICROSECONDS (unix_timestamp * 1_000_000).
    pub now_us: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LazerPriceResult {
    /// Normalized 9-decimal USD price.
    pub normalized_price_scaled: u128,
    /// The print's feedUpdateTimestamp (the caller advances the high-water mark).
    pub feed_update_timestamp_us: u64,
}

/// Apply all Section 5.4-5.6 guards to a parsed Lazer price and return the
/// normalized USD price. `last_used_feed_update_us` is the config high-water
/// mark; the caller persists `result.feed_update_timestamp_us` as the new mark
/// on an accepted op.
pub fn price_from_lazer(
    p: &LazerPrice,
    params: &LazerPolicyParams,
    last_used_feed_update_us: u64,
) -> Result<LazerPriceResult, LazerPolicyError> {
    // 5.6: reject non-positive price (the parser guarantees != 0; reject < 0).
    if p.price <= 0 {
        return Err(LazerPolicyError::NonPositivePrice);
    }
    let price_u128 = p.price as u128;

    // 5.5: confidence must be present, positive, and within max_confidence_bps.
    let conf = p.confidence.ok_or(LazerPolicyError::ConfidenceMissing)?;
    if conf <= 0 {
        return Err(LazerPolicyError::ConfidenceNonPositive);
    }
    let conf_u128 = conf as u128;
    let lhs = conf_u128
        .checked_mul(10_000)
        .ok_or(LazerPolicyError::Overflow)?;
    let rhs = price_u128
        .checked_mul(params.max_confidence_bps as u128)
        .ok_or(LazerPolicyError::Overflow)?;
    if lhs > rhs {
        return Err(LazerPolicyError::ConfidenceTooWide);
    }

    // 5.5: publisher floor (meaningful only on a fresh, non-carried print).
    // Defense in depth: the policy enforces the Tier A hard floor itself, so a
    // misconfigured config.min_publishers below the floor cannot weaken it.
    let effective_min = params.min_publishers.max(MIN_PUBLISHERS_FLOOR_HARD);
    if p.publisher_count < effective_min {
        return Err(LazerPolicyError::TooFewPublishers);
    }

    // 5.4: reject ALL carried-forward prints.
    if p.feed_update_timestamp_us != p.timestamp_us {
        return Err(LazerPolicyError::CarriedForward);
    }
    let fut = p.feed_update_timestamp_us;

    // 5.4: reject a future timestamp beyond the allowed skew.
    if fut > params.now_us.saturating_add(params.future_skew_us) {
        return Err(LazerPolicyError::FutureTimestamp);
    }

    // 5.4: staleness vs the Solana clock.
    if params.now_us.saturating_sub(fut) > params.max_staleness_us {
        return Err(LazerPolicyError::Stale);
    }

    // 5.4: STRICTLY increasing high-water mark. One signed envelope, one operation.
    //
    // This was `<` until 2026-08-07, which let the same envelope price several transactions inside the
    // freshness window. Round 4 P0-01 called that out against the stated invariant, and Thomas chose the
    // strict guarantee over the concurrent one.
    //
    // THE COST IS REAL AND IT IS ON THE HOT PATH: the config is a shared writable account, so at most ONE
    // mint or redeem can succeed per Lazer print. The feed publishes at fixed_rate@1000ms, so that is the
    // ceiling, roughly one operation per second protocol-wide. Two users submitting against the same
    // envelope means the second gets NonMonotonic. The submit path must therefore never reuse a cached
    // envelope: see the `fresh` flag in apps/public/src/app/api/lazer/route.ts.
    if fut <= last_used_feed_update_us {
        return Err(LazerPolicyError::NonMonotonic);
    }

    // 5.6: exponent scaling, bounded to prevent u128 pow overflow.
    let combined_exp: i32 = (PRICE_SCALE as i32) + p.exponent as i32;
    if combined_exp.unsigned_abs() > 18 {
        return Err(LazerPolicyError::ExponentOutOfRange);
    }
    let normalized: u128 = if combined_exp >= 0 {
        price_u128
            .checked_mul(10u128.pow(combined_exp as u32))
            .ok_or(LazerPolicyError::Overflow)?
    } else {
        price_u128
            .checked_div(10u128.pow(combined_exp.unsigned_abs()))
            .ok_or(LazerPolicyError::Overflow)?
    };

    // 5.6: sanity band.
    if normalized < params.min_price_scaled || normalized > params.max_price_scaled {
        return Err(LazerPolicyError::PriceOutOfBounds);
    }

    Ok(LazerPriceResult {
        normalized_price_scaled: normalized,
        feed_update_timestamp_us: fut,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A fresh SILV-like price: $76.74 mantissa 7_674_000 @ exp -5, conf 1234,
    // 3 publishers, feedUpdate == payload ts == 1_000_000 us.
    fn silv(now_us: u64) -> LazerPrice {
        LazerPrice {
            price: 7_674_000,
            exponent: -5,
            confidence: Some(1234),
            publisher_count: 3,
            feed_update_timestamp_us: now_us,
            channel_id: 4,
            timestamp_us: now_us,
        }
    }

    fn params(now_us: u64) -> LazerPolicyParams {
        LazerPolicyParams {
            max_staleness_us: 15_000_000, // 15s
            future_skew_us: 2_000_000,    // 2s
            max_confidence_bps: 100,      // 1%
            min_publishers: 2,
            min_price_scaled: 10_000_000_000, // $10
            max_price_scaled: 80_000_000_000, // $80
            now_us,
        }
    }

    #[test]
    fn happy_path_normalizes() {
        let now = 1_000_000;
        let r = price_from_lazer(&silv(now), &params(now), 0).unwrap();
        // $76.74 at 9 decimals.
        assert_eq!(r.normalized_price_scaled, 76_740_000_000);
        assert_eq!(r.feed_update_timestamp_us, now);
    }

    #[test]
    fn rejects_negative_price() {
        let now = 1_000_000;
        let mut p = silv(now);
        p.price = -7_674_000;
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::NonPositivePrice)
        );
    }

    #[test]
    fn rejects_missing_and_nonpositive_confidence() {
        let now = 1_000_000;
        let mut p = silv(now);
        p.confidence = None;
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::ConfidenceMissing)
        );
        p.confidence = Some(-1);
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::ConfidenceNonPositive)
        );
    }

    #[test]
    fn rejects_wide_confidence() {
        let now = 1_000_000;
        let mut p = silv(now);
        // conf 1% of price 7_674_000 = 76_740; above 1% (max 100 bps) -> reject at >.
        p.confidence = Some(76_741);
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::ConfidenceTooWide)
        );
        // exactly at the bound passes.
        p.confidence = Some(76_740);
        assert!(price_from_lazer(&p, &params(now), 0).is_ok());
    }

    #[test]
    fn rejects_too_few_publishers() {
        let now = 1_000_000;
        let mut p = silv(now);
        p.publisher_count = 1; // floor is 2
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::TooFewPublishers)
        );
    }

    #[test]
    fn enforces_hard_publisher_floor_regardless_of_caller() {
        // Even if the caller supplies min_publishers below the Tier A hard
        // floor, the policy enforces the floor (defense in depth).
        let now = 1_000_000;
        let mut pr = params(now);
        pr.min_publishers = 0; // misconfigured below the hard floor (2)
        let mut p = silv(now);
        p.publisher_count = 1; // below the hard floor of 2 -> still rejected
        assert_eq!(
            price_from_lazer(&p, &pr, 0),
            Err(LazerPolicyError::TooFewPublishers)
        );
        p.publisher_count = 2; // meets the hard floor of 2
        assert!(price_from_lazer(&p, &pr, 0).is_ok());
    }

    #[test]
    fn rejects_carried_forward() {
        let now = 1_000_000;
        let mut p = silv(now);
        p.feed_update_timestamp_us = now - 1; // != payload timestamp_us
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::CarriedForward)
        );
    }

    #[test]
    fn rejects_future_and_stale() {
        let now = 100_000_000;
        // future beyond skew (2s)
        let future = now + 3_000_000;
        let mut p = silv(future);
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::FutureTimestamp)
        );
        // stale (older than 15s)
        let old = now - 16_000_000;
        p = silv(old);
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::Stale)
        );
    }

    #[test]
    fn high_water_mark_is_STRICTLY_increasing() {
        let now = 100_000_000;
        let p = silv(now);
        // Strictly newer than last-used: the only accepted case.
        assert!(price_from_lazer(&p, &params(now), now - 1).is_ok());
        // EQUAL to last-used: rejected. One envelope, one operation. This assertion is the whole of the
        // decision taken on round 4 P0-01, and it inverts what this test asserted before.
        assert_eq!(
            price_from_lazer(&p, &params(now), now),
            Err(LazerPolicyError::NonMonotonic),
            "replaying the same envelope must be refused"
        );
        // Strictly older: rejected too.
        assert_eq!(
            price_from_lazer(&p, &params(now), now + 1),
            Err(LazerPolicyError::NonMonotonic)
        );
    }

    #[test]
    fn rejects_out_of_band_price() {
        let now = 1_000_000;
        // price $5 (mantissa 500_000 @ -5) -> below the $10 min band.
        let mut p = silv(now);
        p.price = 500_000;
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::PriceOutOfBounds)
        );
        // price $100 (mantissa 10_000_000 @ -5) -> above the $80 max band.
        p.price = 10_000_000;
        assert_eq!(
            price_from_lazer(&p, &params(now), 0),
            Err(LazerPolicyError::PriceOutOfBounds)
        );
    }

    #[test]
    fn exponent_scaling_negative_combined() {
        // A large exponent so combined_exp < 0 (divide path). exp = -12 ->
        // combined = -3. mantissa 76_740_000_000_000 / 10^3 = 76_740_000_000.
        let now = 1_000_000;
        let mut p = silv(now);
        p.exponent = -12;
        p.price = 76_740_000_000_000;
        // conf must stay within 1% of the (now huge) mantissa.
        p.confidence = Some(1);
        let r = price_from_lazer(&p, &params(now), 0).unwrap();
        assert_eq!(r.normalized_price_scaled, 76_740_000_000);
    }
}
