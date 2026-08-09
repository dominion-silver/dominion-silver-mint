/**
 * Unit tests for the two PURE decisions in scripts/premint.ts: how operator keystrokes become an
 * atomic u64, and what a pre-existing run record means for the run being started.
 *
 * WHY THEY ARE TESTED AT ALL. Review pass on 818ba73. `--dry-runn` used to parse as an unknown token,
 * be silently ignored, and PERFORM THE LIVE MINT of the entire launch supply. The runbook shows the
 * rehearsal and the irreversible send as two lines differing by exactly that token. A pure function
 * that turns a typo into a 1,000,000x error, or into a mint, does not need a cluster to be exercised
 * and had no fixtures.
 *
 *   npx tsx scripts/test-premint-args.ts
 */
import { parseArgs, decideResume, type RunRecord } from "./premint";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const w = JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  ok(name, g === w, g === w ? "" : `got ${g}, want ${w}`);
}

function throws(name: string, argv: string[], match: RegExp) {
  try {
    parseArgs(argv);
    ok(name, false, "did not throw");
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    ok(name, match.test(m), match.test(m) ? "" : `message was ${JSON.stringify(m)}`);
  }
}

console.log("premint argument parsing");

// --- the arithmetic. An off-by-1e6 here is a 1,000,000x error, so the boundaries are the test. ---
eq("--oz 1000", parseArgs(["--oz", "1000"]).tranches, [1000000000n]);
eq("--oz 1.5 is 1.5 oz, not 15", parseArgs(["--oz", "1.5"]).tranches, [1500000n]);
eq("--oz 1.05 right-pads, not left", parseArgs(["--oz", "1.05"]).tranches, [1050000n]);
eq("--oz 0.000001 is one atomic unit", parseArgs(["--oz", "0.000001"]).tranches, [1n]);
eq("--oz 00.5 absorbs leading zeros", parseArgs(["--oz", "00.5"]).tranches, [500000n]);
// Regression: this used to be REJECTED for a trailing zero, though 1.0000000 is exactly 1 oz.
eq("--oz 1.0000000 is exactly 1 oz", parseArgs(["--oz", "1.0000000"]).tranches, [1000000n]);
eq("--atomic passes through", parseArgs(["--atomic", "106115340615"]).tranches, [106115340615n]);
eq(
  "tranches keep their order",
  parseArgs(["--atomic", "3", "--atomic", "1", "--atomic", "2"]).tranches,
  [3n, 1n, 2n],
);

// --- THE MINT-VS-REHEARSAL BOUNDARY. Every one of these used to silently mint. ---
eq("--dry-run is recognised", parseArgs(["--oz", "1", "--dry-run"]).dryRun, true);
for (const typo of ["--dry-runn", "--dryrun", "--dry_run", "-dry-run", "--dry run"]) {
  throws(`a mistyped ${JSON.stringify(typo)} REFUSES rather than minting`, ["--oz", "1", typo], /unrecognised argument/);
}
throws("a stray positional is refused, not dropped", ["--oz", "1000", "2000"], /unrecognised argument/);
throws("--oz=1000 is refused with a useful message", ["--oz=1000"], /unrecognised argument/);

// --- refusals that must fire before anything is sent ---
throws("--atomic with no value", ["--atomic"], /needs a value/);
throws("--oz with no value", ["--oz", "1000", "--atomic"], /needs a value/);
throws("--oz swallowing the next flag", ["--oz", "--atomic", "5"], /must be a positive number/);
throws("--atomic refuses a fraction", ["--atomic", "1.5"], /must be an integer/);
throws("zero is refused", ["--oz", "0"], /zero atomic units/);
throws("more than 6 significant decimals", ["--oz", "1.0000001"], /significant decimal places/);
throws("beyond u64", ["--atomic", "18446744073709551616"], /exceeds u64/);
// A negative IS consumed as --oz's value (it is the next argv element), so the refusal comes from the
// numeric regex, not from the unknown-argument rail. Both refuse; asserting the wrong one would let a
// future change swap the mechanism without the test noticing.
throws("negatives are refused as a value", ["--oz", "-5"], /must be a positive number/);

console.log("\nrun-record resume decisions");

const NOW = { cluster: "https://api.devnet.solana.com", program: "Prog1111", inventoryWallet: "Inv1111" };
const rec = (landed: number, plan: string[] = ["100", "200", "300"]): RunRecord => ({
  cluster: NOW.cluster,
  program: NOW.program,
  admin: "Admin111",
  silvMint: "Mint1111",
  inventoryWallet: NOW.inventoryWallet,
  plan,
  landed: plan.slice(0, landed).map((atomic, index) => ({ index, atomic, sig: `sig${index}` })),
});

ok(
  "no record, no --resume: a fresh plan runs",
  decideResume(null, { tranches: [5n], resume: false }, NOW).kind === "fresh",
);
ok(
  "--resume with no record is refused",
  decideResume(null, { tranches: [], resume: true }, NOW).kind === "refuse",
);
// THE P0. A plain re-run after a partial plan used to mint everything again.
const dup = decideResume(rec(1), { tranches: [100n, 200n, 300n], resume: false }, NOW);
ok("a plain re-run over a live record REFUSES", dup.kind === "refuse");
ok("and the refusal says how to finish it", /--resume/.test(dup.message));
ok("and it says re-running would mint again", /MINT AGAIN/.test(dup.message));

const res = decideResume(rec(1), { tranches: [], resume: true }, NOW);
ok("--resume continues from the landed count", res.kind === "resume");
eq("and plans only what is left", res.remaining, [200n, 300n]);

for (const [field, drifted] of [
  ["cluster", { ...NOW, cluster: "https://api.mainnet-beta.solana.com" }],
  ["program", { ...NOW, program: "OTHER" }],
  ["inventory wallet", { ...NOW, inventoryWallet: "OTHER" }],
] as const) {
  const d = decideResume(rec(1), { tranches: [], resume: true }, drifted);
  ok(`--resume refuses when the ${field} drifted`, d.kind === "refuse", d.message.slice(0, 60));
}
ok(
  "a completed record cannot be resumed",
  decideResume(rec(3), { tranches: [], resume: true }, NOW).kind === "refuse",
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
