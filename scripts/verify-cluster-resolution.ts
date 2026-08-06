/**
 * GATE: prove that cluster selection is driven by the ENVIRONMENT and never falls back to devnet.
 *
 * Exists because of external audit finding S-01, the P0 of the 2026-08-06 pass. Three scripts had
 * `const RPC = "https://api.devnet.solana.com"` hardcoded and then called `requireDevnet(RPC)`,
 * which trivially passed. The mainnet runbook's invocation would have run the entire hostile
 * bootstrap on devnet and initialised nothing, after the mainnet deploy was paid for.
 *
 * A fix to that class is worth nothing without a check that can FAIL, so this asserts the
 * properties rather than the implementation:
 *
 *   1. An unset DOMINION_RPC still means devnet. Running a script with no environment must stay the
 *      safe, boring thing it always was.
 *   2. An explicit mainnet RPC resolves to mainnet-beta AND to mainnet addresses. If this ever
 *      returns the devnet USDC mint, S-01 is back.
 *   3. An UNRECOGNISED RPC (a private Helius/Triton/QuickNode endpoint, which is what a real mainnet
 *      operator actually uses) resolves to mainnet-beta, not devnet. Defaulting an unknown host to
 *      devnet is the same bug wearing a different hat.
 *   4. Removing a mainnet constant from the source of truth makes resolution THROW rather than
 *      silently substituting the devnet value. Verified by mutation, below: the check is not
 *      trusted, it is broken on purpose and required to fail.
 *
 * Run: npx tsx scripts/verify-cluster-resolution.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { resolveCluster } from "./_cluster";
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

// 2b. REVIEW-OF-FIXES P0: a MAINNET host whose URL merely CONTAINS "devnet" must classify as mainnet.
//     The first version of `classify()` tested /devnet/i against the whole URL, so a query parameter, a
//     path segment, or six characters landing by chance inside an API key made it "devnet". Because
//     `_guard.ts::isDevnet` used the same test, `requireDevnet` returned early and the
//     DOMINION_ALLOW_MAINNET consent gate never fired: an --execute run would have extended and deployed
//     on MAINNET while printing cluster=devnet.
//
//     This gate existed and could not fail on it, because it only pinned "unknown host -> mainnet".
//     These are the exact strings from the security review.
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

// 2d. And the guard that actually gates transactions must agree with the classifier. Two
//     implementations of "is this devnet" was the underlying defect; the regex was only the symptom.
for (const [rpc, shouldNeedConsent] of [
  ["https://api.devnet.solana.com", false],
  ["http://127.0.0.1:8899", false], // P2-6: localnet is the mandated rehearsal cluster
  ["https://api.mainnet-beta.solana.com", true],
  ["https://api.mainnet-beta.solana.com/?tag=devnet-mirror", true],
] as const) {
  const prev = process.env.DOMINION_ALLOW_MAINNET;
  delete process.env.DOMINION_ALLOW_MAINNET;
  let refused = false;
  try {
    // The guard reaches the network for the genesis check, so this asserts only the CONSENT half: a
    // refusal for the right reason happens before any RPC call. `guardConsentOnly` is the same predicate
    // the guard uses, exposed so this gate does not have to make 4 network calls to test 4 URLs.
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

// 3b. STRUCTURAL: every script that SENDS a transaction must go through the one guard.
//
//     RE-AUDIT P0. The genesis-hash check was wired into three scripts and missing from thirteen,
//     including `create-fee-vault.ts`, a mandatory mainnet step. Point `https://devnet.proxy.example` at
//     mainnet, run it without consent, and it created the irreversible ATA with real SOL while printing
//     "devnet". I had fixed instances and left the class, for the fourth time in this batch.
//
//     So the check moved INSIDE `requireSanctionedCluster` and the old synchronous `requireDevnet` was
//     deleted rather than aliased, making every call site a compile error until updated. This assertion
//     is what stops the class from reopening: a NEW sending script that forgets the guard fails here, not
//     in production.
{
  // ROUND 3 P2. The first version of this check recognised only `sendAndConfirmTransaction`, an exact
  // `.rpc()`, and one textual `solana program deploy`. Codex broke it three ways: `ui-scenario.ts` has a
  // real `conn.sendRawTransaction(...)` and no guard yet the gate printed 30/30; `e2e-lazer-mint.ts` sends
  // via `provider.sendAndConfirm(...)`, also invisible; and a guard call sitting only in a COMMENT satisfied
  // the textual property without executing anything.
  //
  // REVIEW-OF-FIXES P2, and this is the third shape of this check. Both reviewers measured the same three
  // holes in my widened version:
  //
  //   1. `detected.length >= 12` was the self-check. 16 match today, so REVERTING the primitive list to the
  //      exact pre-fix set still printed 31/31, and so did deleting `sendRawTransaction` alone, which is
  //      the precise primitive whose absence WAS the round-3 finding. It fired only on a near-total gutting.
  //      Worse, a magic floor on the number of dangerous scripts is a floor on how safe the repo may
  //      become: deleting five devnet-only one-shots would drop it to 11 and FAIL the launch gate.
  //   2. `upgrade-program.ts`, the script that writes mainnet bytecode, matches ZERO primitives. It shells
  //      out through `sh(cmd, args)` with a variable first argument. It calls the guard today; deleting
  //      that call would have kept the gate at 31/31.
  //   3. The comment said "strip comments and strings"; only comments were stripped. So a read-only probe
  //      whose log line mentions a primitive was reported as an unguarded sender, and a gate with false
  //      positives gets allowlisted into uselessness.
  //
  // So the floor is now a NAMED MANIFEST rather than a count. Three explicit lists, and every one of them
  // is load-bearing in a different direction:
  //
  //   SENDERS   must call the guard, whether or not a regex can see how they send.
  //   INDIRECT  senders the pattern list is NOT expected to match (they shell out through a helper), so
  //             their absence from `detected` is not treated as a detector regression.
  //   READ_ONLY scripts that invoke the solana CLI to READ. They must NOT be forced to guard: making a
  //             read demand DOMINION_ALLOW_MAINNET trains the operator to keep the mainnet write-consent
  //             variable exported, which is itself one of the findings in round 3.
  //
  // Adding a sending script means adding a line here, in the same commit. That is the point: the gate can
  // no longer drift to "checking nothing" by arithmetic, only by someone editing a list on purpose.

  // Two strippings, because the two families of pattern need opposite treatment. A JS primitive named
  // inside a string is prose; the `solana` CLI literal is ONLY ever found inside a string.
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
    /\.\s*sendAll\s*\(/,                    // AnchorProvider.sendAll
    /\.\s*rpc\s*\(/,                        // Anchor methods().rpc(), tolerating whitespace
  ];
  // Matched against code with comments stripped and strings KEPT, since the command name is a literal.
  // Paired with a write verb: a bare /solana/ matched read-only preflights, and forcing those to guard is
  // how the consent variable ends up permanently exported.
  const CLI_INVOCATION = /(?:exec(?:File)?Sync|spawn(?:Sync)?)\s*\(\s*["'`]solana["'`]/;
  const CLI_WRITE_VERB =
    /["'`](?:deploy|extend|close|set-upgrade-authority|transfer|airdrop|write-buffer)["'`]/;

  const scriptsDir = path.join(__dirname);
  const helpers = new Set([
    "_guard.ts",
    "_cluster.ts",
    "_program-id.ts",
    // Called BY t1, which guards. It resolves no cluster of its own and takes an open Connection.
    "_t1-mint-helper.ts",
    "verify-cluster-resolution.ts",
  ]);

  // THE MANIFEST. Every script here sends transactions and must call requireSanctionedCluster.
  const SENDERS = new Set([
    "bump-staleness.ts",
    "cancel-all.ts",
    "cancel-bad-proposal.ts",
    "cancel-nonce-1.ts",
    "create-fee-vault.ts",
    "dev-set-premiums.ts",
    "e2e-fixa-devnet.ts",
    "e2e-guardian-devnet.ts",
    "e2e-lazer-mint.ts",
    "e2e-public-mint-devnet.ts",
    "initialize-devnet.ts",
    "t1-hostile-bootstrap.ts",
    "test-dominion-squads-e2e.ts",
    "test-squads-e2e.ts",
    "test-v2-devnet.ts",
    "ui-scenario.ts",
    // Not matched by any primitive: it shells out through `sh(cmd, args)`. Listed anyway BECAUSE it is the
    // one script that writes mainnet bytecode. This entry is the fix for hole 2 above.
    "upgrade-program.ts",
  ]);
  const INDIRECT = new Set(["upgrade-program.ts"]);
  // Invoke the solana CLI to READ. Must not be required to consent to a mainnet WRITE in order to look.
  const READ_ONLY_CLI = new Set(["verify-mainnet-authorities.ts", "verify-mainnet-readiness.ts"]);

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
      (CLI_INVOCATION.test(noComments) && CLI_WRITE_VERB.test(noComments));
    if (sends) detected.push(f);

    // A script the manifest names must guard, even if no pattern can see how it sends.
    if (!SENDERS.has(f)) {
      // A NEW sender that nobody listed. Not silently tolerated: either it belongs in SENDERS or it is a
      // read-only CLI caller and belongs in READ_ONLY_CLI. The choice has to be made by a person.
      if (sends && !READ_ONLY_CLI.has(f)) unlisted.push(f);
      continue;
    }
    if (!/requireSanctionedCluster\s*\(/.test(code)) {
      // Distinguish "no guard at all" from "a guard mentioned only in a comment", because the second is
      // the one that fooled the first version of this check. Imports are stripped from BOTH sides, so
      // deleting the call while leaving `import { requireSanctionedCluster }` reads as unguarded, not as
      // prose. It reported prose before, which told the operator to move a comment when the call was gone.
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
    "no sending script is missing from the manifest",
    unlisted.length === 0,
    unlisted.length
      ? `add to SENDERS (or READ_ONLY_CLI if it only reads): ${unlisted.join(", ")}`
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

  // SELF-CHECK ON THE DETECTOR, and this is what `detected.length >= 12` was trying and failing to be.
  // Every manifest sender that is not declared INDIRECT must be matched by the primitive list. Narrowing
  // the list now names the script it stopped seeing instead of quietly staying above a threshold.
  const undetectable = [...SENDERS].filter((f) => !INDIRECT.has(f) && !detected.includes(f)).sort();
  ok(
    "the send detector still matches every direct sender it is supposed to match",
    undetectable.length === 0,
    undetectable.length
      ? `the primitive list no longer sees: ${undetectable.join(", ")} (did a pattern get narrowed?)`
      : `${detected.length} detected, ${SENDERS.size} in the manifest`,
  );

  // And the manifest may not name a script that no longer exists: a stale entry is a line nobody reads.
  const ghosts = [...SENDERS, ...READ_ONLY_CLI].filter(
    (f) => !fs.existsSync(path.join(scriptsDir, f)),
  );
  ok(
    "no manifest entry names a deleted script",
    ghosts.length === 0,
    ghosts.length ? `remove from the manifest: ${ghosts.join(", ")}` : "none",
  );
}

// 4. MUTATION: drop a mainnet constant and require a throw, not a devnet fallback.
//    Without this the gate could pass while `_cluster.ts` quietly defaulted.
// REVIEW-OF-FIXES P2: this used to write the mutated JSON over `config/mainnet-authorities.json` itself
// and restore it in a `finally`. `finally` does not run on SIGINT, SIGKILL or a CI step timeout, so a
// Ctrl-C mid-run left the file that supplies the mainnet USDC mint, the premiums, the timelock and the
// compliance authority to `initialize` mutated and reformatted in the working tree. It was also a
// concurrency hazard with anything else calling `mainnetConfig()`. A gate must not write to the file the
// ceremony reads: the mutation goes to a temp copy and `DOMINION_MAINNET_CONFIG` points resolution at it.
const original = fs.readFileSync(SOT, "utf8");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dominion-sot-"));
const tmpSot = path.join(tmpDir, "mainnet-authorities.json");
try {
  const mutated = JSON.parse(original) as Record<string, Record<string, unknown>>;
  delete mutated.cluster_constants.usdc_mint;
  fs.writeFileSync(tmpSot, JSON.stringify(mutated, null, 2) + "\n");
  process.env.DOMINION_MAINNET_CONFIG = tmpSot;
  let threw = false;
  let message = "";
  withRpc("https://api.mainnet-beta.solana.com", () => {
    try {
      resolveCluster();
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
  });
  ok("a MISSING mainnet constant throws instead of falling back", threw);
  ok(
    "and the error names the file to fix",
    threw && message.includes("mainnet-authorities.json"),
    threw ? message.split("\n")[0].slice(0, 60) : "(no throw)",
  );
} finally {
  delete process.env.DOMINION_MAINNET_CONFIG;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
// Restoration is itself load-bearing: a gate that corrupts the source of truth on failure would be
// worse than no gate. Assert the file is byte-identical to what we read.
// The strongest form of the property: the file was never written at all, so there is nothing to restore.
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
