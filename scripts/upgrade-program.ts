/**
 * IN-PLACE UPGRADE: same program id, config account, authorities and live timelock proposal, because a
 * fresh deploy would discard the config and burn a new id. The cluster comes from scripts/_cluster.ts,
 * so it cannot drift from the rest of the tooling.
 *
 * Guard the cluster, compare the ProgramData allocation against the local .so, EXTEND if the binary no
 * longer fits, snapshot the config, deploy, verify the BYTES on chain and not the CLI exit code,
 * republish the IDL, verify the config survived. `solana program extend` is IRREVERSIBLE (rent for the
 * added bytes is locked for the program's life, no shrink), hence the intent gate:
 *   npx tsx scripts/upgrade-program.ts                       # devnet, dry run, the default
 *   DOMINION_INTENT=deploy_program[,extend_program_data] npx tsx scripts/upgrade-program.ts --execute
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

  // An authority EXISTING is not enough: no --keypair is passed, so `solana` signs with whatever
  // `solana config` holds. Confirm it IS the authority before the extend, whose rent is never refunded.
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

  // The payer must afford BOTH the extend rent and the deploy buffer, which briefly holds the program's
  // full rent. Running out mid-write leaves the locked rent plus an orphaned buffer.
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

  // RULE 2. `assertReversible` matches the intent against the ACTION NAME, not against the cost, so the
  // tokens are the action names below. Each step is gated by the intent it actually needs: a no-extend
  // upgrade must not demand the extend token, and a retry must not need a different token than attempt 1.
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
    // A failed deploy of a 1.19 MB program over a public RPC is common, and it leaves a buffer account
    // holding the program's FULL rent (about 8 SOL). Say so, or the operator never learns it exists.
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
  // mkdtemp, never a fixed /tmp path: a predictable name is a pre-planted-symlink write as the operator
  // on a shared or CI host, and the gap between write and hash is a TOCTOU on the MATCH verdict.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dominion-verify-"));
  const dump = path.join(tmpDir, "onchain.so");
  sh("solana", ["program", "dump", PROGRAM_ID.toBase58(), dump, "-u", CLUSTER.rpc]);
  const raw = fs.readFileSync(dump);
  // A dump is padded to the full allocation, so compare the first localLen bytes. ASSERT the tail is zero
  // rather than assuming it: trimming unchecked proves the artifact claim only for a prefix.
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
  // ---- 6b. republish the on-chain IDL ----
  step("6b", "publishing the new IDL on chain");
  let idlPublishFailed = false;
  // An in-place upgrade does NOT touch the published IDL. Integrators on `Program.at(programId, provider)`
  // fetch that copy, so a stale one has them building account lists the new program rejects. No repo gate
  // can catch this: they all compare the three in-repo copies and none reads the chain.
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
        // Without this, anchor falls back to ~/.config/solana/id.json regardless of `solana config`,
        // and the publish dies on "Unable to read keypair file" AFTER the bytecode has landed.
        "--provider.wallet",
        keypairPath(),
      ]),
    );
  } catch (e) {
    idlPublishFailed = true;
    // Recorded, not swallowed: this must reach the exit code at the bottom. Loud text alone does not
    // preserve failure semantics, because automation and pasted ceremony results read the exit code.
    console.error(
      `\nIDL PUBLISH FAILED: ${String(e).slice(0, 300)}\n` +
        `The BYTECODE upgrade succeeded and is verified. The PUBLISHED IDL is now stale, so external\n` +
        `integrators using Program.at() will build the old account lists. Republish before announcing:\n` +
        `  anchor idl upgrade ${PROGRAM_ID.toBase58()} \\\n` +
        `    --filepath target/idl/dominion_silver_mint.json --provider.cluster ${CLUSTER.rpc}`,
    );
  }

  step("7b", "the config account survived byte-for-byte and the carved fields are coherent");
  // The evidence is the RAW BYTES being identical across the upgrade (a statement about the chain, not our
  // decoder) plus the program's own cross-field invariants, which a wrong offset breaks even when each
  // value still looks plausible. Do NOT restore a check that the carved fields read ZERO: that holds only
  // on the FIRST upgrade over a pre-carve account. Two decodes of one untouched account prove nothing.
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
  // Carved out of `reserved`, hence negated rather than named `fee_routing_enabled`: the zero byte the
  // pre-carve binary left means routing is ON. Anchor would normally refuse a bool that is neither, so
  // this is belt to step 7's braces.
  if (g("feeRoutingDisabled") !== "true" && g("feeRoutingDisabled") !== "false") {
    problems.push(`feeRoutingDisabled decoded as ${g("feeRoutingDisabled")}, which is not a bool`);
  }
  // Side bits: 1 = mint, 2 = redeem, 3 = both.
  if (!["0", "1", "2", "3"].includes(scope)) {
    problems.push(`kycScopeFlags = ${scope}, outside the side-bit set {0,1,2,3}`);
  }
  // THE DERIVED-SIGNAL INVARIANT, the strongest check here. `kyc_enforced` is written only as `flags != 0`,
  // never independently (state/config.rs), so the two cannot legitimately disagree.
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

/** The keypair the solana CLI is configured to use, which is not always anchor's default. */
function keypairPath(): string {
  try {
    const out = sh("solana", ["config", "get"]);
    const m = out.match(/Keypair Path:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

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

/** The config as read-config.ts prints it: EVERY VALUE IS A STRING, so a `=== true` test can never hold
 *  and the return type is typed string to make the compiler say so. Read through the same helper the admin
 *  app uses, so a decode difference here is a real one and not a second implementation of the layout. */
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