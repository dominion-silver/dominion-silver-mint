//! The redemption rate limiter: a SLIDING window counter.
//!
//! # Why this exists as a module rather than inline in the handler
//!
//! It replaces an inline fixed-window computation that was wrong in a way nobody noticed, and the
//! reason nobody noticed is that it was inline. The propose-side no-op gate in this same batch was
//! a P0 for exactly that reason: logic living in a handler does not get unit-tested, and the test
//! that was supposed to cover it tested a different function. So this is pure, takes primitives,
//! and returns a decision.
//!
//! # What was wrong: the 2x burst
//!
//! The old code re-anchored the window to `now` on the first redemption after expiry, which is a
//! FIXED window. Every fixed window has the same hole, and it is not subtle:
//!
//!   - at `window_end - 1s`, drain the entire remaining budget B
//!   - one slot later (~400ms) the window has expired, the counter resets to zero
//!   - drain B again
//!
//! **2 x budget in about one second.** At the launch defaults that is $40k against a documented
//! $20k, and it scales linearly with any budget raise for market-maker flow. Both `config.rs` and
//! `redeem_silv.rs` called the window "rolling", which it was not.
//!
//! That matters more here than it would elsewhere: this budget is the ONLY hard brake between a
//! bad oracle print and the treasury. The oracle guards (staleness, publisher floor, price-delta
//! breaker) are FILTERS, and the delta breaker in particular is a per-step rate limit whose
//! reference advances on every accepted operation, so it bounds each hop rather than the total.
//!
//! # The fix: a weighted two-bucket counter
//!
//! The standard sliding-window-counter approximation. Keep usage for the CURRENT fixed bucket and
//! for the one immediately before it, then count the previous bucket in proportion to how much of
//! it still lies inside the trailing window:
//!
//! ```text
//!   effective = current + previous * (window - elapsed_into_bucket) / window
//! ```
//!
//! At a bucket boundary `elapsed_into_bucket` is 0, so the previous bucket counts in FULL and
//! `current + previous <= budget` still holds. The burst is gone. As the bucket fills up the old
//! usage decays out linearly, which is what makes it a sliding limit rather than a step function.
//!
//! It costs one extra `u64` in ConfigAccount and no extra accounts. It is an approximation, not an
//! exact per-request log: usage inside a bucket is treated as uniformly spread. The error is
//! bounded by one bucket's worth of skew and it is always on the CONSERVATIVE side at the boundary,
//! which is the side that matters.

/// The decision for one redemption attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowDecision {
    /// Usage attributable to the trailing window, before this request.
    pub effective_used: u64,
    /// What `config.instant_window_start` must become.
    pub new_window_start: i64,
    /// What `config.instant_used_usdc` must become BEFORE adding this request.
    pub rolled_current: u64,
    /// What `config.instant_used_prev_usdc` must become.
    pub rolled_prev: u64,
}

/// Roll the buckets forward to `now` and report the usage that counts against the budget.
///
/// Pure. The caller adds the request amount to `rolled_current` and compares
/// `effective_used + amount` against the budget, then persists all three values only if every
/// other check passes.
///
/// `window_seconds` is bounded to `[INSTANT_WINDOW_MIN_SECONDS, INSTANT_WINDOW_MAX_SECONDS]` by
/// `validate_redeem_limits_ceilings`, so it is never zero here. It is still guarded, because a
/// division by zero in a redemption path is not a risk worth carrying on a validator's word.
pub fn roll_window(
    now: i64,
    window_start: i64,
    window_seconds: u32,
    used_current: u64,
    used_prev: u64,
) -> WindowDecision {
    let w = window_seconds as i64;
    if w <= 0 {
        // Degenerate config: treat every request as a fresh window. Fail OPEN on the accounting
        // rather than reverting, because the budget check that follows still bounds the request,
        // and a zero window means the operator asked for no rate limiting at all.
        return WindowDecision {
            effective_used: 0,
            new_window_start: now,
            rolled_current: 0,
            rolled_prev: 0,
        };
    }

    // A negative elapsed means `window_start` is in the future: possible only via clock skew or a
    // config written with a future timestamp. Treat it as "no time has passed", which is the
    // conservative reading (all prior usage still counts) rather than resetting the counter.
    let elapsed = now.saturating_sub(window_start).max(0);

    let (start, current, prev) = if window_start == 0 {
        // Bootstrap: `initialize` leaves window_start at 0, which is not a real window. Anchor it
        // here without inheriting 1970 as a bucket start.
        (now, used_current, used_prev)
    } else if elapsed >= 2 * w {
        // Two or more buckets have passed with no activity: nothing carries.
        (now, 0, 0)
    } else if elapsed >= w {
        // Exactly one boundary crossed. The current bucket becomes the previous one, and the new
        // bucket starts one window later rather than at `now`: advancing to `now` would silently
        // re-align the grid on every gap and hand back part of the budget.
        (window_start + w, 0, used_current)
    } else {
        (window_start, used_current, used_prev)
    };

    let into = now.saturating_sub(start).clamp(0, w);
    // Weight the previous bucket by the fraction of it still inside the trailing window.
    // u128 so `prev * (w - into)` cannot overflow for any u64 prev and any legal window.
    let weighted_prev = ((prev as u128) * ((w - into) as u128) / (w as u128)) as u64;
    let effective_used = current.saturating_add(weighted_prev);

    WindowDecision {
        effective_used,
        new_window_start: start,
        rolled_current: current,
        rolled_prev: prev,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 86_400; // 24h, the launch default
    const WI: i64 = 86_400;
    const BUDGET: u64 = 20_000_000_000; // $20k

    /// Simulate a sequence of redemptions and return the total that was ALLOWED.
    fn simulate(attempts: &[(i64, u64)]) -> u64 {
        let mut start = 0i64;
        let mut cur = 0u64;
        let mut prev = 0u64;
        let mut allowed = 0u64;
        for &(now, amount) in attempts {
            let d = roll_window(now, start, W, cur, prev);
            if d.effective_used + amount <= BUDGET {
                start = d.new_window_start;
                cur = d.rolled_current + amount;
                prev = d.rolled_prev;
                allowed += amount;
            }
        }
        allowed
    }

    #[test]
    fn the_boundary_burst_is_closed() {
        // THE regression test. Under the old fixed window this returned 2 x BUDGET.
        let allowed = simulate(&[
            (1_000, BUDGET),      // drain the whole budget early in bucket 1
            (WI + 1, BUDGET),     // one second past the boundary: used to reset to zero
        ]);
        assert_eq!(
            allowed, BUDGET,
            "a redemption one second after the window boundary must NOT get a fresh full budget"
        );
    }

    #[test]
    fn a_full_window_later_the_budget_is_available_again() {
        // The limiter must not be a permanent cap. After a full window with the previous bucket
        // fully decayed out, the whole budget is spendable again.
        let allowed = simulate(&[(1_000, BUDGET), (1_000 + 2 * WI, BUDGET)]);
        assert_eq!(allowed, 2 * BUDGET);
    }

    #[test]
    fn usage_decays_linearly_rather_than_stepping() {
        // Halfway into the next bucket, half of the previous bucket's usage still counts, so
        // half the budget is available. That is the sliding behaviour.
        let d = roll_window(WI + WI / 2, 0 + 0, W, 0, 0);
        assert_eq!(d.effective_used, 0);

        // Explicit: previous bucket fully used, we are half a window past its end.
        let d = roll_window(WI + WI / 2, WI, W, 0, BUDGET);
        assert_eq!(d.effective_used, BUDGET / 2);
        // A quarter in, three quarters still counts.
        let d = roll_window(WI + WI / 4, WI, W, 0, BUDGET);
        assert_eq!(d.effective_used, BUDGET / 4 * 3);
        // At the boundary itself, ALL of it counts. This is the case the old code got wrong.
        let d = roll_window(WI, WI, W, 0, BUDGET);
        assert_eq!(d.effective_used, BUDGET);
    }

    #[test]
    fn no_trailing_window_of_any_alignment_exceeds_the_budget_by_more_than_one_bucket_of_skew() {
        // Property test over the approximation's actual guarantee. Hammer one unit at a time
        // across three windows and assert that the total allowed in ANY window-length span stays
        // within the budget plus the bounded approximation error.
        let mut start = 0i64;
        let mut cur = 0u64;
        let mut prev = 0u64;
        let step = BUDGET / 200;
        let mut timeline: Vec<(i64, u64)> = Vec::new();
        for i in 0..(3 * 200) {
            let now = 1 + (i as i64) * (WI / 200);
            let d = roll_window(now, start, W, cur, prev);
            if d.effective_used + step <= BUDGET {
                start = d.new_window_start;
                cur = d.rolled_current + step;
                prev = d.rolled_prev;
                timeline.push((now, step));
            }
        }
        for &(t0, _) in &timeline {
            let in_span: u64 = timeline
                .iter()
                .filter(|&&(t, _)| t >= t0 && t < t0 + WI)
                .map(|&(_, a)| a)
                .sum();
            assert!(
                in_span <= BUDGET * 2,
                "a {WI}s span starting at {t0} allowed {in_span}, over the bound"
            );
        }
        // And the headline property: the FIRST full window can never exceed the budget.
        let first: u64 = timeline
            .iter()
            .filter(|&&(t, _)| t < WI)
            .map(|&(_, a)| a)
            .sum();
        assert!(first <= BUDGET, "first window allowed {first} > {BUDGET}");
    }

    #[test]
    fn a_bootstrap_config_anchors_without_inheriting_1970() {
        // `initialize` leaves window_start at 0. Treating that as a real bucket start would make
        // `elapsed` about 56 years and is harmless by luck, not by design. Assert the intent.
        let d = roll_window(1_800_000_000, 0, W, 0, 0);
        assert_eq!(d.new_window_start, 1_800_000_000);
        assert_eq!(d.effective_used, 0);
    }

    #[test]
    fn clock_skew_backwards_does_not_reset_the_counter() {
        // window_start in the future. The conservative reading is "no time has passed", so all
        // prior usage still counts. Resetting here would be a free budget refill triggered by a
        // validator clock wobble.
        let d = roll_window(1_000, 5_000, W, BUDGET, 0);
        assert_eq!(d.effective_used, BUDGET);
        assert_eq!(d.new_window_start, 5_000);
    }

    #[test]
    fn a_long_gap_carries_nothing_and_re_anchors() {
        let d = roll_window(10 * WI, WI, W, BUDGET, BUDGET);
        assert_eq!(d.effective_used, 0);
        assert_eq!(d.new_window_start, 10 * WI);
        assert_eq!(d.rolled_current, 0);
        assert_eq!(d.rolled_prev, 0);
    }

    #[test]
    fn crossing_one_boundary_advances_by_exactly_one_window_not_to_now() {
        // Advancing the grid to `now` on every gap would silently re-align the buckets and hand
        // back part of the budget each time.
        //
        // `window_start` must be NON-ZERO here: zero is the bootstrap sentinel and takes a
        // different branch. The first version of this test used 0 and passed through bootstrap,
        // asserting nothing about the behaviour it names. Caught by the test failing, which is the
        // cheap way to find out.
        const START: i64 = 1_000;
        let d = roll_window(START + WI + 100, START, W, BUDGET, 0);
        assert_eq!(
            d.new_window_start,
            START + WI,
            "the new bucket must start exactly one window after the old one, not at `now`"
        );
        assert_eq!(d.rolled_prev, BUDGET);
        assert_eq!(d.rolled_current, 0);
        // 100s into the new bucket, so nearly all of the previous bucket still counts.
        let expected = BUDGET / WI as u64 * (WI - 100) as u64;
        assert!(d.effective_used > expected - BUDGET / 1000);
    }

    #[test]
    fn the_weighting_cannot_overflow_at_u64_extremes() {
        let d = roll_window(WI, WI, W, u64::MAX, u64::MAX);
        // saturating_add keeps it finite; the budget check downstream rejects it.
        assert_eq!(d.effective_used, u64::MAX);
        let d = roll_window(WI + WI / 2, WI, u32::MAX, 0, u64::MAX);
        assert!(d.effective_used > 0);
    }

    #[test]
    fn a_zero_window_degrades_to_no_rate_limiting_without_dividing_by_zero() {
        // Unreachable through the setters (INSTANT_WINDOW_MIN_SECONDS is 60) but a division by
        // zero in a redemption path is not something to carry on a validator's word.
        let d = roll_window(1_000, 500, 0, BUDGET, BUDGET);
        assert_eq!(d.effective_used, 0);
        assert_eq!(d.new_window_start, 1_000);
    }
}

#[cfg(test)]
mod ratchet_check {
    // Added during the review-of-fixes, as a self-check rather than a reviewer finding: the
    // handler comment CLAIMS that feeding `effective_used` into the current bucket would ratchet
    // the limiter shut, and a claim in a comment is not a test.
    use super::*;
    const W: u32 = 86_400;
    const WI: i64 = 86_400;
    const BUDGET: u64 = 20_000_000_000;

    /// The concern the handler comment names: if the CURRENT bucket were fed `effective_used`
    /// instead of the request's gross, the weighted carry-over would be promoted into a permanent
    /// figure and the limiter would ratchet shut. This drives 60 windows of steady, well-under-budget
    /// traffic and asserts the limiter never closes.
    #[test]
    fn steady_traffic_never_ratchets_the_limiter_shut() {
        let mut start = 0i64;
        let mut cur = 0u64;
        let mut prev = 0u64;
        let step = BUDGET / 10; // 10% of budget per redemption
        let mut rejected = 0;
        for i in 0..(60 * 5) {
            // 5 redemptions per window, i.e. 50% utilisation. Must never be refused.
            let now = 1 + (i as i64) * (WI / 5);
            let d = roll_window(now, start, W, cur, prev);
            if d.effective_used + step <= BUDGET {
                start = d.new_window_start;
                cur = d.rolled_current + step;
                prev = d.rolled_prev;
            } else {
                rejected += 1;
            }
        }
        assert_eq!(
            rejected, 0,
            "the limiter refused {rejected} of 300 redemptions at 50% utilisation: it is ratcheting shut"
        );
    }
}
