/**
 * Cross-reference what the CLIENTS call against what the IDL declares: every `.methods` chain names a
 * real instruction, every `.accounts({...})` key is an account of SOME instruction, every
 * `("ErrorName", 12345)` pair matches the IDL's code, and no removed instruction name appears in a
 * call position. A stale client does not fail at build time, because the method builders are cast to
 * `any` and `.accounts` is not strict in Anchor 0.31.1 (it delegates to `accountsPartial` and
 * derives a missing account from the IDL seeds); it fails at signing time, in front of a user.
 * It does NOT prove an account list is COMPLETE: it cannot tell which instruction a given
 * `.accounts({...})` belongs to. apps/public/src/lib/__tests__/contract-parity.test.ts asserts the
 * exact per-instruction sets. Run: npx tsx scripts/verify-client-idl-parity.ts
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..");
// A GENERATED, gitignored artifact: nothing here derives the IDL from `programs/**`, so locally this is
// only as fresh as your last build. On CI the regenerate step runs first and diffs both committed copies.
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
      // Skip THIS file: its own denylist carries the removed instruction names as string literals.
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

  // Names this project has REMOVED, listed explicitly because check 2 only sees a chain it managed to
  // parse. Anything here is a hard failure wherever it appears in a call position.
  const REMOVED = [
    "redeemSilvQueued",
    "claimRedemption",
    "adminSettleRedemptionOffchain",
    "closeSettledRedemption",
    // Deleted, not restricted: `initialize` binds the pre-mint destination atomically
    // and the only remaining writer is the 24h-timelocked pair. A client still calling this would
    // send eight bytes the dispatcher no longer answers, and the operator would read the failure as
    // an outage rather than as a removed capability.
    "setInventoryWallet",
  ];

  const files = SCAN_DIRS.flatMap((d) => walk(d));
  const findings: Finding[] = [];

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    // Blank out comments first, PRESERVING line numbers and length so every offset below still maps to
    // the real file. Prose here names the removed instructions, so a gate that read it would cry wolf.
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
    // `.methods` (optionally `as any)`) followed IMMEDIATELY by `.name(`, whitespace only in between.
    // Deliberately narrow: any characters in the gap matched the next link (`.accountsPartial(`), so it
    // under-reports rather than over-reports, and check 1 plus the unit tests cover the difference.
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
      // Top-level `key:` only. Spreads and nested objects are skipped rather than half-parsed.
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
    // ANY CamelCase identifier paired with a code, never a suffix allowlist: the allowlist this
    // replaced silently skipped five live mappings while claiming to check every error code the
    // clients use. Insert a variant before StaleOracle and a stale client shows a raw Custom dump.
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
