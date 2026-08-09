/**
 * ROUND 8 L1-04. Every refusal that must stand between a deployed program and a live one.
 *
 * The posture change made the unpause the go-live, so all of these have to hold at ONE moment. This
 * drives `decideLaunchReadiness`, the function `ceremony-step8.ts` itself calls, one blocker at a
 * time from a state that is otherwise ready: a test that flipped several fields at once would pass
 * while checking nothing, because any single blocker satisfies "not ready".
 *
 * The last case is the one that matters most and is easiest to forget: the READY state must actually
 * be ready. A decision function that refuses everything scores perfectly on the refusals.
 *
 *   npx tsx scripts/test-launch-open-readiness.ts
 */
import { PublicKey } from "@solana/web3.js";
import { decideLaunchReadiness, type LaunchState } from "./_launch-readiness";

let failures = 0;
const ok = (m: string) => console.log(`ok: ${m}`);
const bad = (m: string) => {
  console.log(`FAIL: ${m}`);
  failures += 1;
};

const INVENTORY = PublicKey.unique();

/** A state in which the unpause is legitimate. Every case below breaks exactly one thing in it. */
function ready(): LaunchState {
  return {
    paused: true,
    publicMintEnabled: true,
    redemptionsEnabled: true,
    boundInventoryWallet: INVENTORY,
    expectedInventoryWallet: INVENTORY,
    feeVaultExists: true,
    circulatingSilv: 0n,
    activeIndependentGuardians: 1,
    minPublishers: 2,
    requiredMinPublishers: 2,
    feedId: 3154,
    expectedFeedId: 3154,
  };
}

/** Break one field and assert the decision refuses, naming that exact blocker. */
function refuses(label: string, id: string, mutate: (s: LaunchState) => void): void {
  const s = ready();
  mutate(s);
  const d = decideLaunchReadiness(s);
  if (d.ready) {
    bad(`${label} was accepted as ready`);
    return;
  }
  if (!d.blockers.some((b) => b.id === id)) {
    bad(`${label} refused, but not with '${id}' (got ${d.blockers.map((b) => b.id).join(", ")})`);
    return;
  }
  // Exactly one, so a case cannot pass on the back of an unrelated blocker it also triggered.
  if (d.blockers.length !== 1) {
    bad(`${label} produced ${d.blockers.length} blockers, so it is not an isolated case`);
    return;
  }
  ok(label);
}

function main(): void {
  // The positive control FIRST: everything below is meaningless if this fails.
  const base = decideLaunchReadiness(ready());
  if (!base.ready) {
    bad(
      `the ready state is refused (${base.blockers.map((b) => b.id).join(", ")}), so every refusal ` +
        "below would pass for the wrong reason",
    );
  } else {
    ok("a fully prepared deployment is accepted for go-live");
  }

  refuses(
    "the ceremony refuses to go live without the premium fee vault",
    "fee-vault-missing",
    (s) => {
      s.feeVaultExists = false;
    },
  );
  refuses(
    "the ceremony refuses to go live with SILV already in circulation",
    "supply-already-circulating",
    (s) => {
      s.circulatingSilv = 1n;
    },
  );
  refuses(
    "the ceremony refuses an inventory wallet that is not the manifest's",
    "inventory-wallet-mismatch",
    (s) => {
      s.boundInventoryWallet = PublicKey.unique();
    },
  );
  refuses(
    "the ceremony refuses to go live with no active guardian distinct from the admin",
    "no-independent-guardian",
    (s) => {
      s.activeIndependentGuardians = 0;
    },
  );
  refuses("the ceremony refuses a feed the manifest does not name", "wrong-feed", (s) => {
    s.feedId = 3304;
  });
  refuses(
    "the ceremony refuses a publisher floor below the launch requirement",
    "publisher-floor-too-low",
    (s) => {
      s.minPublishers = 1;
    },
  );
  refuses(
    "the ceremony refuses a config whose switches are not the round 8 posture",
    "posture-mismatch",
    (s) => {
      s.redemptionsEnabled = false;
    },
  );

  // An ALREADY LIVE protocol is reported as such rather than re-gated: a re-run of the verification
  // must not read as a go-live refusal.
  const live = ready();
  live.paused = false;
  if (!decideLaunchReadiness(live).alreadyLive) {
    bad("an already-unpaused protocol was not reported as live");
  } else {
    ok("an already-unpaused protocol is reported as live, not re-gated");
  }

  if (failures > 0) {
    console.log(`\nLAUNCH-OPEN READINESS TEST FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log("\nLAUNCH-OPEN READINESS TEST OK");
}

main();
