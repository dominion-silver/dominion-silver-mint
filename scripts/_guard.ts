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
import {
  assertClusterMatchesChain,
  classifyCluster,
  resolveClusterFor,
} from "./_cluster";

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

  // --- Pre-mainnet upgrade, 2026-08-05 ---
  // AUDIT FINDING D-03. This said "reversible" because "an empty ATA can be closed". It cannot.
  // Closing a token account needs the OWNER's signature, the owner here is the fee_vault PDA, and
  // this program signs no CloseAccount for it anywhere: see the comment at
  // instructions/mint_silv.rs:60, which states exactly that, and launch_posture.fee_vault in
  // config/mainnet-authorities.json, which states it again. So the rent is locked for the life of
  // the program and `assertReversible` was handing out RULE 2's guarantee for an action that has no
  // undo. Classified honestly now; it still gets created, just not without the operator saying so.
  create_fee_vault: "irreversible",
  set_fee_exempt: "reversible", // remove_fee_exempt is instant
  remove_fee_exempt: "reversible", // set_fee_exempt is instant
  set_kyc_operator: "reversible",
  attest_kyc: "reversible",
  revoke_kyc: "reversible",
  // Arming the KYC gate LOCKS USERS OUT, but disarming is one instant transaction, and this
  // table's axis is strictly the cost to UNDO. Classified honestly on that axis, with the
  // warning recorded here: arming with no attestations written is a total lockout for as long
  // as it takes somebody to notice.
  set_kyc_scope: "reversible",
  // NOTE THE INVERSION vs set_public_mint_enabled above. Opening redemptions costs a 24h
  // timelock, but CLOSING them is instant (`set_redemptions_enabled(false)`), so the UNDO is
  // cheap and this is genuinely "reversible" on this table's axis. It is still the most
  // consequential switch in the program, because it opens the only user-facing path that pays
  // out treasury cash. A script must not open it unasked for that reason, not because the undo
  // is expensive.
  execute_open_redemptions: "reversible",

  // No way back without shipping new code.
  set_max_silv_supply: "irreversible", // tighten-only, by design
  initialize: "irreversible", // one shot per program id
  set_upgrade_authority: "irreversible",
  close_program: "irreversible",
  // Funds leave to a caller-supplied address. Recoverable only if you control the
  // destination, which a script cannot assume, so this is operator-only.
  withdraw_fees: "irreversible",

  // REVIEW-OF-FIXES P1. `upgrade-program.ts` borrowed `set_upgrade_authority` and
  // `execute_set_public_mint` as its intent tokens, which was wrong twice over. First, the documented
  // command was `DOMINION_INTENT=irreversible`, and `assertReversible` matches the intent against the
  // ACTION NAME, not against the cost, so the documented command was REFUSED and the --execute path had
  // never run: the S-03 shape again, an upgrade helper whose real path is dead. Second, the error names
  // the action it wants, so the operator's natural fix was to export `DOMINION_INTENT=set_upgrade_authority`
  // for a routine bytecode upgrade, which then pre-authorises transferring or revoking the upgrade
  // authority for every later command in that shell. Opening the public mint by accident is the literal
  // incident RULE 2 was created after.
  extend_program_data: "irreversible", // rent for the added bytes is locked for the program's life
  deploy_program: "irreversible", // new bytecode; the old bytes are gone
};

/**
 * REVIEW-OF-FIXES P0. This was `/devnet/i.test(rpc)` against the WHOLE URL, and it is the predicate the
 * consent gate below turns on, so it was the actual bypass: any mainnet endpoint whose query string,
 * path or API key happened to contain the six characters "devnet" returned true, `requireDevnet`
 * returned early, and DOMINION_ALLOW_MAINNET was never demanded. Measured examples in `_cluster.ts`.
 *
 * It now delegates to the one classifier, so the guard and the address resolution cannot disagree about
 * which cluster this is. Having two implementations of "is this devnet" was the underlying defect; the
 * regex was only how it showed up.
 *
 * REVIEW-OF-FIXES P2-6: LOCALNET counts as safe here. It did not, so `requireDevnet` demanded the
 * mainnet consent variable for `http://127.0.0.1:8899`, which is the cluster the audit's own re-audit
 * criterion 2 says to rehearse the upgrade on. Training the operator to export
 * DOMINION_ALLOW_MAINNET for a local rehearsal disables RULE 1 for every later command in that shell.
 */
function isDevnet(rpc: string): boolean {
  try {
    const c = classifyCluster(rpc);
    return c === "devnet" || c === "localnet";
  } catch {
    // An unparseable or unsupported endpoint is not devnet. Fail towards demanding consent.
    return false;
  }
}

/**
 * RULE 1. Refuse to run against anything but devnet unless explicitly authorised, AND confirm with the
 * chain that it really is the cluster the hostname claims.
 *
 * **This is async and there is deliberately no synchronous version.** The previous synchronous
 * `requireDevnet` was renamed out of existence rather than kept as an alias, so every call site became a
 * compile error until it was updated. That is the point: the re-audit found the genesis-hash check wired
 * into three scripts and MISSING FROM THIRTEEN, including `create-fee-vault.ts`, which is a mandatory
 * mainnet step. I had fixed instances and left the class, for the fourth time in this batch.
 *
 * The lesson, written here because this is the chokepoint: when a safety check has to be CALLED, the
 * scripts that forget it are the ones that matter. So the check lives inside the guard every sending
 * script already calls, and the guard cannot be called without it.
 *
 * Call this FIRST in every script that sends a transaction, before building anything.
 */
/** The CONSENT half of RULE 1, synchronous and network-free, so it can be unit-tested cheaply.
 *
 *  Split out for the cluster gate: testing consent for four URLs should not cost four RPC round trips.
 *  It is NOT a substitute for `requireSanctionedCluster`: consent without the genesis check is exactly
 *  the hole that let a devnet-hostname proxy spend mainnet funds. */
export function guardConsentOnly(rpc: string, scriptName = "this script"): void {
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

export async function requireSanctionedCluster(
  rpc: string,
  scriptName: string,
): Promise<void> {
  guardConsentOnly(rpc, scriptName);

  // The hostname is a claim made by whoever set DOMINION_RPC; the genesis hash is what the chain IS.
  // Without this, `https://devnet.proxy.example` pointed at mainnet passes the consent gate as devnet and
  // spends real funds while printing "devnet". That was the re-audit's second P0.
  await assertClusterMatchesChain(resolveClusterFor(rpc));
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
