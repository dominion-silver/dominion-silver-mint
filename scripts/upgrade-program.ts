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
 *      made the upgrade impossible: 1,185,784 bytes of binary against 1,100,936 allocated is an
 *      84,848-byte shortfall (recomputed at runtime; this number is prose and goes stale on every rebuild), and `solana program deploy` simply fails until it is closed.
 *   4. Snapshot the config BEFORE, so the after-comparison is against reality and not against a
 *      remembered value.
 *   5. Deploy.
 *   6. Verify the BYTES ON CHAIN match the local artifact. Not the CLI's exit code: the bytes.
 *   7. Verify the config survived, field by field, including the live proposal nonce.
 *
 * Usage:
 *   npx tsx scripts/upgrade-program.ts                      # devnet, dry run (default)
 *   DOMINION_INTENT=extend_program_data,deploy_program \\
 *     npx tsx scripts/upgrade-program.ts --execute
 *
 * (drop extend_program_data when the dry run reports no shortfall)
 *
 * `solana program extend` is IRREVERSIBLE: the rent for the added bytes is locked for as long as the
 * program exists, and there is no shrink. Hence the intent gate.
 */
import { PublicKey } from "@solana/web3.js";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
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

  await requireSanctionedCluster(CLUSTER.rpc, "in-place program upgrade");

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

  // REVIEW-OF-FIXES P2. The script confirmed only that an authority EXISTS, never that it is the key
  // `solana` will actually sign with: no --keypair is passed, so it silently inherits `solana config`.
  // An extend costs non-refundable rent; discovering the wrong signer AFTER paying it is the expensive
  // order to find out in.
  const signer = sh("solana", ["address"]).trim();
  console.log(`  signer        : ${signer}`);
  if (signer !== show.authority) {
    die(
      `the configured signer is NOT the upgrade authority.\n` +
        `  solana address : ${signer}\n` +
        `  on-chain auth  : ${show.authority}\n` +
        `Set the right keypair (solana config set --keypair ...) before running this. The extend that\n` +
        `follows costs rent that is never refunded, and a deploy signed by the wrong key fails after it.`,
    );
  }

  const shortfall = localLen - onChainLen;
  const needExtend = shortfall > 0;
  if (needExtend) {
    console.log(`  SHORTFALL     : ${shortfall.toLocaleString()} bytes. An extend is REQUIRED.`);
    console.log(`  will extend by: ${(shortfall + HEADROOM).toLocaleString()} bytes (shortfall + ${HEADROOM.toLocaleString()} headroom)`);
  } else {
    console.log(`  headroom      : ${(-shortfall).toLocaleString()} bytes. No extend needed.`);
  }

  // And the payer must be able to afford BOTH the extend rent and the deploy buffer, which briefly holds
  // the program's full rent. Running out mid-write leaves the locked rent plus an orphaned buffer.
  const balSol = Number(sh("solana", ["balance", "-u", CLUSTER.rpc]).trim().split(/\s+/)[0]);
  // ~0.007 SOL per KB of account data, doubled because the buffer coexists with the program.
  const needSol = ((Math.max(0, shortfall) + HEADROOM + localLen) / 1024) * 0.00696 + 0.5;
  console.log(`  balance       : ${balSol} SOL (need about ${needSol.toFixed(2)} for extend + buffer)`);
  if (balSol < needSol) {
    die(
      `insufficient balance: ${balSol} SOL, need roughly ${needSol.toFixed(2)}.\n` +
        `A deploy that runs out mid-write leaves the extend rent locked AND an orphaned buffer holding\n` +
        `the program's full rent. Fund the signer first.`,
    );
  }


  // ---- 4. snapshot BEFORE ----
  step("4", "config snapshot BEFORE the upgrade");
  const before = readConfig();
  // The raw bytes too, because the decoded snapshot cannot testify about the layout: see step 7b.
  const rawBefore = readConfigRaw();
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
    // ROUND 3 P2: `kycAttestationCount` was in neither list, so a layout error decoding it as 1 would have
    // authorised an empty-roster arm and the script would still have printed UPGRADE OK.
    "kycAttestationCount",
  ] as const;
  for (const k of WATCHED) console.log(`  ${k.padEnd(24)} = ${String(before[k])}`);

  if (!EXECUTE) {
    console.log(
      "\nDRY RUN complete. Nothing was sent. To perform it, re-run with --execute and\n" +
        `  DOMINION_INTENT=${needExtend ? "extend_program_data,deploy_program" : "deploy_program"}`,
    );
    console.log(
      needExtend
        ? `NOTE: the extend of ${(shortfall + HEADROOM).toLocaleString()} bytes is IRREVERSIBLE (rent is locked for the life of the program).`
        : "NOTE: no extend needed, so the only irreversible part is the new bytecode itself.",
    );
    return;
  }

  // RULE 2, with the honest action names. `assertReversible` matches the intent against the ACTION NAME,
  // so `DOMINION_INTENT=irreversible` (what this file used to document) was always refused and the
  // --execute path had never been exercised. Each step is gated by the intent it actually needs, so a
  // no-extend upgrade does not demand the extend token and a retry does not need a DIFFERENT token than
  // the first attempt, which was the worst part: the wrong string to have to guess mid-incident.
  const intent = intentFromEnv();
  if (needExtend) assertReversible("extend_program_data", intent);
  assertReversible("deploy_program", intent);

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
  try {
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
  } catch (e) {
    // REVIEW-OF-FIXES P2: a failed deploy of a 1.19 MB program over a public RPC is common, and it
    // leaves a buffer account holding the program's FULL rent (about 8 SOL). The script neither reused
    // nor mentioned it, so the operator's money sat in an account they did not know existed.
    console.error(`\ndeploy FAILED: ${String(e).slice(0, 400)}`);
    console.error(
      `\nRECLAIM YOUR RENT before retrying. A failed deploy leaves an orphaned buffer:\n` +
        `  solana program show --buffers -u ${CLUSTER.rpc}\n` +
        `  solana program close --buffers -u ${CLUSTER.rpc}\n` +
        `The ProgramData extend is NOT recoverable, but it persists, so a retry does not repeat it.`,
    );
    process.exit(1);
  }

  // ---- 6. the BYTES, not the exit code ----
  step("6", "verifying the bytes actually on chain");
  // mkdtemp, not a fixed /tmp path. REVIEW-OF-FIXES P2: `/tmp/dominion-onchain-verify.so` is predictable,
  // so on a shared or CI host a pre-planted symlink turns this into an arbitrary file write as the
  // operator, and the gap between the write and the hash is a TOCTOU on the MATCH verdict.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dominion-verify-"));
  const dump = path.join(tmpDir, "onchain.so");
  sh("solana", ["program", "dump", PROGRAM_ID.toBase58(), dump, "-u", CLUSTER.rpc]);
  const raw = fs.readFileSync(dump);
  // A dump is padded to the full allocation, so compare the first localLen bytes. But ASSERT the tail is
  // zero rather than assuming it: the claim being made is "the bytes on chain are the artifact", and
  // trimming without checking proves it only for a prefix.
  const tail = raw.subarray(localLen);
  const nonZero = tail.findIndex((b) => b !== 0);
  if (nonZero !== -1) {
    die(
      `the dumped program has NON-ZERO bytes past the artifact length (first at offset ` +
        `${localLen + nonZero}). The upgradeable loader zero-fills the remainder, so this should be ` +
        `impossible; investigate before trusting this program.`,
    );
  }
  const trimmed = path.join(tmpDir, "onchain-trim.so");
  fs.writeFileSync(trimmed, raw.subarray(0, localLen));
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
  // ---- 6b. republish the on-chain IDL ----
  step("6b", "publishing the new IDL on chain");
  let idlPublishFailed = false;
  // REVIEW-OF-FIXES P1: no upgrade path touched the on-chain IDL. Only `deploy-devnet.sh` ever published
  // one, and the runbook has no publish step, so after an in-place upgrade the PUBLISHED IDL still
  // described the previous program: `RedeemQueued` present, `set_kyc_scope` with two accounts. Any
  // integrator on the standard `Program.at(programId, provider)` path fetches THAT, builds `set_kyc_scope`
  // without the `kyc_operator` slot, and the chain rejects it. Both repo gates compare only the three
  // in-repo copies; neither reads the chain, so nothing could have noticed.
  try {
    console.log(
      sh("anchor", [
        "idl",
        "upgrade",
        PROGRAM_ID.toBase58(),
        "--filepath",
        path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
        "--provider.cluster",
        CLUSTER.rpc,
      ]),
    );
  } catch (e) {
    idlPublishFailed = true;
    // RE-AUDIT P2: this logged loudly and then fell through to `UPGRADE OK` and exit 0. Loud text does not
    // preserve failure semantics: a pasted ceremony result or any automation reads the exit code, and an
    // integrator on `Program.at()` fetching the OLD account list builds transactions the upgraded program
    // rejects. The bytecode really did land, so this is not a rollback, but it is not OK either.
    console.error(
      `\nIDL PUBLISH FAILED: ${String(e).slice(0, 300)}\n` +
        `The BYTECODE upgrade succeeded and is verified. The PUBLISHED IDL is now stale, so external\n` +
        `integrators using Program.at() will build the old account lists. Republish before announcing:\n` +
        `  anchor idl upgrade ${PROGRAM_ID.toBase58()} \\\n` +
        `    --filepath target/idl/dominion_silver_mint.json --provider.cluster ${CLUSTER.rpc}`,
    );
  }

  step("7b", "the config account survived byte-for-byte and the carved fields are coherent");
  // ROUND 3 P2: three of these four were merely PRINTED, so a layout error decoding `kycScopeFlags = 2`,
  // `instantUsedPrevUsdc = 10_000_000` or `kycAttestationCount = 1` produced no failure and the script
  // printed "carved fields correct". Printing is not checking.
  //
  // REVIEW-OF-FIXES, and this section has now been wrong twice in opposite directions. Both are recorded
  // because the second mistake was caused by fixing the first carelessly.
  //
  //   Round 3's version asserted the four read ZERO. Correct exactly once: the zero expectation comes from
  //   the fields being read out of bytes the PRE-carve binary left as `reserved`. The SECOND upgrade runs
  //   against an account where `kycScopeFlags` is legitimately 2 and the counter is legitimately 40, and it
  //   would have died on correct state.
  //
  //   My replacement asserted "unchanged across the upgrade, and inside its domain". Two faults. The domain
  //   predicate was `v === true || v === false` against a value read-config prints as the STRING "false",
  //   so it could never hold and step 7b called die() on every healthy upgrade, AFTER the deploy and the IDL
  //   republish. And "unchanged" was vacuous: both snapshots come from the same read-config run against the
  //   same in-repo IDL, decoding an account an in-place upgrade never touches, so it was structurally true.
  //
  // So neither the value nor a self-comparison of the decode is the evidence. Two things are:
  //
  //   1. THE RAW BYTES. An in-place bytecode upgrade must not modify the config account at all. Comparing
  //      the account data before and after is a real statement about the chain, not about our decoder, and
  //      it is the one that would catch an upgrade that migrated state it should not have.
  //   2. CROSS-FIELD INVARIANTS the program itself maintains. A wrong offset breaks the relationship
  //      between two fields even when each value looks plausible on its own. These are the checks that
  //      survive both the first upgrade and the fortieth.
  const rawAfter = readConfigRaw();
  if (!rawBefore || !rawAfter) {
    die(
      "could not read the config account's raw bytes on both sides of the upgrade, so the strongest " +
        "available check could not run. Do not proceed until a plain `getAccountInfo` works.",
    );
  }
  if (!rawBefore.equals(rawAfter)) {
    die(
      `THE CONFIG ACCOUNT'S BYTES CHANGED ACROSS THE UPGRADE (${rawBefore.length} -> ${rawAfter.length} ` +
        `bytes). An in-place bytecode upgrade must not touch account state. Something migrated or ` +
        `corrupted the config. Do not use this program.`,
    );
  }
  console.log(`  ok   config account bytes identical across the upgrade (${rawAfter.length} bytes)`);

  const g = (k: string) => String(afterCfg[k]);
  const num = (k: string) => {
    const n = Number(g(k));
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : NaN;
  };
  const scope = g("kycScopeFlags");
  const problems: string[] = [];
  // A bool that is neither: Anchor would normally refuse to decode it, so this is the belt to step 7's braces.
  if (g("feeRoutingDisabled") !== "true" && g("feeRoutingDisabled") !== "false") {
    problems.push(`feeRoutingDisabled decoded as ${g("feeRoutingDisabled")}, which is not a bool`);
  }
  // Side bits: 1 = mint, 2 = redeem, 3 = both.
  if (!["0", "1", "2", "3"].includes(scope)) {
    problems.push(`kycScopeFlags = ${scope}, outside the side-bit set {0,1,2,3}`);
  }
  // THE DERIVED-SIGNAL INVARIANT, and the strongest single line here. `kyc_enforced` is written only as
  // `flags != 0`, never independently, so external readers are promised the two cannot disagree
  // (state/config.rs). A shift that moves one field and not the other breaks this while both values still
  // look individually plausible.
  const enforced = g("kycEnforced");
  if (enforced !== String(scope !== "0")) {
    problems.push(
      `kycEnforced = ${enforced} but kycScopeFlags = ${scope}. These are written together and cannot ` +
        `legitimately disagree, so one of them is being read from the wrong offset.`,
    );
  }
  // THE C-02 INVARIANT: an armed gate always has somebody behind it.
  const count = num("kycAttestationCount");
  if (Number.isNaN(count)) problems.push(`kycAttestationCount = ${g("kycAttestationCount")} is not a count`);
  else if (scope !== "0" && count === 0) {
    problems.push(
      `kycScopeFlags = ${scope} with kycAttestationCount = 0. The program refuses to reach that state, ` +
        `so reading it back means the decode is wrong.`,
    );
  }
  const used = num("instantUsedPrevUsdc");
  if (Number.isNaN(used)) problems.push(`instantUsedPrevUsdc = ${g("instantUsedPrevUsdc")} is not an amount`);
  for (const k of ["feeRoutingDisabled", "kycScopeFlags", "instantUsedPrevUsdc", "kycAttestationCount"]) {
    console.log(`  ${" ".repeat(4)} ${k.padEnd(24)} = ${g(k)}`);
  }
  if (problems.length > 0) {
    for (const pr of problems) console.error(`  BAD  ${pr}`);
    die(
      `${problems.length} carved-field invariant(s) broken. That is a LAYOUT error, not a config ` +
        `difference: the fields carved from \`reserved\` are being read from the wrong offsets. ` +
        `Do not use this program.`,
    );
  }
  const allZero = g("feeRoutingDisabled") === "false" && scope === "0" && used === 0 && count === 0;
  console.log(
    allZero
      ? "  all four read zero: expected on the FIRST in-place upgrade over a pre-carve account."
      : "  some are non-zero: expected on any LATER upgrade, since these are live fields by then. " +
        "Confirm the values above are the ones you left behind.",
  );

  if (drift > 0) {
    die(`${drift} watched config field(s) changed across the upgrade. Investigate before using it.`);
  }
  if (idlPublishFailed) {
    console.error(
      "\nUPGRADE INCOMPLETE: the bytecode is deployed and byte-verified and the config is preserved,\n" +
        "but the ON-CHAIN IDL IS STALE. External integrators using Program.at() will build the previous\n" +
        "account lists and be rejected. Republish, then re-run this script to confirm.",
    );
    process.exit(3); // distinct from 1 (verification failed) so automation can tell them apart
  }
  console.log("\nUPGRADE OK: bytes verified on chain, config preserved, carved fields correct.");
}

/** Read the config through the same helper the admin app uses, so a decode difference here is a real
 *  decode difference and not a second implementation of the layout. */
/**
 * The config account as read-config.ts prints it: EVERY VALUE IS A STRING.
 *
 * REVIEW-OF-FIXES P0. This was typed `Record<string, unknown>`, and I then wrote a check
 * (`v === true || v === false`) that can never hold against a string. Because it can never hold, step 7b
 * called `die()` on every CORRECT upgrade, after the bytecode had already landed and the IDL had already
 * been republished. Reviewer measured it against the live devnet config: `"feeRoutingDisabled": "false"`.
 *
 * The type says string now, so the compiler refuses the next person's `=== true`.
 */
/** The config account's raw data, or null. The evidence step 7b actually relies on. */
function readConfigRaw(): Buffer | null {
  try {
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
    const out = sh("solana", [
      "account",
      configPda.toBase58(),
      "-u",
      CLUSTER.rpc,
      "--output",
      "json",
    ]);
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    const b64 = parsed?.account?.data?.[0];
    if (typeof b64 !== "string") return null;
    return Buffer.from(b64, "base64");
  } catch (e) {
    console.error(`  (raw config read failed: ${String(e).slice(0, 200)})`);
    return null;
  }
}

function readConfig(): Record<string, string> | null {
  try {
    const out = sh("npx", ["tsx", path.join(__dirname, "read-config.ts")]);
    const json = out.slice(out.indexOf("{"));
    return JSON.parse(json) as Record<string, string>;
  } catch (e) {
    console.error(`  (read-config failed: ${String(e).slice(0, 200)})`);
    return null;
  }
}

main().catch((e) => {
  console.error("upgrade failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});