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
//! It costs one extra `u64` in ConfigAccount and no extra accounts.
//!
//! # The exact guarantee. CORRECTED, and the correction matters.
//!
//! This is an APPROXIMATION, not a per-request log: usage inside a bucket is treated as uniformly
//! spread, so usage CONCENTRATED at the end of a bucket is under-counted.
//!
//! Two earlier versions of this section were wrong, and both were wrong the same way: they
//! evaluated ONE alignment and called the result the worst case.
//!   - v1 claimed the error "is always on the CONSERVATIVE side". False except at a boundary.
//!   - v2 evaluated `into = w/2`, got `1.5 x budget`, and declared that the bound. Also false: it
//!     never maximised over `into`.
//!
//! The actual derivation. Let the previous bucket be fully used, all of it spent at its very END so
//! all of it genuinely falls inside the trailing window. At offset `into` into the current bucket
//! the counter believes only `prev * (w - into)/w` is outstanding, so it admits
//! `budget - prev*(w-into)/w`. True usage in the trailing window is therefore
//!
//! ```text
//!   prev + budget - prev*(w - into)/w  =  budget + prev*into/w
//! ```
//!
//! which is INCREASING in `into` and tends to `2 x budget` as `into -> w`.
//!
//! So: **2 x budget, not 1.5x.** The concrete construction is in
//! `two_spends_one_second_short_of_a_window_reach_almost_2x`: spend the whole budget at
//! `start + w - 1`, then again at `start + 2w - 2`. The second call sees `effective_used` of about
//! $0.46 against a $20k budget, and the two spends are `w - 1` seconds apart, i.e. inside one
//! trailing window.
//!
//! # So what did this actually buy, if the bound is unchanged?
//!
//! THE RATE, and that is worth having. The fixed window allowed 2x in about ONE SECOND, with no
//! construction: drain, wait for the reset, drain again. The sliding counter forces those two
//! drains to be nearly a full window apart. Same worst-case total, spread over ~24h at the launch
//! settings instead of ~1s, which is the difference between an unobservable event and one a
//! guardian can pause during.
//!
//! It is NOT a tighter bound, and this file previously claimed otherwise. Closing the remaining 1x
//! needs an exact sliding log, i.e. unbounded per-request storage. **Size
//! `instant_redeem_budget_usdc` at half the maximum outflow you are willing to see in a day.**

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
    fn a_uniform_timeline_stays_within_the_bound() {
        // RENAMED. It was called `no_trailing_window_of_any_alignment_exceeds_...`, which claimed a
        // universal it does not test: it drives ONE uniform timeline. The adversarial alignments are
        // the tests below. A test whose name overstates its reach is worse than no test, and this
        // one hid a 2x for a whole review cycle.
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
            // 2x is the real bound (see the module docs). Note this assertion has little
            // discriminating power on a UNIFORM timeline, which by the closed form maxes out around
            // 1.0007x: it would pass at 3x too. The adversarial alignments below are what actually
            // test the sliding behaviour. Kept as a sanity floor, named honestly.
            assert!(
                in_span <= BUDGET * 2,
                "a {WI}s span starting at {t0} allowed {in_span}, above the 2x bound"
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
    fn a_half_window_alignment_reaches_1_5x() {
        // RENAMED from `..._tops_out_at_the_derived_1_5x_and_no_higher`. It asserted "and no
        // higher" while exercising a SINGLE alignment, so it certified a bound it never searched.
        // The real maximum is at `into -> w`, not `into = w/2`: see the test below. This one now
        // claims only what it checks, that the half-window case reaches 1.5x.
        let mut start = 1i64;
        let mut cur = 0u64;
        let mut prev = 0u64;

        // Spend the whole budget at the end of bucket 1.
        let t1 = start + WI - 1;
        let d = roll_window(t1, start, W, cur, prev);
        assert!(d.effective_used + BUDGET <= BUDGET);
        start = d.new_window_start;
        cur = d.rolled_current + BUDGET;
        prev = d.rolled_prev;

        // Half a window later the weight is ~1/2, so ~half the budget is available again.
        let t2 = t1 + WI / 2;
        let d = roll_window(t2, start, W, cur, prev);
        let available = BUDGET - d.effective_used;
        // Approximately half. The tolerance is 0.1% of the budget, not "within 2 units": `into` is
        // 43199 rather than 43200 because the first spend landed one second before the boundary, and
        // that one second propagates through the weighting as ~0.23 USDC. The first version of this
        // assertion demanded exactness and failed on the code being right, which is the second time
        // this pass that my test was wrong rather than the implementation.
        let half = BUDGET / 2;
        let tol = BUDGET / 1_000;
        assert!(
            available <= half + tol,
            "available {available} exceeds half the budget by more than the tolerance"
        );
        assert!(
            available >= half - tol,
            "available {available} is below half the budget by more than the tolerance"
        );

        // Total inside the trailing window [t2 - WI, t2]: the whole of bucket 1 plus this.
        let total = BUDGET + available;
        assert!(
            total <= BUDGET + half + tol,
            "the half-window alignment let {total} out, above the 1.5x expected there"
        );
    }

    #[test]
    fn two_spends_one_second_short_of_a_window_reach_almost_2x() {
        // THE REAL WORST CASE, found by the review-of-fixes after I had twice derived a smaller
        // bound from a single alignment. Spend the whole budget at `start + w - 1`, then again at
        // `start + 2w - 2`. The two spends are `w - 1` seconds apart, so BOTH lie inside one
        // trailing window, and by then the previous bucket's weight has decayed to 2/w.
        const START: i64 = 1;
        let t1 = START + WI - 1;
        let d1 = roll_window(t1, START, W, 0, 0);
        assert_eq!(d1.effective_used, 0);
        let (start2, cur2, prev2) = (d1.new_window_start, d1.rolled_current + BUDGET, d1.rolled_prev);

        let t2 = START + 2 * WI - 2;
        assert!(t2 - t1 < WI, "the two spends must fall inside one trailing window");
        let d2 = roll_window(t2, start2, W, cur2, prev2);

        // The counter now believes almost nothing is outstanding: prev * 2/w.
        let expected_effective = (BUDGET as u128 * 2 / WI as u128) as u64;
        assert_eq!(d2.effective_used, expected_effective);

        let second_spend = BUDGET - d2.effective_used;
        let total = BUDGET + second_spend;
        // Just under 2x, and decisively above the 1.5x this file used to claim.
        assert!(
            total > BUDGET + BUDGET / 2,
            "total {total} should exceed the 1.5x that was wrongly documented as the bound"
        );
        assert!(total <= 2 * BUDGET, "total {total} exceeded the true 2x bound");
        let bps_of_budget = (total as u128 * 10_000 / BUDGET as u128) as u64;
        assert!(
            bps_of_budget >= 19_990,
            "expected ~1.9999x, got {bps_of_budget} bps of budget"
        );
    }

    #[test]
    fn the_rate_improvement_is_real_even_though_the_bound_is_not() {
        // What the sliding counter actually bought. Under the OLD fixed window, draining the budget
        // and then draining it again ONE SECOND later succeeded. It must now be refused: the 2x is
        // only reachable across nearly a full window, which is the difference between an
        // unobservable event and one a guardian can pause during.
        let allowed = simulate(&[(1_000, BUDGET), (1_000 + 1, BUDGET)]);
        assert_eq!(allowed, BUDGET, "a one-second-later second drain must be refused");
        let allowed = simulate(&[(1_000, BUDGET), (1_000 + WI / 4, BUDGET)]);
        assert_eq!(allowed, BUDGET, "a quarter-window-later second drain must be refused");
    }

    #[test]
    fn many_tiny_requests_cannot_beat_the_limiter() {
        // Salami-slicing inside one window: many tiny requests must total the budget and no more, so
        // the rounding in the weighting cannot leak per-request.
        //
        // CORRECTED. The first version computed `now = 1 + (i % WI)`, so time ran forward once then
        // jumped BACKWARDS 12,000 times. `elapsed` never reached `w`, `prev` stayed 0, and no
        // boundary was ever crossed: it was a backwards-clock test wearing a salami-slicing name.
        // Now time advances monotonically across three windows, which is what the name claims.
        let step = BUDGET / 10_000;
        let mut start = 1i64;
        let mut cur = 0u64;
        let mut prev = 0u64;
        let mut allowed = 0u64;
        let mut allowed_first_window = 0u64;
        for i in 0..12_000 {
            let now = 1 + (i as i64) * (3 * WI) / 12_000;
            let d = roll_window(now, start, W, cur, prev);
            if d.effective_used + step <= BUDGET {
                start = d.new_window_start;
                cur = d.rolled_current + step;
                prev = d.rolled_prev;
                allowed += step;
                if now < 1 + WI {
                    allowed_first_window += step;
                }
            }
        }
        // The FIRST window is the clean assertion: no alignment trickery is available yet because
        // there is no previous bucket to under-count.
        assert!(
            allowed_first_window <= BUDGET,
            "salami-slicing let {allowed_first_window} out of a {BUDGET} budget in the first window"
        );
        // Across three windows the sliding counter must still be doing work: well under 3x.
        assert!(
            allowed < 3 * BUDGET,
            "three windows of slicing allowed {allowed}, i.e. the limiter is not limiting"
        );
        assert!(allowed > BUDGET, "the limiter refused everything after the first window");
    }

    #[test]
    fn a_long_gap_does_not_grant_a_double_budget_on_return() {
        // Idle for ten windows, then hammer. The re-anchor must give ONE budget, not a
        // compensating catch-up.
        let allowed = simulate(&[
            (1_000, BUDGET),
            (1_000 + 10 * WI, BUDGET),
            (1_000 + 10 * WI + 1, BUDGET), // immediately again: must be refused
        ]);
        assert_eq!(allowed, 2 * BUDGET, "the return burst got more than one budget");
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
