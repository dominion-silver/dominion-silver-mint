/**
 * GATE: cluster selection is driven by the ENVIRONMENT and never falls back to devnet (audit S-01).
 *
 * ASSERTS the properties, not the implementation: an unset DOMINION_RPC still resolves to devnet; an
 * explicit OR UNRECOGNISED mainnet RPC resolves to mainnet-beta and to mainnet ADDRESSES, never the
 * devnet USDC mint; a URL merely containing "devnet" is classified by HOST; the transaction guard
 * agrees with the classifier; every script in scripts/ is classified and every sender calls the
 * guard; a missing mainnet constant THROWS. Run: npx tsx scripts/verify-cluster-resolution.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { resolveCluster,
  readMainnetConfigFrom,
  mainnetAddressFrom,
  mainnetConfig,
} from "./_cluster";
import { guardConsentOnly } from "./_guard";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOT = path.join(__dirname, "..", "config", "mainnet-authorities.json");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}

function withRpc<T>(rpc: string | undefined, fn: () => T): T {
  const prev = process.env.DOMINION_RPC;
  if (rpc === undefined) delete process.env.DOMINION_RPC;
  else process.env.DOMINION_RPC = rpc;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DOMINION_RPC;
    else process.env.DOMINION_RPC = prev;
  }
}

console.log("Cluster resolution gate (audit S-01)\n");

// 1. default stays devnet
withRpc(undefined, () => {
  const c = resolveCluster();
  ok("unset DOMINION_RPC resolves to devnet", c.cluster === "devnet", c.cluster);
  ok("and to the devnet USDC mint", c.usdcMint.toBase58() === DEVNET_USDC);
});

// 2. explicit mainnet resolves to mainnet ADDRESSES, not just a mainnet label
withRpc("https://api.mainnet-beta.solana.com", () => {
  const c = resolveCluster();
  ok("explicit mainnet RPC resolves to mainnet-beta", c.cluster === "mainnet-beta", c.cluster);
  ok(
    "mainnet does NOT return the devnet USDC mint",
    c.usdcMint.toBase58() !== DEVNET_USDC,
    c.usdcMint.toBase58(),
  );
  ok(
    "mainnet lazer treasury differs from devnet's",
    c.lazerTreasury.toBase58() !== "opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7",
    c.lazerTreasury.toBase58(),
  );
});

// 2b. A MAINNET host whose URL merely CONTAINS "devnet" (query parameter, path segment, six bytes of an
//     API key) must classify as mainnet. Testing /devnet/i against the whole URL made `requireDevnet`
//     return early, so DOMINION_ALLOW_MAINNET never fired and --execute would deploy on MAINNET.
for (const rpc of [
  "https://api.mainnet-beta.solana.com/?tag=devnet-mirror",
  "https://mainnet.helius-rpc.com/?api-key=7fdevnet91-aaaa",
  "https://rpc.internal/devnet-proxy-to-mainnet",
  "https://api.mainnet-beta.solana.com/devnet",
  "https://devnet-mirror.mainnet.example.com",
]) {
  withRpc(rpc, () => {
    const c = resolveCluster();
    ok(
      `"devnet" inside a mainnet URL does NOT make it devnet: ${rpc.slice(8, 52)}`,
      c.cluster === "mainnet-beta",
      c.cluster,
    );
    ok(
      `  and it does not hand back the devnet USDC mint`,
      c.usdcMint.toBase58() !== DEVNET_USDC,
    );
  });
}

// 2c. A genuine devnet HOST must still be devnet, so the fix is not a blanket "everything is mainnet".
for (const rpc of [
  "https://api.devnet.solana.com",
  "https://devnet.helius-rpc.com/?api-key=x",
  "https://api.devnet.solana.com/?api-key=mainnet-looking-key",
]) {
  withRpc(rpc, () => {
    ok(`a real devnet host stays devnet: ${rpc.slice(8, 48)}`, resolveCluster().cluster === "devnet");
  });
}

// 2d. The guard that gates transactions must agree with the classifier: two implementations of
//     "is this devnet" was the defect, and the regex was only the symptom.
for (const [rpc, shouldNeedConsent] of [
  ["https://api.devnet.solana.com", false],
  ["http://127.0.0.1:8899", false], // localnet is the mandated rehearsal cluster
  ["https://api.mainnet-beta.solana.com", true],
  ["https://api.mainnet-beta.solana.com/?tag=devnet-mirror", true],
] as const) {
  const prev = process.env.DOMINION_ALLOW_MAINNET;
  delete process.env.DOMINION_ALLOW_MAINNET;
  let refused = false;
  try {
    // Only the CONSENT half: the full guard reaches the network for the genesis check.
    guardConsentOnly(rpc);
  } catch {
    refused = true;
  }
  if (prev !== undefined) process.env.DOMINION_ALLOW_MAINNET = prev;
  ok(
    `consent ${shouldNeedConsent ? "DEMANDED" : "not demanded"} for ${rpc.slice(0, 46)}`,
    refused === shouldNeedConsent,
    `refused=${refused}`,
  );
}

// 3. an unrecognised host must NOT be treated as devnet
for (const rpc of [
  "https://mainnet.helius-rpc.com/?api-key=x",
  "https://dominion.rpcpool.com",
  "https://example-private-node.internal/rpc",
]) {
  withRpc(rpc, () => {
    const c = resolveCluster();
    ok(`unrecognised host is not devnet: ${new URL(rpc).host}`, c.cluster === "mainnet-beta", c.cluster);
  });
}

// 3b. STRUCTURAL: every script that SENDS a transaction must go through the one guard. The genesis-hash
//     check lives INSIDE `requireSanctionedCluster`, and `requireDevnet` was deleted, not aliased.
{
  // The MANIFEST is the floor; regex detection is only a HINT. A count-based self-check ("at least 12
  // detected") let the primitive list be reverted to its pre-fix state without failing. Three lists:
  //   SENDERS   must call the guard, whether or not a regex can see how they send.
  //   INDIRECT  senders no primitive is expected to match (they shell out through a helper), so their
  //             absence from `detected` is not a detector regression.
  //   READ_ONLY invoke the solana CLI to READ, and must NOT be forced to guard: making a read demand
  //             DOMINION_ALLOW_MAINNET trains the operator to keep write consent permanently exported.
  // Adding a sending script means adding a line here, in the SAME commit.

  // Two strippings, because the two families of pattern need opposite treatment: a JS primitive named
  // inside a string is prose, but the `solana` CLI literal is ONLY ever found inside a string.
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const stripStrings = (src: string) =>
    src
      .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  // Imports mention the guard without calling it, so they must not count as either a call or a comment.
  const stripImports = (src: string) =>
    src.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?/gm, " ");

  // Matched against code with comments AND strings stripped.
  const SEND_PRIMITIVES = [
    /\bsendAndConfirmTransaction\s*\(/,
    /\bsendAndConfirmRawTransaction\s*\(/,  // the raw sibling; sendRawTransaction does not match it
    /\bsendAndConfirm\s*\(/,                // AnchorProvider.sendAndConfirm
    /\bsendRawTransaction\s*\(/,
    /\.\s*sendTransaction\s*\(/,            // Connection.sendTransaction
    /\.\s*sendEncodedTransaction\s*\(/,     // Connection.sendEncodedTransaction: not matched by the above
    /\.\s*sendAll\s*\(/,                    // AnchorProvider.sendAll
    /\.\s*rpc\s*\(/,                        // Anchor methods().rpc(), tolerating whitespace
    // THE SQUADS SDK's SENDING NAMESPACE, and a real blind spot until 2026-08-12. `@sqds/multisig`
    // sends through `rpc.<name>(...)`: vaultTransactionCreate, proposalCreate, proposalApprove,
    // vaultTransactionExecute, multisigCreateV2. That is `.rpc.` followed by a call, which the Anchor
    // pattern above does NOT match because it expects `.rpc(` directly.
    //
    // It went unnoticed because every earlier Squads script also airdrops or transfers SOL through
    // `sendAndConfirmTransaction`, so it was detected for the wrong reason. `create-ops-proposal.ts`
    // is the first script whose ONLY sends are Squads calls, and this gate caught it: the script was
    // in SENDERS and the detector could not see how it sent, which is exactly the regression this
    // check was written to report.
    /\.\s*rpc\s*\.\s*\w+\s*\(/,
  ];
  // Matched against code with comments stripped and strings KEPT, since the command name is a literal,
  // and paired with a write verb because a bare /solana/ matched read-only preflights. Two shapes:
  // `"solana"` as the FIRST argument is execFile style; `execSync("solana program deploy ...")` is not.
  const CLI_INVOCATION = [
    /(?:exec(?:File)?Sync|spawn(?:Sync)?)\s*\(\s*["'`]solana["'`]/,
    /(?:exec(?:File)?Sync|execSync|spawn(?:Sync)?)\s*\(\s*["'`][^"'`]*\bsolana\s+\w/,
  ];
  // Quoted as a discrete argument, OR appearing after `solana program` in a single command string.
  const CLI_WRITE_VERB =
    /["'`](?:deploy|extend|close|set-upgrade-authority|transfer|airdrop|write-buffer)["'`]|\bsolana\s+(?:program\s+)?(?:deploy|extend|close|set-upgrade-authority|transfer|airdrop|write-buffer)\b/;

  const scriptsDir = path.join(__dirname);
  const helpers = new Set([
    "_guard.ts",
    "_cluster.ts",
    "_program-id.ts",
    // Called BY t1, which guards. It resolves no cluster of its own and takes an open Connection.
    "_t1-mint-helper.ts",
    // ROUND 8 L1-03. Read-only guardian discovery for the callers of `unpause`. It resolves no
    // cluster, takes an open Connection, and its only RPC is getProgramAccounts. Exempt on the same
    // terms as _t1-mint-helper: a helper that contained a send primitive would NOT belong here, and
    // the check below verifies that claim rather than trusting this comment.
    "_guardian.ts",
    "verify-cluster-resolution.ts",
  ]);

  // ROUND 5 P0-03. `_ceremony-emit.ts` holds the shared emit/verify/send plumbing for the two
  // ceremony steps, and `sendAll` is now where their transactions leave from. It is NOT in `helpers`
  // above: helpers are exempt from classification, and a file containing a send primitive must never
  // be exempt from anything. It is a SENDER, listed below, and INDIRECT, because it takes an already
  // guarded Connection from its caller and resolves no cluster of its own.
  //
  // Moving those calls out of step 8 is exactly the failure mode the handover calls A, changing
  // a mechanism without propagating to what describes it: this gate went red on the same commit,
  // which is why it exists.

  // THE MANIFEST. Every script here sends transactions and must call requireSanctionedCluster.
  const SENDERS = new Set([
    // The initialize-only recovery path (review finding P0-5). Sends initialize against an EXISTING mint
    // when T1 died between creating the mint and initialising. Guarded like every sender.
    "initialize-only-recovery.ts",
    // Creates the SILV ATA of config.inventory_wallet, the precondition admin_premint has and that
    // nothing else in the repo satisfied on the mainnet shape. It sends, so it is a SENDER and calls
    // assertReversible like the rest.
    "create-inventory-silv-ata.ts",
    // Builds a Dominion admin instruction, wraps it in a Squads v4 vault transaction on the ops
    // multisig, and creates / approves / EXECUTES the proposal. It built the mainnet unpause and
    // pre-mint rounds. It sends on three separate paths (vaultTransactionCreate, proposalCreate,
    // proposalApprove, vaultTransactionExecute), so it is a SENDER, it calls
    // requireSanctionedCluster first, and it gates --execute through assertReversible under the
    // action's own ACTION_COST name rather than a generic one.
    "create-ops-proposal.ts",
    // Funds the redemption treasury through the program's own `deposit_usdc`, rather than a raw
    // transfer, so the deposit emits TreasuryDeposit and the pinned-account constraints reject
    // account confusion on chain. It sends, so it is a SENDER and calls requireSanctionedCluster first.
    "deposit-treasury-usdc.ts",
    "bump-staleness.ts",
    "cancel-all.ts",
    "_ceremony-emit.ts",
    "ceremony-step8.ts",
    "cancel-bad-proposal.ts",
    "cancel-nonce-1.ts",
    "create-fee-vault.ts",
    // Creates the USDC treasury account early so the treasury can be funded before the ceremony.
    "create-usdc-treasury-ata.ts",
    "dev-set-premiums.ts",
    "e2e-fixa-devnet.ts",
    // ROUND 8 L1-05. The two-phase inventory change across the real 24h timelock.
    "e2e-inventory-change-devnet.ts",
    "e2e-guardian-devnet.ts",
    // The live proof that the fee-exemption whitelist changes what the chain charges. Added
    // 2026-08-11: nothing anywhere drove a completed mint_silv or redeem_silv against an exemption.
    "e2e-fee-exempt-devnet.ts",
    // The guardian veto, the fee sweep, the oracle anti-replay and the readiness digest, live.
    "e2e-guardian-fees-devnet.ts",
    // Causes a REAL redemption in order to prove the monitor decodes it and the alarm fires.
    "test-redeem-monitor-e2e.ts",
    "e2e-lazer-mint.ts",
    "e2e-public-mint-devnet.ts",
    "initialize-devnet.ts",
    // The launch-supply sender. Added 2026-08-10 with the script itself; the gate caught its absence.
    "premint.ts",
    "t1-hostile-bootstrap.ts",
    "test-dominion-squads-e2e.ts",
    "test-squads-e2e.ts",
    "test-v2-devnet.ts",
    "ui-scenario.ts",
    // No primitive matches it (it shells out via `sh(cmd, args)`), and it writes mainnet bytecode.
    "upgrade-program.ts",
  ]);
  // Senders whose transactions leave through code a regex here cannot see. `upgrade-program.ts` shells
  // out via `sh(cmd, args)`; the two ceremony steps delegate to `_ceremony-emit.ts:sendAll`. Both are
  // still REQUIRED to call requireSanctionedCluster, which is asserted separately, and they do.
  const INDIRECT = new Set([
    "upgrade-program.ts",
    // ROUND 8: `ceremony-step7.ts` is DELETED with runbook step 7. The public-mint open it proposed
    // no longer exists as a launch action: initialize ships that switch open, so the proposal would
    // revert PublicMintUnchanged. The check below refuses a manifest entry naming a deleted script,
    // which is what forced this line to go with the file.
    "ceremony-step8.ts",
  ]);
  // `_ceremony-emit.ts` is deliberately NOT here. INDIRECT means "no send primitive is expected to
  // match this file", and that file calls `sendAndConfirmTransaction(` in plain sight AND calls
  // `requireSanctionedCluster` itself. Listing it would have exempted the one file every mainnet
  // ceremony transaction leaves from, from the check that exists to catch a narrowed regex.
  // Shell out to READ, so not required to guard. A CLAIM, checked below against the send primitives.
  const READ_ONLY_CLI = new Set([
    "verify-mainnet-authorities.ts",
    "verify-mainnet-readiness.ts",
    // Drives every admin-panel instruction builder and hands each one to `simulateTransaction`. It
    // opens no keypair and calls no `sendTransaction`: simulation executes against real account state
    // and discards the result, which is the whole reason it can exercise the timelock proposals without
    // starting a single 24h clock.
    "test-admin-panel-simulate.ts",
  ]);
  // Everything else. Listed by name so ADDING a script is recorded, not silently blessed by a regex.
  const NON_SENDERS = new Set([
    // Reads the chain and fetches the deployed bundles to prove the frontends resolve MAINNET.
    // Sends nothing, so it must NOT be forced through the transaction guard.
    "verify-post-deploy.ts",
    // ROUND 8 REVIEW. Three files this gate had never seen. `_readiness-digest.ts` and
    // `_run-state.ts` are pure: no Connection, no keypair, no send. `test-security-posture-docs.ts`
    // shells out to the litesvm harness and reads files, and touches no cluster.
    "_readiness-digest.ts",
    // Pure string function: strips provider credentials out of an RPC endpoint before anything prints
    // it. No Connection, no keypair. Extracted from redeem-monitor.ts precisely BECAUSE that file runs
    // its main() at import time, so importing the helper from there executed a whole monitor run.
    "_redact.ts",
    "_run-state.ts",
    "test-security-posture-docs.ts",
    // Pure unit tests over premint.ts's two exported decisions (argv -> atomic, run record ->
    // resume plan). It imports premint.ts, which is a SENDER, but only for those two pure
    // functions: premint.ts guards its own main behind `require.main === module`, so importing it
    // opens no Connection and loads no keypair.
    "test-premint-args.ts",
    // Generates a keypair and writes it to disk. No Connection, no cluster, no send: the address it
    // prints exists nowhere until the ceremony creates it.
    "pregenerate-silv-mint.ts",
    // Fetches a signed envelope over HTTPS from Lazer. No Solana Connection, no keypair, no send.
    "_lazer-envelope.ts",
    // Pure port of the program's rolling-window rule, plus its fixtures. No cluster, no keypair.
    "_redeem-window.ts",
    "test-redeem-window.ts",
    // READ-ONLY alarm. It builds an Anchor Program with a throwaway keypair precisely so it CANNOT
    // sign, reads the config and the logs, and sends no transaction.
    "redeem-monitor.ts",
    "check-onchain.ts",
    "check-onchain2.ts",
    "check-pda.ts",
    "check-reserve.ts",
    "premint-sizing.ts",
    "probe-fetch.ts",
    "probe-lazer-feed.ts",
    "read-config.ts",
    "squads-vault-pda.ts",
    "verify-client-idl-parity.ts",
    "verify-oracle-sync.ts",
    // ROUND 6 R6-02. Imports `decideUpgradeGate` from upgrade-program.ts and calls it with literals.
    // It contains no send primitive of its own, and the module it imports now guards `main()` behind
    // `require.main === module`, so importing the decision no longer starts the upgrade script. That
    // guard was found by this classification failing.
    "test-upgrade-gate.ts",
    // ROUND 8 T8-06. Imports `buildStep8Actions` from ceremony-step8.ts and calls it with literals.
    // Builders stop at `.instruction()`, so nothing is signed and nothing is sent, and the module it
    // imports guards `main()` behind `require.main === module` for the same reason test-upgrade-gate
    // needed that guard: importing a decision must not start a ceremony.
    "test-ceremony-inventory-flow.ts",
    // ROUND 8 L1-01. Imports `buildT1InitializeArgs` from t1-hostile-bootstrap.ts and encodes it
    // offline with the IDL coder. That module's `main()` is behind `require.main === module` for
    // exactly this reason; importing the ceremony's argument builder must not start a ceremony.
    "test-t1-initialize-args.ts",
    // ROUND 8 L1-04. Pure decision function plus its test: no Connection, no RPC, no signer.
    "_launch-readiness.ts",
    "test-launch-open-readiness.ts",
    // ROUND 8 F-03 / T8-01. Build and install barriers: they shell out to cargo and curl, never to a
    // cluster, and they resolve no RPC.
    "_strict-build-sbf.sh",
    "test-strict-build-sbf.sh",
    // ROUND 8 T8-04. Drives the real validate_pinned offline; no Connection, no RPC.
    "test-release-provenance.py",
  ]);

  const files = fs.readdirSync(scriptsDir).filter((x) => x.endsWith(".ts") && !helpers.has(x));
  const detected: string[] = [];
  const unguarded: string[] = [];
  const prose: string[] = [];
  const unlisted: string[] = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(scriptsDir, f), "utf8");
    const noComments = stripComments(raw);
    const code = stripStrings(noComments);
    const sends =
      SEND_PRIMITIVES.some((re) => re.test(code)) ||
      (CLI_INVOCATION.some((re) => re.test(noComments)) && CLI_WRITE_VERB.test(noComments));
    if (sends) detected.push(f);

    // A script the manifest names must guard, even if no pattern can see how it sends.
    if (!SENDERS.has(f)) {
      // Fed from the manifest, NOT from `sends`: an unclassified file fails whether or not it matched.
      if (!READ_ONLY_CLI.has(f) && !NON_SENDERS.has(f)) unlisted.push(f + (sends ? " (detected as a sender)" : ""));
      continue;
    }
    if (!/requireSanctionedCluster\s*\(/.test(code)) {
      // Distinguish "no guard at all" from "a guard mentioned only in a comment". Imports are stripped
      // from BOTH sides, so deleting the call but keeping the import reads as unguarded, not as prose.
      if (/requireSanctionedCluster/.test(stripImports(noComments))) prose.push(f);
      else unguarded.push(f);
    }
  }

  ok(
    "every transaction-sending script calls requireSanctionedCluster IN CODE",
    unguarded.length === 0 && prose.length === 0,
    [
      unguarded.length ? `unguarded: ${unguarded.join(", ")}` : "",
      prose.length ? `guard only in a comment: ${prose.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ") || `all ${SENDERS.size} manifest senders guarded`,
  );

  ok(
    "every script in scripts/ is classified",
    unlisted.length === 0,
    unlisted.length
      ? `unclassified: ${unlisted.join(", ")} -- add each to SENDERS, READ_ONLY_CLI or NON_SENDERS`
      : `${SENDERS.size} senders, ${READ_ONLY_CLI.size} read-only, ${NON_SENDERS.size} non-senders, ${files.length} files`,
  );

  // The two CLAIMS, checked rather than trusted: this is what makes them assertions, not exemptions.
  const liars = [...READ_ONLY_CLI, ...NON_SENDERS].filter((f) => detected.includes(f)).sort();
  ok(
    "nothing claiming not to send actually sends",
    liars.length === 0,
    liars.length
      ? `these are listed as read-only or non-sending but match a send primitive: ${liars.join(", ")}`
      : "none",
  );

  // And nothing may reach for the consent-only predicate to skirt the genesis check.
  const skirters = fs
    .readdirSync(scriptsDir)
    .filter((x) => x.endsWith(".ts") && x !== "verify-cluster-resolution.ts" && x !== "_guard.ts")
    .filter((f) =>
      /guardConsentOnly\s*\(/.test(
        stripStrings(stripComments(fs.readFileSync(path.join(scriptsDir, f), "utf8"))),
      ),
    );
  ok(
    "no script uses guardConsentOnly to skip the genesis-hash check",
    skirters.length === 0,
    skirters.length ? skirters.join(", ") : "none",
  );

  // SELF-CHECK ON THE DETECTOR. Every manifest sender not declared INDIRECT must be matched by the
  // primitive list, so narrowing a pattern names the script it stopped seeing.
  const undetectable = [...SENDERS].filter((f) => !INDIRECT.has(f) && !detected.includes(f)).sort();
  ok(
    "the send detector still matches every direct sender it is supposed to match",
    undetectable.length === 0,
    undetectable.length
      ? `the primitive list no longer sees: ${undetectable.join(", ")} (did a pattern get narrowed?)`
      : `${detected.length} detected, ${SENDERS.size} in the manifest`,
  );

  // And the manifest may not name a script that no longer exists: a stale entry is a line nobody reads.
  const ghosts = [...SENDERS, ...READ_ONLY_CLI, ...NON_SENDERS].filter(
    (f) => !fs.existsSync(path.join(scriptsDir, f)),
  );
  ok(
    "no manifest entry names a deleted script",
    ghosts.length === 0,
    ghosts.length ? `remove from the manifest: ${ghosts.join(", ")}` : "none",
  );
}

// 4. MUTATION: drop a mainnet constant and require a throw, not a devnet fallback. Without this the
//    gate could pass while `_cluster.ts` quietly defaulted. The mutation goes to a TEMP COPY: a gate
//    must never write to config/mainnet-authorities.json and restore it in a `finally`, which does not
//    run on SIGINT.
//
//    ROUND 7 R7-03. This used to point the PRODUCTION reader at the copy with `DOMINION_MAINNET_CONFIG`
//    (plus, briefly, a second variable pretending to be an authority check). The seam is now in the
//    signature: `readMainnetConfigFrom(path)` and `mainnetAddressFrom(cfg, field)` are pure, this test
//    hands them what it built, and `mainnetConfig()` in production reads one path with no way to be
//    redirected. The property under test is unchanged; the hole it needed is gone.
const original = fs.readFileSync(SOT, "utf8");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dominion-sot-"));
const tmpSot = path.join(tmpDir, "mainnet-authorities.json");
try {
  const mutated = JSON.parse(original) as Record<string, Record<string, unknown>>;
  delete mutated.cluster_constants.usdc_mint;
  fs.writeFileSync(tmpSot, JSON.stringify(mutated, null, 2) + "\n");

  let threw = false;
  let message = "";
  try {
    mainnetAddressFrom(readMainnetConfigFrom(tmpSot), "usdc_mint");
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  ok("a MISSING mainnet constant throws instead of falling back", threw);
  ok(
    "and the error names the file to fix",
    threw && message.includes("mainnet-authorities.json"),
    threw ? message.split("\n")[0].slice(0, 60) : "(no throw)",
  );

  // The seam must not have grown back. If any env var can redirect the production reader, the file
  // it returns would be the mutated copy and this address would be missing.
  process.env.DOMINION_MAINNET_CONFIG = tmpSot;
  process.env.DOMINION_CLUSTER_SELFTEST = "1";
  let prodStillReadsTheCommittedFile = false;
  try {
    prodStillReadsTheCommittedFile = !!mainnetAddressFrom(mainnetConfig(), "usdc_mint");
  } catch {
    prodStillReadsTheCommittedFile = false;
  } finally {
    delete process.env.DOMINION_MAINNET_CONFIG;
    delete process.env.DOMINION_CLUSTER_SELFTEST;
  }
  ok(
    "NO environment variable redirects the production manifest reader (R7-03)",
    prodStillReadsTheCommittedFile,
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
// The strongest form of the property: the file was never written, so there is nothing to restore.
ok(
  "the source of truth was NEVER MUTATED (the test used a temp copy)",
  fs.readFileSync(SOT, "utf8") === original,
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("Cluster resolution is NOT safe. See audit finding S-01 before deploying anything.");
  process.exit(1);
}
console.log("CLUSTER RESOLUTION OK: the environment decides, and an unknown mainnet constant throws.");
