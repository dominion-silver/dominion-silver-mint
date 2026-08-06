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
import path from "path";
import { resolveCluster } from "./_cluster";

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

// 4. MUTATION: drop a mainnet constant and require a throw, not a devnet fallback.
//    Without this the gate could pass while `_cluster.ts` quietly defaulted.
const original = fs.readFileSync(SOT, "utf8");
try {
  const mutated = JSON.parse(original) as Record<string, Record<string, unknown>>;
  delete mutated.cluster_constants.usdc_mint;
  fs.writeFileSync(SOT, JSON.stringify(mutated, null, 2) + "\n");
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
  fs.writeFileSync(SOT, original);
}
// Restoration is itself load-bearing: a gate that corrupts the source of truth on failure would be
// worse than no gate. Assert the file is byte-identical to what we read.
ok(
  "the source of truth was restored byte for byte",
  fs.readFileSync(SOT, "utf8") === original,
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("Cluster resolution is NOT safe. See audit finding S-01 before deploying anything.");
  process.exit(1);
}
console.log("CLUSTER RESOLUTION OK: the environment decides, and an unknown mainnet constant throws.");
