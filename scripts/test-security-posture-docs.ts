/**
 * ROUND 8 T8-08. Confront the documented security posture with the capabilities the on-chain suite
 * actually EXECUTES.
 *
 * The failure this guards against is drift, and it drifts in both directions:
 *
 *   - a sentence in a comment or a runbook keeps asserting a property after the test that proved it
 *     was renamed, deleted or silently stopped running, so the claim is now unbacked prose;
 *   - the tests keep passing while the prose that tells an operator what the lever does goes stale,
 *     so the person holding the lever in an incident has the wrong model of it.
 *
 * So this script does NOT re-implement the state machine in TypeScript. Re-implementing it would only
 * prove that two of my own models agree with each other. It runs the REAL litesvm tests in
 * `tools/state-harness/tests/caps.rs` and `limits_and_mint.rs`, requires each named test to appear in
 * the runner output as having passed, and only then checks that the source comments and the launch
 * documentation state the same asymmetry those tests just demonstrated.
 *
 * The asymmetry under test, in one sentence: closing redemptions is instant on two lanes, opening
 * them is impossible on both and can only happen through a 24h timelock that a guardian can cancel.
 *
 * Usage:
 *   bash tools/state-harness/run.sh redemptions_ \
 *     && bash tools/state-harness/run.sh --no-build execute_set_redeem_limits_writes_every_field_including_the_redeem_switch \
 *     && npx tsx scripts/test-security-posture-docs.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAPS = "tools/state-harness/tests/caps.rs";
const LIMITS = "tools/state-harness/tests/limits_and_mint.rs";
const TIMELOCK = "tools/state-harness/tests/timelock_guardian.rs";
const RUNBOOK = "docs/MAINNET_LAUNCH_RUNBOOK.md";

let failed = 0;
const fail = (m: string) => {
  console.error(`FAIL: ${m}`);
  failed++;
};

function read(rel: string): string {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    fail(`${rel} does not exist. A posture claim cannot be anchored to a file that is gone.`);
    return "";
  }
  return readFileSync(p, "utf8");
}

/**
 * A capability the posture depends on, tied to the test that demonstrates it.
 *
 * `test` is a real `#[test] fn` name. It is both the harness filter and the string looked for in the
 * runner output, so a rename or a deletion turns into a failure here instead of into a doc claim
 * nobody proves any more.
 */
type Capability = { test: string; file: string; means: string };

const CLOSE_LANES: Capability[] = [
  {
    test: "redemptions_close_instantly_and_the_switch_persists",
    file: CAPS,
    means: "the direct lane closes redemptions with no delay, and the write survives",
  },
  {
    test: "redemptions_cannot_be_opened_instantly_from_either_state",
    file: CAPS,
    means: "the direct lane refuses to open, from the open state AND from the closed state",
  },
  {
    test: "the_emergency_lane_actually_closes_redemptions_and_disarms_a_queued_open",
    file: CAPS,
    means: "the emergency tighten lane closes for real and disarms a queued open",
  },
];

const TIMELOCK_LANE: Capability[] = [
  {
    test: "execute_set_redeem_limits_writes_every_field_including_the_redeem_switch",
    file: LIMITS,
    means: "the timelocked lane is the ONLY path that can set redemptions_enabled back to true",
  },
  {
    test: "a_guardian_can_cancel_a_pending_action_and_the_slot_is_disarmed",
    file: TIMELOCK,
    means: "a guardian can cancel a queued action before it executes, and the slot is disarmed",
  },
];

/**
 * Run the real harness for one capability and require its test to be reported as passing.
 *
 * `--no-build` on purpose: the acceptance command builds first, and rebuilding per test would make
 * this script minutes long for no added guarantee. The build is the caller's step.
 *
 * A filter that matches NOTHING makes cargo exit 0 with "0 passed", which is the classic vacuous
 * green, so a run is only accepted when the exact test name is present in the output followed by
 * `... ok`.
 */
function executed(cap: Capability): boolean {
  const src = read(cap.file);
  if (!src.includes(`fn ${cap.test}(`)) {
    fail(
      `${cap.file} no longer defines ${cap.test}.\n` +
        `      The posture claims "${cap.means}" but nothing demonstrates it any more.`,
    );
    return false;
  }
  let out: string;
  try {
    out = execFileSync("bash", ["tools/state-harness/run.sh", "--no-build", cap.test], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    fail(`${cap.test} did not pass:\n${(err.stdout ?? "") + (err.stderr ?? "")}`.slice(0, 2000));
    return false;
  }
  const ran = new RegExp(`test\\s+${cap.test}\\s+\\.\\.\\.\\s+ok`).test(out);
  if (!ran) {
    fail(
      `the harness reported success without running ${cap.test}.\n` +
        `      A filter that matches nothing exits 0, which would make this whole check vacuous.`,
    );
    return false;
  }
  return true;
}

/** Every phrase must appear, otherwise the doc no longer states what the tests demonstrate. */
function statesAll(rel: string, phrases: string[], label: string): boolean {
  const src = read(rel);
  if (!src) return false;
  const missing = phrases.filter((p) => !src.includes(p));
  if (missing.length > 0) {
    fail(
      `${label} (${rel}) does not state the asymmetry the tests just proved.\n` +
        missing.map((m) => `      missing: ${JSON.stringify(m)}`).join("\n"),
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 1. the two closing lanes

const closeOk = CLOSE_LANES.map(executed).every(Boolean);
if (closeOk) console.log("ok: direct and emergency lanes can only close redemptions");

// ---------------------------------------------------------------- 2. the one reopening lane

const openOk = TIMELOCK_LANE.map(executed).every(Boolean);
if (openOk)
  console.log(
    "ok: SetRedeemLimits can reopen only after the timelock and remains guardian-cancellable",
  );

// ---------------------------------------------------------------- 3. the prose that describes them
//
// Source comments first: they are what the next person to touch the handler reads. Then the runbook,
// which is what an operator reads at 3am while deciding whether a lever is reversible.

const commentsOk =
  statesAll(
    CAPS,
    [
      "Opening is the largest loosening the program has, so it is refused in bytecode whatever the",
      "must ride the 24h timelock instead",
      "The apply arm for redemptions_enabled",
    ],
    "the caps.rs source comments",
  ) &&
  statesAll(
    LIMITS,
    ["The only path that can OPEN redemptions"],
    "the limits_and_mint.rs source comments",
  );

const runbookOk = statesAll(
  RUNBOOK,
  [
    "Closing redemptions is instant on two lanes; opening them is refused on both and can only",
    "happen through the 24h timelock, which a guardian can cancel.",
  ],
  "the launch runbook",
);

if (commentsOk && runbookOk)
  console.log("ok: source comments and launch documentation state that exact asymmetry");

if (failed > 0) {
  console.error(`\nSECURITY POSTURE DOC TEST FAILED: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log("SECURITY POSTURE DOC TEST OK");
