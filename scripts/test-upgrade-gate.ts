/**
 * ROUND 6 R6-02. The matrix the audit asked for:
 * {devnet, mainnet-beta} x {no-candidate, pinned} x {matching artifact, mismatched artifact}.
 *
 * THE DEFECT THIS PINS. `refuseMainnetDirectUpgrade()` decided on the CURVE of the observed upgrade
 * authority instead of the cluster, and returned quietly whenever that authority was on-curve. On
 * mainnet the authority IS on-curve for the whole window between the first deploy and step 12, which
 * is the most sensitive window of the launch. Beside it, `assertArtifactIsAttested()` announced that a
 * `no-candidate` artifact was "Fine for devnet" and returned without ever checking the cluster. So
 * `--execute` with the right intents and the deployer key could push any locally built `.so` to
 * mainnet, unpinned, while the file's own comment claimed it was "explicitly a DEVNET tool".
 *
 * The authority shape is deliberately NOT a dimension of this matrix: after the fix it is not an input
 * to the decision at all. That is the fix. A test that still varied it would be testing the old shape.
 *
 * Read-only, sends nothing, needs no network and no keypair.
 *
 * Run: npx tsx scripts/test-upgrade-gate.ts
 */
import { decideUpgradeGate } from "./upgrade-program";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BYTES = 1_199_688;

let pass = 0;
let fail = 0;

/**
 * `expectAllowed` is a claim about the WHOLE decision, not about one branch: a refusal reason is
 * returned, never thrown, so a case that refuses for the "right" reason in the wrong situation still
 * shows up here as a difference.
 */
function check(label: string, reason: string | null, shouldRefuse: boolean, mustMention?: string) {
  const refused = reason !== null;
  let ok = refused === shouldRefuse;
  if (ok && refused && mustMention && !reason!.includes(mustMention)) ok = false;
  if (ok) {
    console.log(`  ok    ${label} -> ${refused ? "REFUSED" : "allowed"}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected ${shouldRefuse ? "REFUSED" : "allowed"}, got ${refused ? "REFUSED" : "allowed"}`);
    if (refused) console.log(`        reason: ${reason!.split("\n")[0]}`);
    if (mustMention) console.log(`        reason had to mention: ${mustMention}`);
    fail++;
  }
}

console.log("Upgrade gate matrix: cluster x pin status x artifact match\n");

// ---------------------------------------------------------------- devnet
// Devnet is where a candidate is exercised BEFORE it is a candidate, so every combination is allowed.
// If this half ever starts refusing, the devnet rehearsal becomes impossible and the pressure will be
// to weaken the mainnet half instead.
for (const cluster of ["devnet", "localnet"]) {
  check(
    `${cluster} + no-candidate`,
    decideUpgradeGate({ cluster, status: "no-candidate", localHash: HASH_A, localBytes: BYTES, pinnedHash: null, pinnedBytes: null }),
    false,
  );
  check(
    `${cluster} + pinned + artifact MISMATCH`,
    decideUpgradeGate({ cluster, status: "pinned", localHash: HASH_A, localBytes: BYTES, pinnedHash: HASH_B, pinnedBytes: BYTES }),
    false,
  );
}

// ---------------------------------------------------------------- mainnet
// THE HALF THAT MATTERS. Every state but "pinned and byte-for-byte identical" must refuse.
check(
  "mainnet + no-candidate",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "no-candidate", localHash: HASH_A, localBytes: BYTES, pinnedHash: null, pinnedBytes: null }),
  true,
  "MAINNET requires a pinned release candidate",
);
check(
  "mainnet + MISSING status",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "MISSING", localHash: HASH_A, localBytes: BYTES, pinnedHash: null, pinnedBytes: null }),
  true,
  "MAINNET requires a pinned release candidate",
);
check(
  "mainnet + a status nobody defined",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "almost-pinned", localHash: HASH_A, localBytes: BYTES, pinnedHash: HASH_A, pinnedBytes: BYTES }),
  true,
  "MAINNET requires a pinned release candidate",
);
check(
  "mainnet + pinned + WRONG hash",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "pinned", localHash: HASH_A, localBytes: BYTES, pinnedHash: HASH_B, pinnedBytes: BYTES }),
  true,
  "NOT the pinned release binary",
);
check(
  "mainnet + pinned + right hash, WRONG size",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "pinned", localHash: HASH_A, localBytes: BYTES, pinnedHash: HASH_A, pinnedBytes: BYTES + 1 }),
  true,
  "NOT the pinned release binary",
);
check(
  "mainnet + pinned + null pin fields",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "pinned", localHash: HASH_A, localBytes: BYTES, pinnedHash: null, pinnedBytes: null }),
  true,
  "NOT the pinned release binary",
);
// The ONE allowed mainnet case, so every refusal above means something.
check(
  "mainnet + pinned + exact match",
  decideUpgradeGate({ cluster: "mainnet-beta", status: "pinned", localHash: HASH_A, localBytes: BYTES, pinnedHash: HASH_A, pinnedBytes: BYTES }),
  false,
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.error("The upgrade gate does not hold. A mainnet upgrade could run on an unpinned artifact.");
  process.exit(1);
}
console.log("UPGRADE GATE OK: mainnet refuses every state but a pinned, byte-identical artifact.");
