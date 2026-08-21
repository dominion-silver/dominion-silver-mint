/**
 * Mandatory safety guard for every script that can send a transaction. Two rules, enforced here rather
 * than remembered:
 *
 *   RULE 1  Never touch a cluster the script was not pointed at. Anything but devnet and localnet needs
 *           DOMINION_ALLOW_MAINNET=i-understand, and the chain's genesis hash must agree with the host.
 *   RULE 2  Never take an action whose undo is slow or impossible unless the operator named that exact
 *           action. Safety actions are instant while their reversals cost 24h, so one transaction can
 *           cost a day to undo, which is how a test once closed the public mint.
 */
import {
  assertClusterMatchesChain,
  classifyCluster,
  resolveClusterFor,
} from "./_cluster";
import { redactRpc } from "./_redact";

export type ActionCost =
  | "reversible"
  | "timelocked-undo"
  | "irreversible";

/** Every state-changing action a script might take, and what it costs to UNDO. That is the ONLY axis: an
 *  action can be catastrophic and still be "reversible" here. An action missing from the list is refused,
 *  the right default for something nobody has thought about, so keep the list honest. */
export const ACTION_COST: Record<string, ActionCost> = {
  pause: "reversible",
  unpause: "reversible",
  add_guardian: "reversible",
  // ROUND 8 T8-03: `set_inventory_wallet` is DELETED from the program, so it is deleted here too. An
  // action missing from this table is REFUSED, which is the behaviour we want for a name that no
  // longer dispatches. The destination is now bound by `initialize` (irreversible, below) and the
  // only later writer is the 24h-timelocked pair.
  // Funding the redemption treasury. NOT `reversible`: getting it back out is
  // `propose_withdraw_usdc` then `execute_withdraw_usdc`, a 24h `admin_timelock_seconds` window and a
  // 3-of-5 on each leg. Money in is same-day; money out is next-day at best, so the honest cost is
  // timelocked-undo and the operator has to name it.
  // PROPOSING a mint-premium change. NOT `reversible`, and the reason is the D30 front-run defence:
  // `propose_set_premium_mint` sets `mint_paused_until = now + admin_timelock_seconds` AND
  // `pending_premium_mint_nonce`, and `mint_silv` refuses on either (mint_silv.rs:139-146). So the
  // instant this lands, EVERY mint reverts `MintPaused` - the site, the market makers, any direct
  // call - for 24h minimum. Undoing it is `cancel_timelocked_action`, another 3-of-5, and the service
  // stays down until that lands. A pause on a running protocol is not a reversible action in the sense
  // this table means, so it must be named as an intent rather than inherited by default.
  propose_set_premium_mint: "timelocked-undo",
  // EXECUTING it. This is the action that both applies the new premium AND lifts the mint pause, so it
  // is the one that RESTORES service. Undoing it means proposing the old value again, which pauses mints
  // for another 24h, so it is timelocked-undo rather than reversible.
  execute_set_premium_mint: "timelocked-undo",
  deposit_usdc: "timelocked-undo",
  propose_set_inventory_wallet: "reversible", // a proposal can be cancelled instantly
  execute_set_inventory_wallet: "timelocked-undo", // moving it back costs another full window
  // REVIEW PASS 2026-08-10. This said `reversible`, "adds supply; the cap bounds it". The cap bounds
  // the TOTAL; it is not an undo. There is NO admin burn anywhere in this program: the only burn is
  // `silv_burn_from_user` (cpi.rs), it requires the HOLDER's signature, and it only runs inside
  // `redeem_silv`, which pays out treasury USDC. So an over-mint cannot be undone, and the nearest
  // thing to an undo drains the treasury. Meanwhile the tokens land in an on-curve single-signer
  // wallet whose holder can call redeem_silv with no timelock.
  // Classifying it `reversible` made assertReversible return before it ever read the intent list, so
  // the ONE step that mints the entire launch supply was the only consequential step in the runbook
  // needing no named DOMINION_INTENT. `set_max_silv_supply` is `irreversible` here on strictly weaker
  // grounds.
  admin_premint: "irreversible",
  propose_any: "reversible", // a proposal can be cancelled instantly
  cancel_timelocked_action: "reversible",
  cancel_guardian_removal: "reversible",

  // CLOSING is instant, RE-OPENING costs a full timelock. The pair that caused the incident.
  set_public_mint_enabled_false: "timelocked-undo",
  set_redemptions_enabled_false: "timelocked-undo",
  emergency_tighten_redeem_limits: "timelocked-undo",
  execute_set_public_mint: "timelocked-undo",
  execute_set_pyth_feed: "timelocked-undo",
  remove_guardian: "timelocked-undo", // schedules; finalize needs the window
  finalize_guardian_removal: "timelocked-undo", // re-add needs a cooldown

  // NOT reversible: closing a token account needs the OWNER's signature, the owner is the fee_vault PDA,
  // and this program signs no CloseAccount for it anywhere (mint_silv.rs:60). Rent locked for good.
  create_fee_vault: "irreversible",
  // Same shape as create_fee_vault and irreversible for the same reason: the owner is a program PDA,
  // closing a token account needs the OWNER's signature, and this program signs no CloseAccount for
  // it anywhere. The rent is locked for good. It is normally created by `initialize`
  // (init_if_needed), so this action exists only to create it EARLY, which is what lets the treasury
  // be funded before the ceremony.
  create_usdc_treasury: "irreversible",
  // An associated token account holds only rent and can be closed by its owner. Here the owner is the
  // ops Squads vault, so closing it costs a 3-of-5 round: slow, not impossible. Classified reversible
  // because the point of this list is "can this be cheaply undone", and rent that a 3-of-5 can reclaim
  // is the cheapest thing on it.
  create_inventory_silv_ata: "reversible",
  set_fee_exempt: "reversible", // remove_fee_exempt is instant
  remove_fee_exempt: "reversible", // set_fee_exempt is instant
  set_kyc_operator: "reversible",
  attest_kyc: "reversible",
  revoke_kyc: "reversible",
  // Arming with no attestations written is a total lockout, but disarming is one instant transaction.
  set_kyc_scope: "reversible",
  // NOTE THE INVERSION vs set_public_mint_enabled: OPENING redemptions costs a 24h timelock, closing is
  // instant. Cheap undo, but it opens the only path paying out treasury cash, so never open it unasked.
  execute_open_redemptions: "reversible",

  set_max_silv_supply: "irreversible", // tighten-only, by design
  initialize: "irreversible", // ONE SHOT per program id
  /**
   * `irreversible` was already the right call; this is why, now that we are actually about to use it.
   * The undo is CONDITIONAL ON THE DESTINATION. Send it to the multisig's VAULT and the undo is a 3-of-5.
   * Send it to a typo, to the multisig ACCOUNT rather than its vault, or to None, and there is no undo at
   * all, by anyone, ever: the program can never be upgraded or fixed again. See
   * scripts/transfer-upgrade-authority.ts, which derives the destination instead of trusting it.
   */
  set_upgrade_authority: "irreversible",
  close_program: "irreversible",
  withdraw_fees: "irreversible", // funds leave to a caller-supplied address; a script cannot assume it

  // Its OWN tokens: borrowing `set_upgrade_authority` would pre-authorise an authority transfer for the shell.
  extend_program_data: "irreversible", // rent for the added bytes is locked for the program's life
  deploy_program: "irreversible", // new bytecode; the old bytes are gone
};

/** Delegates to the ONE classifier, never a local regex: a second implementation of "is this devnet" is how
 *  a mainnet URL merely containing that substring bypassed the consent gate. LOCALNET counts as safe,
 *  because demanding mainnet consent for a local rehearsal disables RULE 1 for the rest of that shell. */
function isDevnet(rpc: string): boolean {
  try {
    const c = classifyCluster(rpc);
    return c === "devnet" || c === "localnet";
  } catch {
    // An unparseable or unsupported endpoint is not devnet. Fail towards demanding consent.
    return false;
  }
}

/** The CONSENT half of RULE 1, sync and network-free so the cluster gate can test many URLs cheaply. NOT a
 *  substitute for `requireSanctionedCluster`: consent alone lets a devnet-hostname proxy spend mainnet. */
export function guardConsentOnly(rpc: string, scriptName = "this script"): void {
  if (isDevnet(rpc)) return;
  if (process.env.DOMINION_ALLOW_MAINNET === "i-understand") {
    console.log(
      // REDACTED, and this line used to print `rpc` raw. That put a live Helius API key in the first
      // line of output of every mainnet ceremony: on a terminal that gets screenshotted, pasted into a
      // handover doc, or copied into a chat while asking "is this right?". `_redact.ts` was written for
      // exactly this and this call site did not use it. Found on 2026-08-21 by reading the output of a
      // dry run rather than by reading the code.
      `\n  !! ${scriptName} is running against a NON-DEVNET cluster (${redactRpc(rpc)}) !!`,
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

/** RULE 1 in full: consent, then the chain's own confirmation that it is the cluster the hostname claims.
 *  Call it FIRST in a sending script. Async with NO sync variant, so no call site can skip the genesis half. */
export async function requireSanctionedCluster(
  rpc: string,
  scriptName: string,
): Promise<void> {
  guardConsentOnly(rpc, scriptName);

  // The hostname is a claim made by whoever set DOMINION_RPC; the genesis hash is what the chain IS.
  await assertClusterMatchesChain(resolveClusterFor(rpc));
}

/** RULE 2. Refuse an action whose undo is slow unless `intent` names that exact ACTION, not its cost. A
 *  harness passes nothing, so anything worse than "reversible" throws. Call it before the first lamport. */
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
