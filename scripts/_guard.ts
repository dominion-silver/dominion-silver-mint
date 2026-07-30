/**
 * Mandatory safety guard for every script that can send a transaction.
 *
 * WHY THIS EXISTS, in one sentence: on 2026-07-29 a TEST script closed the public mint
 * that had just been opened through a 24h timelock, because one of its branches
 * "exercised" the instant-close path when it found the mint already open. Reopening cost
 * another 24h. The test reported it as a FAILURE and carried on, so nothing stopped it.
 *
 * That was not a bug in one branch. It was a missing rule. Two rules now exist and are
 * enforced here rather than remembered:
 *
 *   RULE 1  A script may never touch a cluster it was not explicitly pointed at.
 *           Anything that is not devnet requires DOMINION_ALLOW_MAINNET=i-understand,
 *           which is deliberately awkward to type and impossible to hit by accident.
 *
 *   RULE 2  A script may never take an action whose UNDO is slow, irreversible, or
 *           costs a timelock, unless the operator asked for exactly that action.
 *           `assertReversible()` classifies the action and refuses by default.
 *
 * The asymmetry that makes rule 2 necessary is in the program by design: safety actions
 * are instant (pause, close the mint, tighten a limit) and unsafe actions are slow
 * (unpause is instant but OPENING the mint, loosening a limit, or changing the feed all
 * cost 24h). So a script can always break something in one transaction and then need a
 * day to put it back. Tests must therefore only ever move in the direction that is cheap
 * to reverse, and only when asked.
 */

/** Actions classified by how expensive the UNDO is. */
export type ActionCost =
  /** Undo is another transaction, immediately. Safe for a test to do unasked. */
  | "reversible"
  /** Undo needs a 24h timelock. A test must NEVER do this unasked. */
  | "timelocked-undo"
  /** No undo exists without a program upgrade. Operator-only, always. */
  | "irreversible";

/**
 * Every state-changing action a script might take, and what it costs to undo.
 *
 * Keep this list honest. If an action is not here, `assertReversible` refuses it, which
 * is the correct default for something nobody has thought about.
 */
export const ACTION_COST: Record<string, ActionCost> = {
  // Cheap both ways.
  pause: "reversible",
  unpause: "reversible",
  add_guardian: "reversible",
  set_inventory_wallet: "reversible",
  admin_premint: "reversible", // adds supply; the cap bounds it
  propose_any: "reversible", // a proposal can be cancelled instantly
  cancel_timelocked_action: "reversible",
  cancel_guardian_removal: "reversible",

  // CLOSING is instant, but RE-OPENING costs a full timelock. This is the exact pair
  // that caused the incident.
  set_public_mint_enabled_false: "timelocked-undo",
  set_redemptions_enabled_false: "timelocked-undo",
  emergency_tighten_redeem_limits: "timelocked-undo",
  execute_set_public_mint: "timelocked-undo",
  execute_set_pyth_feed: "timelocked-undo",
  remove_guardian: "timelocked-undo", // schedules; finalize needs the window
  finalize_guardian_removal: "timelocked-undo", // re-add needs a cooldown

  // No way back without shipping new code.
  set_max_silv_supply: "irreversible", // tighten-only, by design
  initialize: "irreversible", // one shot per program id
  set_upgrade_authority: "irreversible",
  close_program: "irreversible",
};

function isDevnet(rpc: string): boolean {
  return /devnet/i.test(rpc);
}

/**
 * RULE 1. Refuse to run against anything but devnet unless explicitly authorised.
 *
 * Call this FIRST in every script that sends a transaction, before building anything.
 */
export function requireDevnet(rpc: string, scriptName: string): void {
  if (isDevnet(rpc)) return;
  if (process.env.DOMINION_ALLOW_MAINNET === "i-understand") {
    console.log(
      `\n  !! ${scriptName} is running against a NON-DEVNET cluster (${rpc}) !!`,
    );
    console.log("  !! DOMINION_ALLOW_MAINNET is set. Every action is real. !!\n");
    return;
  }
  throw new Error(
    `${scriptName} refuses to run against ${rpc}.\n` +
      `This script sends transactions and is only sanctioned for devnet.\n` +
      `If you genuinely mean to touch this cluster, set:\n` +
      `  DOMINION_ALLOW_MAINNET=i-understand\n` +
      `and re-read what the script does first.`,
  );
}

/**
 * RULE 2. Refuse an action whose undo is slow, unless the operator asked for it.
 *
 * `intent` is what the operator explicitly requested, normally from an env var or a CLI
 * flag. A test harness passes nothing, so anything worse than "reversible" throws.
 *
 * @param action  a key of ACTION_COST
 * @param intent  the action(s) the operator explicitly sanctioned for this run
 */
export function assertReversible(action: string, intent: string[] = []): void {
  const cost = ACTION_COST[action];
  if (cost === undefined) {
    throw new Error(
      `assertReversible: unknown action "${action}". Add it to ACTION_COST with an ` +
        `honest cost before using it. Refusing by default.`,
    );
  }
  if (cost === "reversible") return;
  if (intent.includes(action)) {
    console.log(`  (sanctioned ${cost} action: ${action})`);
    return;
  }
  throw new Error(
    `REFUSING "${action}": undoing it is ${
      cost === "irreversible" ? "IMPOSSIBLE without a program upgrade" : "a 24h timelock"
    }.\n` +
      `A test must never take an action it cannot cheaply undo. This is the rule added\n` +
      `after a test closed the public mint on 2026-07-29 and cost 24h to reopen.\n` +
      `If an operator really wants this, pass it as an explicit intent.`,
  );
}

/** Parse DOMINION_INTENT="a,b,c" into the sanctioned-action list. */
export function intentFromEnv(): string[] {
  return (process.env.DOMINION_INTENT ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
