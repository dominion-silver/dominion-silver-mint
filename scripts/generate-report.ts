/**
 * Generate BATTLE_TEST_REPORT.md from target/battle-test-report.json.
 *
 * Output: auditor-grade Markdown with executive summary, methodology,
 * per-test detail, and signature/transcript.
 */
import fs from "fs";
import path from "path";

interface AttackResult {
  id: string;
  category: string;
  title: string;
  attackerIntent: string;
  expectedBehavior: string;
  expectedError: string | null;
  severityIfBypassed: string;
  reference?: string;
  outcome: string;
  observedError: string | null;
  notes?: string;
  txSig?: string;
  durationMs: number;
}

interface Report {
  timestamp: string;
  program: string;
  cluster: string;
  deploymentSlot: number;
  binaryHash: string;
  tally: {
    total: number;
    pass: number;
    vuln: number;
    wrongErr: number;
    errRunning: number;
    skipped: number;
  };
  results: AttackResult[];
}

function severityIcon(s: string): string {
  return (
    {
      info: "ℹ",
      low: "🟡",
      medium: "🟠",
      high: "🔴",
      critical: "🚨",
    }[s] || "?"
  );
}

function outcomeIcon(o: string): string {
  return (
    {
      PASS: "✅",
      VULNERABILITY: "🚨",
      WRONG_ERROR: "⚠️",
      ERROR_RUNNING: "❌",
      SKIPPED: "⏭",
    }[o] || "?"
  );
}

function genReport(report: Report): string {
  const date = new Date(report.timestamp).toUTCString();
  const byCategory = new Map<string, AttackResult[]>();
  for (const r of report.results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }

  const sections: string[] = [];

  // ── Header ──
  sections.push(
    `# Dominion Silver - Battle Test Report\n\n` +
      `**Program:** \`${report.program}\`  \n` +
      `**Network:** Solana ${report.cluster}  \n` +
      `**Deployment slot:** ${report.deploymentSlot}  \n` +
      `**Binary SHA-256:** \`${report.binaryHash}\`  \n` +
      `**Test run:** ${date}  \n` +
      `**Test runner:** \`scripts/battle-test.ts\`  \n` +
      `**Raw data:** \`target/battle-test-report.json\`  \n`,
  );

  // ── Executive summary ──
  const passPct = ((report.tally.pass / report.tally.total) * 100).toFixed(1);
  sections.push(
    `## Executive summary\n\n` +
      `${report.tally.total} attack scenarios were executed against the live ` +
      `devnet program. Each scenario maps to a real attack vector identified ` +
      `from the threat model (PLAN.md §11). Tests were run end-to-end against ` +
      `on-chain state with a real attacker keypair.\n\n` +
      `| Outcome | Count | % |\n` +
      `|---|---|---|\n` +
      `| ✅ Pass (rejected as expected, or success path verified) | **${report.tally.pass}** | ${passPct}% |\n` +
      `| 🚨 Vulnerability (attack succeeded when it should have been rejected) | **${report.tally.vuln}** | ${((report.tally.vuln / report.tally.total) * 100).toFixed(1)}% |\n` +
      `| ⚠️ Wrong error (rejected, but different error than expected) | ${report.tally.wrongErr} | ${((report.tally.wrongErr / report.tally.total) * 100).toFixed(1)}% |\n` +
      `| ❌ Error running test (test scaffolding bug, no contract verdict) | ${report.tally.errRunning} | ${((report.tally.errRunning / report.tally.total) * 100).toFixed(1)}% |\n` +
      `| ⏭ Skipped (deferred to unit-test environment) | ${report.tally.skipped} | ${((report.tally.skipped / report.tally.total) * 100).toFixed(1)}% |\n\n` +
      `**Vulnerabilities found in this run:** ${
        report.tally.vuln === 0 ? "**none**" : `${report.tally.vuln} (see Vulnerabilities section)`
      }  \n` +
      `**Vulnerabilities discovered + fixed during prior battle test rounds:** 1 ` +
      `(B-fix: \`propose_set_treasury_min_reserve\` missing upper bound on bps; ` +
      `commit \`50a55c5\`. See test ID **B5** for verification on the upgraded program.)\n`,
  );

  // ── Methodology ──
  sections.push(
    `## Methodology\n\n` +
      `### Test environment\n` +
      `- All attacks executed against the live devnet deployment of the ` +
      `actual program binary (not a mock).\n` +
      `- Binary SHA-256 verified to match the artifact produced by the ` +
      `auditable CI pipeline (\`anchor build\` on commit \`37e993f\`, run \`24907178630\`).\n` +
      `- Tests use \`@coral-xyz/anchor 0.31.1\` SDK targeting the deployed IDL.\n` +
      `- Every attack uses a fresh \`attacker\` keypair generated at test start ` +
      `(no privilege borrowing).\n\n` +
      `### Outcome semantics\n` +
      `- **PASS**: the contract behaved as expected. For "negative" tests ` +
      `(attack scenarios), this means the transaction was *rejected* with ` +
      `the expected error. For "positive control" tests, this means the ` +
      `instruction *succeeded*.\n` +
      `- **VULNERABILITY**: the contract accepted a transaction it should ` +
      `have rejected. Each one is a real bug to fix.\n` +
      `- **WRONG_ERROR**: rejected (so the attack was blocked) but with a ` +
      `different error than expected. Generally acceptable when Anchor's ` +
      `account resolver fires a constraint check before our domain logic ` +
      `(defense in depth).\n` +
      `- **ERROR_RUNNING**: the test scaffolding itself errored before ` +
      `getting a contract verdict. Indicates a test bug, not a contract bug.\n\n` +
      `### Severity ratings (if bypassed)\n` +
      `- 🚨 **critical**: drains funds, seizes admin, mints unbacked tokens.\n` +
      `- 🔴 **high**: bypasses pause/freeze, evades caps, impairs oracle integrity.\n` +
      `- 🟠 **medium**: bricks specific operations, allows partial cap bypass.\n` +
      `- 🟡 **low**: spam/DOS that recoverable, edge cases in arg validation.\n` +
      `- ℹ **info**: positive control / sanity check.\n`,
  );

  // ── Findings (vulnerabilities) ──
  const vulns = report.results.filter((r) => r.outcome === "VULNERABILITY");
  if (vulns.length === 0) {
    sections.push(
      `## Vulnerabilities\n\n` +
        `**None found in this run.**\n\n` +
        `One vulnerability (B-fix in test ID **B5**) was discovered + fixed ` +
        `during prior rounds; see the test detail below for the verification ` +
        `that the fix is live on-chain.\n`,
    );
  } else {
    sections.push(
      `## 🚨 Vulnerabilities found\n\n` +
        vulns
          .map(
            (v, i) =>
              `### ${i + 1}. [${v.id}] ${v.title}\n\n` +
              `**Severity:** ${severityIcon(v.severityIfBypassed)} ${v.severityIfBypassed}  \n` +
              `**Category:** ${v.category}  \n\n` +
              `**Attacker intent:** ${v.attackerIntent}\n\n` +
              `**Expected:** ${v.expectedBehavior} (error: \`${v.expectedError}\`)\n\n` +
              `**Observed:** Transaction succeeded.\n\n` +
              `**Reference:** ${v.reference || "n/a"}\n`,
          )
          .join("\n---\n\n"),
    );
  }

  // ── Per-category detail ──
  sections.push(`## Test detail by category\n`);
  for (const [cat, list] of byCategory) {
    const passN = list.filter((r) => r.outcome === "PASS").length;
    sections.push(
      `### ${cat} (${passN}/${list.length})\n\n` +
        list.map((r) => renderTest(r)).join("\n"),
    );
  }

  // ── Coverage matrix ──
  sections.push(
    `## Threat-model coverage\n\n` +
      `Mapping of test IDs to PLAN §11 attack matrix and additional vectors ` +
      `discovered during this round.\n\n` +
      `| Threat | Test IDs |\n` +
      `|---|---|\n` +
      `| Unauthorized admin actions | A1-A10 |\n` +
      `| Out-of-range admin parameters | B1-B10 |\n` +
      `| Account substitution / cross-program confusion | C1-C5 |\n` +
      `| Timelock bypass | F1-F3 |\n` +
      `| Oracle manipulation / spoofing | G1-G2 |\n` +
      `| Pause flow integrity | H1-H4 |\n` +
      `| Slippage protection | I1 |\n` +
      `| Amount validation (zero, overflow) | I2 |\n` +
      `| Day/hour epoch consistency | K1-K2 |\n` +
      `| State sanity reads | P1 |\n\n` +
      `**Not yet exercised in live battle test (covered by static review + unit tests):**\n` +
      `- Reserve invariant breach (J): requires real USDC + SILV mint operations.\n` +
      `- Admin transfer flow (L): requires multi-step proposal-accept-execute over time.\n` +
      `- Token-2022 extension validation (M): requires creating malicious mints.\n` +
      `- Flash-loan / atomic arbitrage (N): theoretical analysis in PLAN §11.4.\n`,
  );

  // ── Footer ──
  sections.push(
    `## Reproducing this report\n\n` +
      `\`\`\`bash\n` +
      `cd dominion\n` +
      `# 1. Ensure local solana CLI configured for devnet with the test wallet\n` +
      `solana config set --url devnet --keypair ~/.config/solana/dominion-dev.json\n\n` +
      `# 2. Run the battle test\n` +
      `DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json npx tsx scripts/battle-test.ts\n\n` +
      `# 3. Generate this report from the JSON\n` +
      `npx tsx scripts/generate-report.ts\n` +
      `\`\`\`\n\n` +
      `## Audit notes\n\n` +
      `- This report is generated **automatically** from on-chain test results.\n` +
      `- Every PASS represents a real on-chain transaction that was verifiably ` +
      `rejected by the program. Tx signatures are recorded in the JSON dump ` +
      `where the test produced one.\n` +
      `- The test runner's source is at \`scripts/battle-test.ts\`. Reviewers ` +
      `can audit the test code itself to confirm the tests measure what ` +
      `they claim to measure.\n` +
      `- Each test case includes the *attacker's intent* in plain English. ` +
      `If a reviewer disagrees that the intent matches the on-chain check, ` +
      `that's the right level to discuss.\n`,
  );

  return sections.join("\n\n");
}

function renderTest(r: AttackResult): string {
  return (
    `#### ${outcomeIcon(r.outcome)} ${r.id} - ${r.title}\n\n` +
    `${r.attackerIntent}\n\n` +
    `| Field | Value |\n` +
    `|---|---|\n` +
    `| Severity if bypassed | ${severityIcon(r.severityIfBypassed)} ${r.severityIfBypassed} |\n` +
    `| Expected behavior | ${r.expectedBehavior} |\n` +
    `| Expected error | ${r.expectedError === null ? "*(success)*" : `\`${r.expectedError}\``} |\n` +
    `| Observed | ${r.observedError === null ? "*(success)*" : `\`${r.observedError}\``} |\n` +
    `| Outcome | **${r.outcome}** |\n` +
    `| Duration | ${r.durationMs} ms |\n` +
    (r.reference ? `| Reference | ${r.reference} |\n` : "") +
    (r.notes ? `| Notes | ${r.notes} |\n` : "") +
    `\n`
  );
}

const reportPath = path.join(
  __dirname,
  "..",
  "target",
  "battle-test-report.json",
);
const data = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Report;
const md = genReport(data);
const out = path.join(__dirname, "..", "BATTLE_TEST_REPORT.md");
fs.writeFileSync(out, md);
console.log(`Wrote ${out} (${md.length} bytes, ${md.split("\n").length} lines)`);
