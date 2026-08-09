/**
 * ROUND 8 L1-04. The preconditions of the FIRST UNPAUSE, as one decision function.
 *
 * WHY THIS EXISTS AS A MODULE AND NOT AS CHECKS INSIDE THE CEREMONY. The posture change made the
 * unpause the go-live: `initialize` leaves public mint and redemptions OPEN, so the pause is the only
 * thing between a deployed program and a live one. Every prerequisite that used to be spread across
 * runbook prose and a readiness script that ran at a different time now has to hold at ONE moment,
 * and something has to refuse if it does not.
 *
 * It is PURE so that `scripts/test-launch-open-readiness.ts` can drive every refusal without a
 * cluster, and it is IMPORTED BY `ceremony-step8.ts`, so the same decision that the test exercises is
 * the one that gates the ceremony. A readiness report nobody blocks on is what the previous round
 * shipped.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: judge whether the guardian is genuinely independent. No check can.
 * It asserts that an ACTIVE guardian exists whose key is not the admin, which is what the program
 * enforces, and the trust boundary beyond that is custody, stated in the D11 note.
 */
import { PublicKey } from "@solana/web3.js";

/** Everything the decision reads, gathered by the caller so this file touches no network. */
export interface LaunchState {
  /** `config.paused`. When already false the protocol is live and this is a re-run, not a go-live. */
  paused: boolean;
  /** `config.public_mint_enabled` / `config.redemptions_enabled`, as the chain holds them. */
  publicMintEnabled: boolean;
  redemptionsEnabled: boolean;
  /** `config.inventory_wallet` on chain, and the address the manifest names. */
  boundInventoryWallet: PublicKey;
  expectedInventoryWallet: PublicKey;
  /** Whether the premium fee vault ATA exists. mint_silv and redeem_silv both REQUIRE it. */
  feeVaultExists: boolean;
  /** Circulating SILV, atomic units, read off the mint at go-live.
   *
   *  THIS REPLACED A TREASURY THRESHOLD, and the reasoning is worth keeping. The first version
   *  demanded the treasury hold a decided minimum before the unpause, on the argument that redeem is
   *  open from `initialize` so go-live advertises a redeem that must be honourable. That argument is
   *  wrong at this exact moment: `initialize` refuses a mint that already has supply, and BOTH
   *  emission paths (`admin_premint`, `mint_silv`) require `!paused`. So at the first unpause the
   *  supply is provably zero, nobody holds SILV, and nobody can redeem. An empty treasury harms
   *  nobody, and it funds itself from the mints that follow.
   *
   *  What IS worth refusing is the state that contradicts that reasoning: supply already in
   *  circulation at the first unpause, which means the sequence was not the one this ceremony
   *  assumes. It costs one read, needs no decided number, and catches a real mistake. */
  circulatingSilv: bigint;
  /** Guardians the program would accept: active, and not the current admin. */
  activeIndependentGuardians: number;
  /** `config.min_publishers`, and the floor the launch requires. */
  minPublishers: number;
  requiredMinPublishers: number;
  /** `config.pyth_lazer_feed_id`, and the feed the manifest names. */
  feedId: number;
  expectedFeedId: number;
}

export interface Blocker {
  /** Stable id, so a runbook or a test names a refusal instead of matching prose. */
  id: string;
  why: string;
}

export interface LaunchDecision {
  ready: boolean;
  blockers: Blocker[];
  /** True when the protocol is already live, so this is a verification and not a go-live. */
  alreadyLive: boolean;
}

/**
 * The refusals, in the order an operator would hit them.
 *
 * Every one of these is a state in which the unpause produces a protocol that is live and broken, or
 * live and unguarded. None of them is a style preference.
 */
export function decideLaunchReadiness(s: LaunchState): LaunchDecision {
  const blockers: Blocker[] = [];

  // The fee vault. mint_silv and redeem_silv take it as a REQUIRED account, so without it the very
  // first user action after go-live reverts AccountNotInitialized, which reads as a broken program.
  if (!s.feeVaultExists) {
    blockers.push({
      id: "fee-vault-missing",
      why:
        "the premium fee vault does not exist. mint_silv and redeem_silv both require it, so every " +
        "mint and every redeem would revert AccountNotInitialized. Run scripts/create-fee-vault.ts.",
    });
  }

  // Supply must be zero at the FIRST unpause, because the launch sequence makes it so: initialize
  // refuses a mint carrying supply, and both emission paths require !paused. Anything else means the
  // protocol was already live, or the pre-mint ran before the go-live it is supposed to follow.
  if (s.paused && s.circulatingSilv !== 0n) {
    blockers.push({
      id: "supply-already-circulating",
      why:
        `${s.circulatingSilv} atomic SILV is already in circulation while the protocol is still ` +
        "paused. The launch sequence cannot produce that: both emission paths require !paused, so " +
        "this config was live before, and the assumptions behind this go-live no longer hold.",
    });
  }

  // The pre-mint destination. Bound atomically and changeable only through the 24h timelock, so a
  // mismatch cannot be repaired before the unpause and must stop it.
  if (!s.boundInventoryWallet.equals(s.expectedInventoryWallet)) {
    blockers.push({
      id: "inventory-wallet-mismatch",
      why:
        `config.inventory_wallet is ${s.boundInventoryWallet.toBase58()} but the manifest names ` +
        `${s.expectedInventoryWallet.toBase58()}. initialize bound it and only a 24h timelocked ` +
        "change can move it.",
    });
  }

  // The independent brake. The program refuses the unpause without it; this is the same rule, read
  // before the transaction so the ceremony stops with an explanation instead of a revert.
  if (s.activeIndependentGuardians < 1) {
    blockers.push({
      id: "no-independent-guardian",
      why:
        "no ACTIVE guardian distinct from the current admin. Every timelock in this program assumes " +
        "somebody other than the admin can cancel, and the emergency response assumes somebody can " +
        "pause. unpause refuses this state on chain.",
    });
  }

  // The oracle. The posture makes the priced path load-bearing from the first unpause, so the guards
  // stop being dormant configuration and start deciding what users pay.
  if (s.feedId !== s.expectedFeedId) {
    blockers.push({
      id: "wrong-feed",
      why: `config.pyth_lazer_feed_id is ${s.feedId}, the manifest names ${s.expectedFeedId}.`,
    });
  }
  if (s.minPublishers < s.requiredMinPublishers) {
    blockers.push({
      id: "publisher-floor-too-low",
      why:
        `min_publishers is ${s.minPublishers}, below the required ${s.requiredMinPublishers}. A ` +
        "single-publisher price becomes acceptable the moment the priced path is live.",
    });
  }
  // TWO CHECKS WERE REMOVED HERE, and saying why is the point.
  //
  // `oracleProbePassed` and `publicAppLive` were booleans set from environment variables
  // (DOMINION_ORACLE_PROBED, DOMINION_PUBLIC_APP_LIVE). They measured nothing: they proved that
  // somebody typed a string. A gate whose input is an assertion by the party being gated is
  // ceremony wearing the costume of a control, and it makes the remaining checks look weaker by
  // association.
  //
  // What survives is the measurable part of the same concern: `feedId` and `minPublishers` are read
  // off the config and compared to the manifest, so a wrong feed or a lowered publisher floor is
  // refused on evidence. The live feed probe stays where it belongs, as its own runbook step with
  // its own script (scripts/probe-lazer-feed.ts), and the public app deployment is verified by
  // looking at it.

  // Stated rather than checked: these two are TRUE on a correct deployment and a mismatch means the
  // config is not the one this ceremony believes it is.
  if (!s.publicMintEnabled || !s.redemptionsEnabled) {
    blockers.push({
      id: "posture-mismatch",
      why:
        `public_mint_enabled=${s.publicMintEnabled} redemptions_enabled=${s.redemptionsEnabled}, ` +
        "but the round 8 posture ships both OPEN from initialize. This config was produced by a " +
        "different program or has already been closed by an emergency action.",
    });
  }

  return { ready: blockers.length === 0, blockers, alreadyLive: !s.paused };
}
