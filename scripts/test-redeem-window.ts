/**
 * Pins scripts/_redeem-window.ts against the behaviour of state/redeem_window.rs.
 *
 * The port exists so the monitor measures the budget the way the PROGRAM measures it. That is only
 * true while the two agree, and nothing but this file makes them agree. The cases below are the ones
 * the Rust's own test module covers, plus the property that actually matters operationally: the
 * sliding counter admits close to 2x the budget across one boundary, which is the real bound on a
 * drain and the number an on-call rota has to be sized against.
 *
 *   npx tsx scripts/test-redeem-window.ts
 */
import { adversarialBound, rollWindow } from "./_redeem-window";

const W = 86_400n; // the launch default, 24h
const BUDGET = 20_000_000_000n; // $20k

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}
function eq(name: string, got: bigint, want: bigint) {
  ok(name, got === want, got === want ? "" : `got ${got}, want ${want}`);
}

console.log("rolling redeem window");

// Bootstrap: initialize leaves window_start at 0, which is not a real window.
{
  const d = rollWindow(1000n, 0n, W, 500n, 700n);
  eq("bootstrap keeps both buckets", d.rolledCurrent, 500n);
  eq("and anchors the window at now", d.newWindowStart, 1000n);
}

// Inside the window: nothing rolls, and the previous bucket is weighted by the time still inside.
{
  const d = rollWindow(1000n + W / 2n, 1000n, W, 100n, 1000n);
  eq("inside the window the current bucket is untouched", d.rolledCurrent, 100n);
  // half the window has passed, so half of prev still counts
  eq("and prev is weighted by the fraction still inside", d.effectiveUsed, 100n + 500n);
}

// Exactly one boundary: current becomes prev, and the grid advances by ONE window, not to now.
{
  const d = rollWindow(1000n + W + 10n, 1000n, W, 900n, 5n);
  eq("one boundary moves current into prev", d.rolledPrev, 900n);
  eq("and zeroes current", d.rolledCurrent, 0n);
  eq("and advances the grid by exactly one window", d.newWindowStart, 1000n + W);
}

// Two boundaries: nothing carries.
{
  const d = rollWindow(1000n + 2n * W, 1000n, W, 900n, 900n);
  eq("two idle windows carry nothing", d.effectiveUsed, 0n);
  eq("and re-anchor at now", d.newWindowStart, 1000n + 2n * W);
}

// Clock skew: a window_start in the future must NOT reset the counter into a free refill.
{
  const d = rollWindow(1000n, 5000n, W, 800n, 0n);
  eq("a future window_start still counts prior usage", d.rolledCurrent, 800n);
}

// Degenerate window: the Rust fails OPEN here and the port must agree rather than "improve".
{
  const d = rollWindow(1000n, 500n, 0n, 999n, 999n);
  eq("a zero window reports no usage, matching the program", d.effectiveUsed, 0n);
}

// THE PROPERTY THAT MATTERS, and both halves of it. Mirrors the Rust's own two cases rather than a
// demonstration of my own invention: a first version of this test spaced the drains `2*W` apart from
// t=1 and FAILED, because at one second short of two windows a sliver of the previous bucket still
// counts and a second FULL-budget drain is refused. The failure was correct and worth keeping in the
// record: the 2x bound is real but it is not free, and getting it wrong in the loose direction is how
// a monitor ends up reassuring people.
/** Replay a sequence of attempts against the rule and return what was ALLOWED out. */
function simulate(attempts: [bigint, bigint][]): bigint {
  let start = 0n;
  let cur = 0n;
  let prev = 0n;
  let allowed = 0n;
  for (const [now, amount] of attempts) {
    const d = rollWindow(now, start, W, cur, prev);
    if (d.effectiveUsed + amount <= BUDGET) {
      start = d.newWindowStart;
      cur = d.rolledCurrent + amount;
      prev = d.rolledPrev;
      allowed += amount;
    }
  }
  return allowed;
}

// Two full drains a full 2 windows apart: exactly 2x leaves. This is the bound to plan against.
eq("two drains two windows apart let 2x out", simulate([[1000n, BUDGET], [1000n + 2n * W, BUDGET]]), 2n * BUDGET);
// And the bound COSTS a window. One second later, the second drain is refused: this is the whole
// difference from the fixed window this rule replaced, which allowed 2x in two seconds.
eq("a second drain one second later is refused", simulate([[1000n, BUDGET], [1001n, BUDGET]]), BUDGET);
eq("and a quarter of a window later is still refused", simulate([[1000n, BUDGET], [1000n + W / 4n, BUDGET]]), BUDGET);
eq("the reported bound matches", adversarialBound(BUDGET), 2n * BUDGET);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
