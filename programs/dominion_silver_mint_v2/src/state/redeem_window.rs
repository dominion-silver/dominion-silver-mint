//! The redemption rate limiter: a SLIDING window counter over two buckets.
//!
//! `effective = current + previous * (window - elapsed_into_bucket) / window`.
//!
//! It is an APPROXIMATION: usage inside a bucket is counted as uniformly spread, so usage
//! concentrated at the end of a bucket is under-counted. The worst case is 2 x budget, reached when
//! two full drains land `window - 1` seconds apart. A fixed window allowed that same 2x in about one
//! second, so what the sliding counter buys is the RATE, not a tighter bound. Size
//! `instant_redeem_budget_usdc` at HALF the maximum outflow you will accept in a day.
//!
//! This budget is the only hard brake between a bad oracle print and the treasury: the oracle guards
//! (staleness, publisher floor, price-delta breaker) are filters, not limiters.

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
/// Pure: the caller adds the request amount to `rolled_current`, compares `effective_used + amount`
/// against the budget, and persists all three values only once every other check passes.
///
/// `window_seconds` is in SECONDS and must never be zero: at zero this fails OPEN. The setters bound
/// it to `[INSTANT_WINDOW_MIN_SECONDS, INSTANT_WINDOW_MAX_SECONDS]`.
pub fn roll_window(
    now: i64,
    window_start: i64,
    window_seconds: u32,
    used_current: u64,
    used_prev: u64,
) -> WindowDecision {
    let w = window_seconds as i64;
    if w <= 0 {
        // Degenerate config: fresh window, no usage. This is the LOOSE direction (it fails open on
        // the accounting rather than reverting a redemption), so the window length must never be
        // zero. The setters keep it well above zero.
        return WindowDecision {
            effective_used: 0,
            new_window_start: now,
            rolled_current: 0,
            rolled_prev: 0,
        };
    }

    // Clamped at 0 so a `window_start` in the future (clock skew) reads as "no time has passed":
    // all prior usage still counts, instead of the counter resetting for a free budget refill.
    let elapsed = now.saturating_sub(window_start).max(0);

    let (start, current, prev) = if window_start == 0 {
        // Bootstrap sentinel: `initialize` leaves window_start at 0, which is not a real window.
        (now, used_current, used_prev)
    } else if elapsed >= 2 * w {
        // Two or more buckets have passed with no activity: nothing carries.
        (now, 0, 0)
    } else if elapsed >= w {
        // One boundary crossed. Advance the grid by exactly one window, NOT to `now`: re-anchoring
        // on every gap would silently re-align the buckets and hand back part of the budget.
        (window_start + w, 0, used_current)
    } else {
        (window_start, used_current, used_prev)
    };

    let into = now.saturating_sub(start).clamp(0, w);
    // Weight the previous bucket by the fraction still inside the trailing window. u128 so
    // `prev * (w - into)` cannot overflow for any u64 prev and any legal window.
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
        // The old fixed window returned 2 x BUDGET here.
        let allowed = simulate(&[
            (1_000, BUDGET),  // drain the whole budget early in bucket 1
            (WI + 1, BUDGET), // one second past the boundary: used to reset to zero
        ]);
        assert_eq!(
            allowed, BUDGET,
            "a redemption one second after the window boundary must NOT get a fresh full budget"
        );
    }

    #[test]
    fn a_full_window_later_the_budget_is_available_again() {
        let allowed = simulate(&[(1_000, BUDGET), (1_000 + 2 * WI, BUDGET)]);
        assert_eq!(allowed, 2 * BUDGET);
    }

    #[test]
    fn usage_decays_linearly_rather_than_stepping() {
        let d = roll_window(WI + WI / 2, 0 + 0, W, 0, 0);
        assert_eq!(d.effective_used, 0);

        let d = roll_window(WI + WI / 2, WI, W, 0, BUDGET);
        assert_eq!(d.effective_used, BUDGET / 2);
        let d = roll_window(WI + WI / 4, WI, W, 0, BUDGET);
        assert_eq!(d.effective_used, BUDGET / 4 * 3);
        // At the boundary itself ALL of it counts. This is the case the old code got wrong.
        let d = roll_window(WI, WI, W, 0, BUDGET);
        assert_eq!(d.effective_used, BUDGET);
    }

    #[test]
    fn a_uniform_timeline_stays_within_the_bound() {
        // ONE uniform timeline, which by the closed form maxes out near 1.0007x, so this is a sanity
        // floor only. The adversarial alignments are the next two tests.
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
            // 2x is the real bound. See the module docs.
            assert!(
                in_span <= BUDGET * 2,
                "a {WI}s span starting at {t0} allowed {in_span}, above the 2x bound"
            );
        }
        let first: u64 = timeline
            .iter()
            .filter(|&&(t, _)| t < WI)
            .map(|&(_, a)| a)
            .sum();
        assert!(first <= BUDGET, "first window allowed {first} > {BUDGET}");
    }

    #[test]
    fn a_half_window_alignment_reaches_1_5x() {
        // ONE alignment: the half-window case reaches 1.5x. It is not the maximum, which is at
        // `into -> w`. See the next test.
        let mut start = 1i64;
        let mut cur = 0u64;
        let mut prev = 0u64;

        let t1 = start + WI - 1;
        let d = roll_window(t1, start, W, cur, prev);
        assert!(d.effective_used + BUDGET <= BUDGET);
        start = d.new_window_start;
        cur = d.rolled_current + BUDGET;
        prev = d.rolled_prev;

        let t2 = t1 + WI / 2;
        let d = roll_window(t2, start, W, cur, prev);
        let available = BUDGET - d.effective_used;
        // Tolerance is 0.1% of budget, not exact: the first spend landed one second before the
        // boundary, so `into` is 43199 and that second propagates as ~0.23 USDC of weighting.
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

        let total = BUDGET + available;
        assert!(
            total <= BUDGET + half + tol,
            "the half-window alignment let {total} out, above the 1.5x expected there"
        );
    }

    #[test]
    fn two_spends_one_second_short_of_a_window_reach_almost_2x() {
        // THE REAL WORST CASE. Spend the whole budget at `start + w - 1`, then again at
        // `start + 2w - 2`: the spends are `w - 1` apart so both lie inside one trailing window, and
        // by then the previous bucket's weight has decayed to 2/w.
        const START: i64 = 1;
        let t1 = START + WI - 1;
        let d1 = roll_window(t1, START, W, 0, 0);
        assert_eq!(d1.effective_used, 0);
        let (start2, cur2, prev2) = (
            d1.new_window_start,
            d1.rolled_current + BUDGET,
            d1.rolled_prev,
        );

        let t2 = START + 2 * WI - 2;
        assert!(
            t2 - t1 < WI,
            "the two spends must fall inside one trailing window"
        );
        let d2 = roll_window(t2, start2, W, cur2, prev2);

        // The counter now believes only prev * 2/w is outstanding.
        let expected_effective = (BUDGET as u128 * 2 / WI as u128) as u64;
        assert_eq!(d2.effective_used, expected_effective);

        let second_spend = BUDGET - d2.effective_used;
        let total = BUDGET + second_spend;
        assert!(
            total > BUDGET + BUDGET / 2,
            "total {total} should exceed the 1.5x that was wrongly documented as the bound"
        );
        assert!(
            total <= 2 * BUDGET,
            "total {total} exceeded the true 2x bound"
        );
        let bps_of_budget = (total as u128 * 10_000 / BUDGET as u128) as u64;
        assert!(
            bps_of_budget >= 19_990,
            "expected ~1.9999x, got {bps_of_budget} bps of budget"
        );
    }

    #[test]
    fn the_rate_improvement_is_real_even_though_the_bound_is_not() {
        // The old fixed window allowed a second drain one second later. The 2x now needs a window.
        let allowed = simulate(&[(1_000, BUDGET), (1_000 + 1, BUDGET)]);
        assert_eq!(
            allowed, BUDGET,
            "a one-second-later second drain must be refused"
        );
        let allowed = simulate(&[(1_000, BUDGET), (1_000 + WI / 4, BUDGET)]);
        assert_eq!(
            allowed, BUDGET,
            "a quarter-window-later second drain must be refused"
        );
    }

    #[test]
    fn many_tiny_requests_cannot_beat_the_limiter() {
        // The rounding in the weighting must not leak per-request. Time has to advance MONOTONICALLY
        // here: `i % WI` never crosses a boundary and silently tests a backwards clock instead.
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
        // The FIRST window is the clean assertion: there is no previous bucket to under-count yet.
        assert!(
            allowed_first_window <= BUDGET,
            "salami-slicing let {allowed_first_window} out of a {BUDGET} budget in the first window"
        );
        assert!(
            allowed < 3 * BUDGET,
            "three windows of slicing allowed {allowed}, i.e. the limiter is not limiting"
        );
        assert!(
            allowed > BUDGET,
            "the limiter refused everything after the first window"
        );
    }

    #[test]
    fn a_long_gap_does_not_grant_a_double_budget_on_return() {
        // Idle ten windows, then hammer. The re-anchor gives ONE budget, not a catch-up.
        let allowed = simulate(&[
            (1_000, BUDGET),
            (1_000 + 10 * WI, BUDGET),
            (1_000 + 10 * WI + 1, BUDGET), // immediately again: must be refused
        ]);
        assert_eq!(
            allowed,
            2 * BUDGET,
            "the return burst got more than one budget"
        );
    }

    #[test]
    fn a_bootstrap_config_anchors_without_inheriting_1970() {
        // Treating the 0 sentinel as a real bucket start makes `elapsed` 56 years: lucky, not safe.
        let d = roll_window(1_800_000_000, 0, W, 0, 0);
        assert_eq!(d.new_window_start, 1_800_000_000);
        assert_eq!(d.effective_used, 0);
    }

    #[test]
    fn clock_skew_backwards_does_not_reset_the_counter() {
        // Resetting on a future window_start would be a free refill on a validator clock wobble.
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
        // `window_start` must be NON-ZERO here: zero is the bootstrap sentinel and takes a different
        // branch, so a zero would make this test assert nothing about the behaviour it names.
        const START: i64 = 1_000;
        let d = roll_window(START + WI + 100, START, W, BUDGET, 0);
        assert_eq!(
            d.new_window_start,
            START + WI,
            "the new bucket must start exactly one window after the old one, not at `now`"
        );
        assert_eq!(d.rolled_prev, BUDGET);
        assert_eq!(d.rolled_current, 0);
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
        // Unreachable via the setters (INSTANT_WINDOW_MIN_SECONDS is 60). Guarded anyway.
        let d = roll_window(1_000, 500, 0, BUDGET, BUDGET);
        assert_eq!(d.effective_used, 0);
        assert_eq!(d.new_window_start, 1_000);
    }
}

#[cfg(test)]
mod ratchet_check {
    // redeem_silv.rs step 8 claims that feeding `effective_used` into the CURRENT bucket would
    // ratchet the limiter shut. A claim in a comment is not a test.
    use super::*;
    const W: u32 = 86_400;
    const WI: i64 = 86_400;
    const BUDGET: u64 = 20_000_000_000;

    /// 60 windows of steady traffic at 50% utilisation. The limiter must never close.
    #[test]
    fn steady_traffic_never_ratchets_the_limiter_shut() {
        let mut start = 0i64;
        let mut cur = 0u64;
        let mut prev = 0u64;
        let step = BUDGET / 10; // 10% of budget per redemption
        let mut rejected = 0;
        for i in 0..(60 * 5) {
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
