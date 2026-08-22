/**
 * A faithful port of `state/redeem_window.rs::roll_window`, so a reader measures the budget the way
 * the PROGRAM measures it.
 * WHY A PORT AND NOT A GUESS. The obvious approach reads `config.instant_used_usdc` and compares it to
 * the budget. That number is WRONG on its own: the throttle is a two-bucket sliding counter, so the
 * usage that actually counts is the current bucket plus a time-weighted slice of the previous one, and
 * both buckets roll forward on read. A reader using the raw field under-reports right after a boundary
 * and over-reports late in a window. Alerting on the wrong number is worse than not alerting, because
 * it trains whoever is on call to ignore it.
 * The consequence that makes this worth porting exactly: the sliding counter admits close to 2x the
 * budget across one boundary. That is the REAL bound on a drain, ~40,000 USDC in 24h at the launch
 * default, not the ~20,000 the budget field suggests.
 * scripts/test-redeem-window.ts pins this against the Rust behaviour, including the 2x property.
 */

export type WindowDecision = {
  /** The usage that counts against the budget right now. */
  effectiveUsed: bigint;
  newWindowStart: bigint;
  rolledCurrent: bigint;
  rolledPrev: bigint;
};

/**
 * `now`, `windowStart` in seconds; `windowSeconds` the configured window; the two buckets in
 * micro-USDC. All bigint because the Rust does the weighting in u128.
 */
export function rollWindow(
  now: bigint,
  windowStart: bigint,
  windowSeconds: bigint,
  usedCurrent: bigint,
  usedPrev: bigint,
): WindowDecision {
  const w = windowSeconds;
  if (w <= 0n) {
    // Degenerate config. The Rust fails OPEN here (fresh window, no usage) rather than reverting a
    // redemption, and the setters keep the window well above zero. Mirrored, not "improved": a reader
    // that disagreed with the program about a degenerate case would report a breach that cannot happen.
    return { effectiveUsed: 0n, newWindowStart: now, rolledCurrent: 0n, rolledPrev: 0n };
  }
  // Clamped at 0 so a windowStart in the future (clock skew) reads as "no time has passed": all prior
  // usage still counts, instead of the counter resetting for a free budget refill.
  const elapsed = now - windowStart > 0n ? now - windowStart : 0n;

  let start: bigint;
  let current: bigint;
  let prev: bigint;
  if (windowStart === 0n) {
    // Bootstrap sentinel: initialize leaves window_start at 0, which is not a real window.
    start = now;
    current = usedCurrent;
    prev = usedPrev;
  } else if (elapsed >= 2n * w) {
    // Two or more buckets passed with no activity: nothing carries.
    start = now;
    current = 0n;
    prev = 0n;
  } else if (elapsed >= w) {
    // One boundary crossed. Advance the grid by exactly ONE window, not to `now`: re-anchoring on
    // every gap would silently re-align the buckets and hand back part of the budget.
    start = windowStart + w;
    current = 0n;
    prev = usedCurrent;
  } else {
    start = windowStart;
    current = usedCurrent;
    prev = usedPrev;
  }

  const rawInto = now - start;
  const into = rawInto < 0n ? 0n : rawInto > w ? w : rawInto;
  const weightedPrev = (prev * (w - into)) / w;
  return {
    effectiveUsed: current + weightedPrev,
    newWindowStart: start,
    rolledCurrent: current,
    rolledPrev: prev,
  };
}

/**
 * The bound a drain can actually reach over one window length, which is what an operator needs to size
 * their reaction against. `redeem_window.rs` documents and tests that an adversarial alignment lets
 * nearly 2x the budget out in one window-length slice: fill the bucket at the very end of a window,
 * then fill the next one immediately. Reported explicitly so nobody plans against the budget field.
 */
export function adversarialBound(budget: bigint): bigint {
  return budget * 2n;
}
