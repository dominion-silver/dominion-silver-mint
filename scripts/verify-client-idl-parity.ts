/**
 * Cross-reference what the CLIENTS call against what the IDL declares.
 *
 * WHY THIS EXISTS. The 2026-08-05 batch removed four instructions and an account type, and added
 * four accounts to mint and redeem. The triple review then found that both apps and two scripts
 * were still calling removed instructions and still omitting the new accounts, and that NOTHING
 * caught it:
 *
 *   - the method builders go through `as any`, so TypeScript sees nothing;
 *   - `.accounts()` is NOT strict in Anchor 0.31.1 (it delegates to `accountsPartial`), so Anchor
 *     silently derives a missing account from the IDL seeds rather than rejecting the call. For
 *     OPTIONAL accounts that derivation yields a real PDA address for an account that does not
 *     exist, which the program then fails to deserialize;
 *   - the existing constants gate checks addresses and IDL byte-identity, not names.
 *
 * So a stale client failed at SIGNING TIME, in front of a user, with a bare TypeError or an
 * AccountNotInitialized that reads like a broken protocol. This is the mechanical guard for that
 * whole class, and it is cheap: three string-level checks against the committed IDL.
 *
 * WHAT IT CHECKS
 *   1. Every `.methods`-chain instruction name exists in the IDL.
 *   2. Every key inside `.accounts({...})` / `.accountsPartial({...})` is a real account name for
 *      SOME instruction in the IDL.
 *   3. Every `("ErrorName", 12345)` pair matches the IDL's code for that error.
 *
 * WHAT IT DOES NOT CHECK, stated so nobody trusts it further than it goes: it cannot tell which
 * instruction a given `.accounts({...})` belongs to (the chains span lines and are cast to `any`),
 * so it cannot prove an account list is COMPLETE. That job belongs to the per-instruction parity
 * tests in apps/public/src/lib/__tests__/contract-parity.test.ts, which assert the exact set.
 *
 * KNOWN LIMIT OF THE WHOLE CHAIN, worth stating because this gate is sold as preventing the class:
 * it validates the clients against `target/idl/...json`, which is a GENERATED, gitignored artifact.
 * Nothing here derives the IDL from `programs/**`. Change a Rust account list, forget
 * `anchor idl build`, and all three copies still agree with each other, both gates go green, and both
 * apps are broken. What closes that is the CI job order: the "Regenerate the IDL" step runs BEFORE
 * this one and a separate step diffs the regenerated IDL against both committed copies, so on CI the
 * artifact is always fresh. Locally it is only as fresh as your last build.
 *
 * Run: npx tsx scripts/verify-client-idl-parity.ts
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..");
const IDL_PATH = path.join(ROOT, "target", "idl", "dominion_silver_mint.json");

const SCAN_DIRS = [
  "apps/admin/src",
  "apps/public/src",
  "scripts",
  "apps/public/scripts",
];

/** snake_case -> camelCase, matching how Anchor's TS client exposes IDL names. */
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "idl") continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      // Skip THIS file: it carries the removed instruction names as string literals in its own
      // denylist, so scanning itself is a guaranteed false positive.
      if (e.name === "verify-client-idl-parity.ts") continue;
      out.push(rel);
    }
  }
  return out;
}

/** Replace comment bodies with spaces, keeping every newline so line numbers survive. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  type Mode = "code" | "line" | "block" | "str";
  let mode: Mode = "code";
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "str";
        quote = c;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      } else {
        out += " ";
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? c : " ";
      i++;
      continue;
    }
    // string literal: copy through, honouring escapes, so a quote inside does not end it early
    if (c === "\\") {
      out += c + (c2 ?? "");
      i += 2;
      continue;
    }
    if (c === quote) mode = "code";
    out += c;
    i++;
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  msg: string;
}

function main() {
  if (!fs.existsSync(IDL_PATH)) {
    console.error(`FAIL: no IDL at ${IDL_PATH}. Build it first.`);
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idl: any = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));

  const ixNames = new Set<string>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    idl.instructions.map((i: any) => camel(i.name)),
  );
  const accountNames = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const i of idl.instructions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of i.accounts) accountNames.add(camel(a.name));
  }
  const errorCodes = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of idl.errors ?? []) errorCodes.set(e.name, e.code);

  // Names this project has REMOVED. Listed explicitly because check 1 can only see a method call
  // in a chain it managed to parse, and a removed name is the case that must never slip through.
  // Anything here is a hard failure wherever it appears in a call position.
  const REMOVED = [
    "redeemSilvQueued",
    "claimRedemption",
    "adminSettleRedemptionOffchain",
    "closeSettledRedemption",
  ];

  const files = SCAN_DIRS.flatMap((d) => walk(d));
  const findings: Finding[] = [];

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    // Blank out comments before scanning, PRESERVING line numbers and length so every offset below
    // still maps to the real file.
    //
    // Without this, check 1 greps `.claimRedemption(` across prose, and this codebase's style is long
    // explanatory comments that name exactly the things that were removed. One comment written as
    // "the old code called `.claimRedemption()`" would hard-fail CI with no code defect, and a gate
    // that cries wolf is a gate somebody deletes. Same hazard for check 3 scanning `__tests__`, where
    // a negative test deliberately passes a bogus account key.
    const src = stripComments(raw);

    // --- 1. removed instruction names in a CALL position ---
    for (const gone of REMOVED) {
      const re = new RegExp("\\." + gone + "\\s*\\(", "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        findings.push({
          file: rel,
          line: src.slice(0, m.index).split("\n").length,
          msg: `calls REMOVED instruction \`${gone}\` (not in the IDL). This fails at signing time with a bare TypeError.`,
        });
      }
    }

    // --- 2. `.methods` chains: the instruction name must exist ---
    // Matches `.methods` (optionally `as any)`) followed IMMEDIATELY by `.name(`, with only
    // whitespace between. An earlier version allowed up to 80 characters of anything, which
    // happily matched the NEXT link in the chain (`.accountsPartial(`, `.toString(`) and produced
    // false positives. A CI gate that cries wolf gets switched off, so the pattern is deliberately
    // narrow: it under-reports rather than over-reports, and check 1 plus the parity unit tests
    // cover what it misses.
    const chainRe = /\.methods\s*(?:as\s+\w+\s*)?\)?\s*\.(\w+)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = chainRe.exec(src)) !== null) {
      const name = cm[1];
      if (!ixNames.has(name)) {
        findings.push({
          file: rel,
          line: src.slice(0, cm.index).split("\n").length,
          msg: `\`.methods.${name}(\` is not an instruction in the IDL.`,
        });
      }
    }

    // --- 3. `.accounts({...})` keys must be real account names ---
    const accRe = /\.accounts(?:Partial)?\(\s*\{([\s\S]*?)\}\s*\)/g;
    let am: RegExpExecArray | null;
    while ((am = accRe.exec(src)) !== null) {
      const body = am[1];
      const startLine = src.slice(0, am.index).split("\n").length;
      // Top-level `key:` occurrences. Spreads and nested objects are skipped rather than
      // half-parsed: a false positive in a CI gate gets the gate disabled.
      const keyRe = /(?:^|\n)\s*(\w+)\s*:/g;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(body)) !== null) {
        const key = km[1];
        if (!accountNames.has(key)) {
          findings.push({
            file: rel,
            line: startLine + body.slice(0, km.index).split("\n").length - 1,
            msg: `account key \`${key}\` is not an account of ANY instruction in the IDL (typo, or removed from the program).`,
          });
        }
      }
    }

    // --- 4. ("ErrorName", 12345) pairs must match the IDL ---
    //
    // Matches ANY CamelCase identifier paired with a code, rather than a suffix allowlist. The
    // allowlist this replaced silently skipped `StaleOracle` (12004, mapped in the public client),
    // `ZeroAmount`, `Unauthorized`, `WrongMint` and `PriceOutOfBounds`, while the gate's own output
    // claimed to check "every error code the clients use". If a variant is ever inserted before
    // StaleOracle in the enum, the client keeps 12004 and the user gets a raw Custom dump.
    const errRe = /["']([A-Z][A-Za-z0-9]{3,})["']\s*,\s*(\d{4,6})\b/g;
    let em: RegExpExecArray | null;
    while ((em = errRe.exec(src)) !== null) {
      const [, name, codeStr] = em;
      const code = Number(codeStr);
      const expected = errorCodes.get(name);
      const line = src.slice(0, em.index).split("\n").length;
      // Anchor's own framework errors live in 2000-3999 and are not in this program's IDL
      // (AccountDiscriminatorMismatch, ConstraintSeeds, and friends). Mapping one is legitimate.
      if (expected === undefined && code >= 2000 && code < 4000) {
        continue;
      }
      if (expected === undefined) {
        findings.push({
          file: rel,
          line,
          msg: `error name \`${name}\` is not in the IDL, but is mapped to code ${code}.`,
        });
      } else if (expected !== code) {
        findings.push({
          file: rel,
          line,
          msg: `error \`${name}\` is mapped to ${code} but the IDL says ${expected}.`,
        });
      }
    }
  }

  console.log("Client / IDL parity");
  console.log(`  IDL       : ${path.relative(ROOT, IDL_PATH)}`);
  console.log(`  program   : ${idl.address}`);
  console.log(
    `  declared  : ${ixNames.size} instructions, ${accountNames.size} distinct account names, ${errorCodes.size} errors`,
  );
  console.log(`  scanned   : ${files.length} files under ${SCAN_DIRS.join(", ")}`);
  console.log();

  if (findings.length === 0) {
    console.log("PARITY OK: every instruction, account key and error code the clients use");
    console.log("exists in the committed IDL.");
    return;
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  console.error(`PARITY FAILED: ${findings.length} problem(s) in ${byFile.size} file(s).\n`);
  for (const [file, list] of [...byFile.entries()].sort()) {
    console.error(`  ${file}`);
    for (const f of list.sort((a, b) => a.line - b.line)) {
      console.error(`    :${f.line}  ${f.msg}`);
    }
  }
  console.error(
    "\nA stale client does NOT fail at build time: the method builders are cast to `any`, and",
  );
  console.error(
    "`.accounts()` is not strict in Anchor 0.31.1. It fails at signing time, in front of a user.",
  );
  process.exit(1);
}

main();
