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
  // So: strip comments and strings before looking, widen the send primitives, and require the guard call to
  // appear in CODE. A gate that can be satisfied by prose is worse than no gate, because it reports 30/30.
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  const SEND_PRIMITIVES = [
    /\bsendAndConfirmTransaction\s*\(/,
    /\bsendAndConfirm\s*\(/,          // AnchorProvider.sendAndConfirm
    /\bsendRawTransaction\s*\(/,
    /\.\s*sendTransaction\s*\(/,      // Connection.sendTransaction
    /\.\s*rpc\s*\(/,                  // Anchor methods().rpc(), tolerating whitespace
    // Shelling out to the solana CLI. Detect the CALL, not the words: a bare
    // /solana\s+program\s+close/ matched the PROSE inside a console.log string in
    // verify-mainnet-authorities.ts, which is a read-only preflight. A gate with false positives gets
    // allowlisted into uselessness, so it has to be precise in both directions.
    /exec(?:File)?Sync\s*\(\s*["'`]solana["'`]/,
    /spawn(?:Sync)?\s*\(\s*["'`]solana["'`]/,
  ];
  const scriptsDir = path.join(__dirname);
  const helpers = new Set([
    "_guard.ts",
    "_cluster.ts",
    "_program-id.ts",
    // Called BY t1, which guards. It resolves no cluster of its own and takes an open Connection.
    "_t1-mint-helper.ts",
    "verify-cluster-resolution.ts",
  ]);
  const offenders: string[] = [];
  const prose: string[] = [];
  for (const f of fs.readdirSync(scriptsDir).filter((x) => x.endsWith(".ts"))) {
    if (helpers.has(f)) continue;
    const raw = fs.readFileSync(path.join(scriptsDir, f), "utf8");
    const code = stripComments(raw);
    if (!SEND_PRIMITIVES.some((re) => re.test(code))) continue;
    if (!/requireSanctionedCluster\s*\(/.test(code)) {
      // Distinguish "no guard at all" from "a guard mentioned only in a comment", because the second is
      // the one that fooled the previous version of this check.
      if (/requireSanctionedCluster/.test(raw)) prose.push(f);
      else offenders.push(f);
    }
  }
  ok(
    "every transaction-sending script calls requireSanctionedCluster IN CODE",
    offenders.length === 0 && prose.length === 0,
    [
      offenders.length ? `unguarded: ${offenders.join(", ")}` : "",
      prose.length ? `guard only in a comment: ${prose.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ") || "all guarded",
  );

  // And nothing may reach for the consent-only predicate to skirt the genesis check.
  const skirters = fs
    .readdirSync(scriptsDir)
    .filter((x) => x.endsWith(".ts") && x !== "verify-cluster-resolution.ts" && x !== "_guard.ts")
    .filter((f) => /guardConsentOnly\s*\(/.test(stripComments(fs.readFileSync(path.join(scriptsDir, f), "utf8"))));
  ok(
    "no script uses guardConsentOnly to skip the genesis-hash check",
    skirters.length === 0,
    skirters.length ? skirters.join(", ") : "none",
  );

  // SELF-CHECK: the send detector must actually detect. A gate whose detector matches nothing reports a
  // clean sweep over an empty set, which is how the previous version passed while ui-scenario.ts sent
  // unguarded.
  const detected = fs
    .readdirSync(scriptsDir)
    .filter((x) => x.endsWith(".ts") && !helpers.has(x))
    .filter((f) =>
      SEND_PRIMITIVES.some((re) =>
        re.test(stripComments(fs.readFileSync(path.join(scriptsDir, f), "utf8"))),
      ),
    );
  ok(
    "the send detector finds a plausible number of senders",
    detected.length >= 12,
    `${detected.length} detected`,
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
