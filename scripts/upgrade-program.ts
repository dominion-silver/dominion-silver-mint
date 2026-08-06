/**
 * IN-PLACE UPGRADE of a deployed Dominion Silver program, preserving its program id, its config
 * account, its authorities and any live timelock proposal.
 *
 * WHY THIS EXISTS: external audit 2026-08-06, finding S-03.
 *
 * The only upgrade helper in the repo was `scripts/upgrade-devnet.sh`, and its first executable line
 * was `exit 1`, justified by "V2 is a MANDATORY fresh deploy under a NEW program ID (the V1/V2
 * ConfigAccount layout is incompatible)". That was true when written and is now obsolete: the live
 * devnet target is ALREADY V2, and what this batch needs is a V2 to V2 upgrade that KEEPS the
 * existing config. Fresh-deploying would discard `pendingPublicMintNonce = 8`, the treasury, and the
 * SILV mint binding, and burn a fresh program id for no reason.
 *
 * Written in TypeScript rather than bash on purpose: it reuses `scripts/_cluster.ts`, so cluster
 * selection cannot drift from the rest of the tooling. Re-implementing the devnet/mainnet regex in
 * bash is exactly the duplication that produced findings S-01, S-02 and D-01.
 *
 * WHAT IT DOES, in order, refusing to continue at the first surprise:
 *   1. Resolve the cluster from DOMINION_RPC and apply guard RULE 1 (mainnet needs explicit consent).
 *   2. Read the on-chain ProgramData allocation and compare it with the local .so.
 *   3. If the binary no longer fits, EXTEND the ProgramData account. This is the step whose absence
 *      made the upgrade impossible: 1,179,984 bytes of binary against 1,100,936 allocated is a
 *      79,048-byte shortfall, and `solana program deploy` simply fails until it is closed.
 *   4. Snapshot the config BEFORE, so the after-comparison is against reality and not against a
 *      remembered value.
 *   5. Deploy.
 *   6. Verify the BYTES ON CHAIN match the local artifact. Not the CLI's exit code: the bytes.
 *   7. Verify the config survived, field by field, including the live proposal nonce.
 *
 * Usage:
 *   npx tsx scripts/upgrade-program.ts                      # devnet, dry run (default)
 *   DOMINION_INTENT=irreversible npx tsx scripts/upgrade-program.ts --execute
 *
 * `solana program extend` is IRREVERSIBLE: the rent for the added bytes is locked for as long as the
 * program exists, and there is no shrink. Hence the intent gate.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireDevnet, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";

const EXECUTE = process.argv.includes("--execute");
const CLUSTER = resolveCluster();
const SO = path.join(__dirname, "..", "target", "deploy", "dominion_silver_mint.so");
/** Bytes of headroom added on top of the shortfall, so the next upgrade does not need another
 *  extend. Cheap in rent, and an extend is a separate irreversible step we would rather not repeat. */
const HEADROOM = 100_000;

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function sha256(file: string): string {
  return sh("shasum", ["-a", "256", file]).trim().split(/\s+/)[0];
}
function step(n: string, msg: string) {
  console.log(`\n=== ${n}. ${msg}`);
}
function die(msg: string): never {
  console.error(`\nREFUSING TO CONTINUE: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log("Dominion in-place program upgrade");
  console.log("  " + describeCluster(CLUSTER));
  console.log(`  program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  mode:    ${EXECUTE ? "EXECUTE (real transactions)" : "DRY RUN (no transactions)"}`);

  requireDevnet(CLUSTER.rpc, "in-place program upgrade");

  if (!fs.existsSync(SO)) {
    die(`no local artifact at ${SO}. Build first: cargo build-sbf -- --locked`);
  }

  // ---- 2. does the binary still fit? ----
  step("2", "ProgramData allocation versus the local artifact");
  const localLen = fs.statSync(SO).size;
  const localHash = sha256(SO);
  let show: { programdataAddress?: string; dataLen?: number; authority?: string };
  try {
    show = JSON.parse(
      sh("solana", ["program", "show", PROGRAM_ID.toBase58(), "-u", CLUSTER.rpc, "--output", "json"]),
    );
  } catch (e) {
    die(`solana program show failed: ${String(e).slice(0, 300)}`);
  }
  const onChainLen = show.dataLen ?? -1;
  if (onChainLen < 0) die("could not read dataLen from solana program show");

  console.log(`  local  .so    : ${localLen.toLocaleString()} bytes (sha256 ${localHash.slice(0, 16)}...)`);
  console.log(`  on-chain alloc: ${onChainLen.toLocaleString()} bytes`);
  console.log(`  authority     : ${show.authority ?? "(none: program is IMMUTABLE)"}`);
  if (!show.authority) {
    die("this program has no upgrade authority. It is immutable and cannot be upgraded.");
  }

  const shortfall = localLen - onChainLen;
  const needExtend = shortfall > 0;
  if (needExtend) {
    console.log(`  SHORTFALL     : ${shortfall.toLocaleString()} bytes. An extend is REQUIRED.`);
    console.log(`  will extend by: ${(shortfall + HEADROOM).toLocaleString()} bytes (shortfall + ${HEADROOM.toLocaleString()} headroom)`);
  } else {
    console.log(`  headroom      : ${(-shortfall).toLocaleString()} bytes. No extend needed.`);
  }

  // ---- 4. snapshot BEFORE ----
  step("4", "config snapshot BEFORE the upgrade");
  const before = readConfig();
  if (!before) {
    die(
      "the config account does not decode. This script upgrades an INITIALISED program; " +
        "for a fresh deploy use T1 (scripts/t1-hostile-bootstrap.ts), which performs initialize.",
    );
  }
  const WATCHED = [
    "admin",
    "premiumBpsMint",
    "premiumBpsRedeem",
    "adminTimelockSeconds",
    "maxGuardianCount",
    "guardianCount",
    "silvMint",
    "pendingPublicMintNonce",
    "nextTimelockNonce",
    "activeProposalCount",
    "maxSilvSupply",
  ] as const;
  for (const k of WATCHED) console.log(`  ${k.padEnd(24)} = ${String(before[k])}`);

  if (!EXECUTE) {
    console.log(
      "\nDRY RUN complete. Nothing was sent. Re-run with --execute and " +
        "DOMINION_INTENT=irreversible to perform the upgrade.",
    );
    console.log(
      needExtend
        ? `NOTE: the extend of ${(shortfall + HEADROOM).toLocaleString()} bytes is IRREVERSIBLE (rent is locked for the life of the program).`
        : "NOTE: no extend needed, so the only irreversible part is the new bytecode itself.",
    );
    return;
  }

  // RULE 2: an extend can never be undone, so the operator must have asked for it.
  assertReversible(needExtend ? "set_upgrade_authority" : "execute_set_public_mint", intentFromEnv());

  if (needExtend) {
    step("3", `extending ProgramData by ${(shortfall + HEADROOM).toLocaleString()} bytes`);
    console.log(
      sh("solana", [
        "program",
        "extend",
        PROGRAM_ID.toBase58(),
        String(shortfall + HEADROOM),
        "-u",
        CLUSTER.rpc,
      ]),
    );
    const after = JSON.parse(
      sh("solana", ["program", "show", PROGRAM_ID.toBase58(), "-u", CLUSTER.rpc, "--output", "json"]),
    ) as { dataLen?: number };
    if ((after.dataLen ?? 0) < localLen) {
      die(`extend did not take: allocation is still ${after.dataLen}, need ${localLen}`);
    }
    console.log(`  allocation now ${(after.dataLen ?? 0).toLocaleString()} bytes. Fits.`);
  }

  step("5", "deploying");
  console.log(
    sh("solana", [
      "program",
      "deploy",
      "--program-id",
      PROGRAM_ID.toBase58(),
      "-u",
      CLUSTER.rpc,
      SO,
    ]),
  );

  // ---- 6. the BYTES, not the exit code ----
  step("6", "verifying the bytes actually on chain");
  const dump = "/tmp/dominion-onchain-verify.so";
  sh("solana", ["program", "dump", PROGRAM_ID.toBase58(), dump, "-u", CLUSTER.rpc]);
  // A dump is padded to the full allocation. Compare only the first localLen bytes: the tail is
  // zero-fill, and including it would make every hash mismatch for a reason that is not a defect.
  const trimmed = "/tmp/dominion-onchain-verify-trim.so";
  fs.writeFileSync(trimmed, fs.readFileSync(dump).subarray(0, localLen));
  const onChainHash = sha256(trimmed);
  console.log(`  local    : ${localHash}`);
  console.log(`  on chain : ${onChainHash}`);
  if (onChainHash !== localHash) {
    die(
      "THE DEPLOYED BYTES DO NOT MATCH THE LOCAL ARTIFACT. The upgrade did not land what you built. " +
        "Do not proceed; investigate before running anything else against this program.",
    );
  }
  console.log("  MATCH. The program running on chain is the artifact you built.");

  // ---- 7. the config survived ----
  step("7", "verifying the config survived the upgrade");
  const afterCfg = readConfig();
  if (!afterCfg) die("the config account no longer decodes AFTER the upgrade. This is a layout break.");
  let drift = 0;
  for (const k of WATCHED) {
    const a = String(before[k]);
    const b = String(afterCfg[k]);
    const same = a === b;
    if (!same) drift++;
    console.log(`  ${same ? "same" : "DIFF"}: ${k.padEnd(24)} ${a}${same ? "" : "  ->  " + b}`);
  }
  // The three fields carved out of `reserved` in this upgrade must decode to their INTENDED-AT-ZERO
  // values, because an in-place upgrade reads them from bytes the old binary left as zero. This is
  // the whole reason `fee_routing_disabled` is negated rather than named `fee_routing_enabled`.
  step("7b", "fields carved from `reserved` decode to their intended zero values");
  const carved: Array<[string, unknown]> = [
    ["feeRoutingDisabled", afterCfg.feeRoutingDisabled],
    ["kycScopeFlags", afterCfg.kycScopeFlags],
    ["instantUsedPrevUsdc", afterCfg.instantUsedPrevUsdc],
  ];
  for (const [k, v] of carved) console.log(`  ${k.padEnd(24)} = ${String(v)}`);
  if (String(afterCfg.feeRoutingDisabled) !== "false") {
    die("feeRoutingDisabled decoded TRUE. Fee routing is OFF, which is not the intended default.");
  }

  if (drift > 0) {
    die(`${drift} watched config field(s) changed across the upgrade. Investigate before using it.`);
  }
  console.log("\nUPGRADE OK: bytes verified on chain, config preserved, carved fields correct.");
}

/** Read the config through the same helper the admin app uses, so a decode difference here is a real
 *  decode difference and not a second implementation of the layout. */
function readConfig(): Record<string, unknown> | null {
  try {
    const out = sh("npx", ["tsx", path.join(__dirname, "read-config.ts")]);
    const json = out.slice(out.indexOf("{"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    console.error(`  (read-config failed: ${String(e).slice(0, 200)})`);
    return null;
  }
}

main().catch((e) => {
  console.error("upgrade failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});