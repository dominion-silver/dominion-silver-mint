#!/usr/bin/env bash
# ASSERTS: 1-3 the program id and the IDL copies agree with `declare_id!`, 4 the app constants do too,
# 4a every account a handler writes is declared mut, 4b scripts/ typechecks with no suppression
# directives, 4c every rule in state/ is called where it must be, 5 no retired program id sits on a
# live path. Nothing else connects those copies: no compiler, no type-checker, no test.
# Deliberately anchor-free and network-free, so it stays the hard floor when `anchor idl build` is
# unavailable or flaky in CI. History: private/trimmed-notes/gates.md
#
# Usage: scripts/verify-constants-consistency.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import json
import pathlib
import re
import subprocess, re, sys, hashlib, pathlib

fail = []
def _json_or_die(raw, path):
    """Parse an IDL, or FAIL with the regeneration command. A malformed target/idl artifact is a BUILD
    fault, not an address inconsistency, and a bare json.loads kills the gate with a traceback."""
    import json as _json
    try:
        return _json.loads(raw)
    except Exception as e:
        print(f"   FAIL: {path} is not valid JSON ({e}).")
        print(f"          First 120 bytes: {raw[:120]!r}")
        print("          This is a BUILD artifact problem, not an address inconsistency.")
        print("          Regenerate it with: (cd programs/dominion_silver_mint_v2 && \\")
        print("            anchor idl build -o ../../target/idl/dominion_silver_mint.json -- --locked)")
        raise SystemExit(1)

def check(ok, msg):
    print(("   ok: " if ok else "   FAIL: ") + msg)
    if not ok:
        fail.append(msg)

B58 = r'[1-9A-HJ-NP-Za-km-z]{32,44}'

lib = pathlib.Path("programs/dominion_silver_mint_v2/src/lib.rs").read_text()
m = re.search(r'declare_id!\("(' + B58 + r')"\)', lib)
if not m:
    print("   FAIL: no declare_id! in programs/dominion_silver_mint_v2/src/lib.rs")
    sys.exit(1)
DECLARED = m.group(1)
print(f"1. declare_id! = {DECLARED}")

# A second declare_id! would make the harness's include_str! parse ambiguous: it takes the first.
n_declare = len(re.findall(r'^\s*declare_id!\("', lib, re.M))
check(n_declare == 1, f"exactly one declare_id! in the program source (found {n_declare})")

print("2. Anchor.toml")
toml = pathlib.Path("Anchor.toml").read_text()
# Only UNCOMMENTED entries count; a commented mainnet entry is the documented state.
def section_entry(cluster):
    """The active dominion_silver_mint value inside [programs.<cluster>], or None. The section body is
    isolated first, then searched anywhere within it, so a sibling key does not hide the entry."""
    m = re.search(r'^\[programs\.' + cluster + r'\]\s*$(.*?)(?=^\[|\Z)',
                  toml, re.M | re.S)
    if not m:
        return None
    for line in m.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue  # a commented entry is not active
        km = re.match(r'dominion_silver_mint\s*=\s*"(' + B58 + r')"', stripped)
        if km:
            return km.group(1)
    return None

for cluster in ("localnet", "devnet"):
    got = section_entry(cluster)
    if got is None:
        check(False, f"[programs.{cluster}] has no active dominion_silver_mint entry")
        continue
    check(got == DECLARED, f"[programs.{cluster}] == declare_id!")
# mainnet must stay absent until the mainnet ceremony (audit DOM-014).
active_mainnet = section_entry("mainnet")
if active_mainnet:
    check(active_mainnet == DECLARED, "[programs.mainnet] (present) == declare_id!")
else:
    print("   ok: [programs.mainnet] intentionally absent (DOM-014)")

print("3. IDL copies")
idls = {
    "target/idl/dominion_silver_mint.json": None,
    "apps/admin/src/lib/idl/dominion_silver_mint.json": None,
    "apps/public/src/lib/idl/dominion_silver_mint.json": None,
}
digests = {}
for path in list(idls):
    p = pathlib.Path(path)
    if not p.exists():
        # target/idl is GENERATED and gitignored, so "not built yet" is honest, not "inconsistent".
        print(f"   skip: {path} not built yet (gitignored; run anchor idl build)")
        continue
    raw = p.read_bytes()
    digests[path] = hashlib.sha256(raw).hexdigest()
    addr = _json_or_die(raw, p).get("address")
    check(addr == DECLARED, f"{path} address == declare_id!")
if len(digests) < 2:
    check(False,
          f"only {len(digests)} IDL copy present, so NOTHING was compared: the byte-identity "
          "check needs at least the two committed app copies")
if len(digests) >= 2:
    # `>= 2`, never `== 3`: with target/idl absent this is the ONLY comparison between the app copies.
    uniq = set(digests.values())
    check(len(uniq) == 1,
          f"all {len(digests)} present IDL copies are byte-identical"
          + ("" if len(uniq) == 1 else f" (got {len(uniq)} distinct digests)"))
    if len(uniq) == 1:
        print(f"        sha256 {next(iter(uniq))}")

print("4. App constants")
consts = {}
for app in ("admin", "public"):
    path = f"apps/{app}/src/lib/constants.ts"
    src = pathlib.Path(path).read_text()
    got = {}
    for name in ("PROGRAM_ID", "SILV_MINT"):
        mm = re.search(
            r'export\s+const\s+' + name + r'\s*=\s*new\s+PublicKey\(\s*"(' + B58 + r')"',
            src)
        if not mm:
            check(False, f"{path}: {name} not found")
            continue
        got[name] = mm.group(1)
    consts[app] = got
    if "PROGRAM_ID" in got:
        check(got["PROGRAM_ID"] == DECLARED, f"{path}: PROGRAM_ID == declare_id!")

a, p_ = consts.get("admin", {}), consts.get("public", {})
if "SILV_MINT" in a and "SILV_MINT" in p_:
    check(a["SILV_MINT"] == p_["SILV_MINT"],
          f"both apps agree on SILV_MINT ({a['SILV_MINT']})")
    # `initialize` creates SILV_MINT, so agreement plus this list is all an offline gate can prove.
    RETIRED_MINTS = {
        "9jM14E8kV6asGw2FwNhKk3gXQNzGhoLrJGyFZ8U7gMoF",  # gc5TW era, program closed
        "5i13gz6vGKTYhpWbMuQfiBAApfNHCxxJu2GtDGM1A2Li",  # AX7se era, program closed
    }
    check(a["SILV_MINT"] not in RETIRED_MINTS,
          "SILV_MINT is not a known-retired mint")

print("4a. Anchor account mutability")
# CLASS check: for every `#[derive(Accounts)]` struct, any field the matching handler writes must be
# declared `mut` (or init / init_if_needed / close / realloc / zero, which imply writability). Anchor
# only serialises `mut` accounts, so a write through a non-mut account is computed and then silently
# discarded: not weakened, inert, and both `cargo build` and `cargo test` stay green. Six ways to fool
# this scan, each closed below: private/trimmed-notes/gates.md
_MUT_IMPLIED = ("mut", "init", "init_if_needed", "close", "realloc", "zero")
# Comments are stripped from the attribute text, or `mut` in a comment inside `#[account(...)]` counts.
_decomment = lambda t: re.sub(r"//[^\n]*", " ", re.sub(r"/\*.*?\*/", " ", t, flags=re.S))
_bad = []
_structs = 0
_orphan_structs = []
_instr_files = sorted(pathlib.Path("programs/dominion_silver_mint_v2/src/instructions").rglob("*.rs"))
# Concatenated so a handler is found wherever it lives; a struct with no handler anywhere is a FAILURE.
_all_instr = "\n".join(_f.read_text() for _f in _instr_files)
for _path in _instr_files:
    _src = _path.read_text()
    for _m in re.finditer(r"pub struct (\w+)<'info> \{(.*?)\n\}", _src, re.S):
        _structs += 1
        _name, _body = _m.group(1), _decomment(_m.group(2))
        _nonmut = set()
        # Two levels of nested parens, so `constraint = check(f(x))` does not hide the field.
        _attr = r"(?:\s*#\[account\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\]\s*)?"
        for _fm in re.finditer(_attr + r"pub (\w+):", _body):
            _attrs, _field = _fm.group(0), _fm.group(1)
            if "#[account(" not in _attrs:
                continue
            if not any(re.search(r"\b" + _k + r"\b", _attrs) for _k in _MUT_IMPLIED):
                _nonmut.add(_field)
        if not _nonmut:
            continue
        _hm = re.search(r"fn \w+\(\s*ctx: Context<" + _name + r">.*?\n\}", _src, re.S) or \
              re.search(r"fn \w+\(\s*ctx: Context<" + _name + r">.*?\n\}", _all_instr, re.S)
        if not _hm:
            _orphan_structs.append(f"{_path.name}: {_name}")
            continue
        _hb = _decomment(_hm.group(0))
        # `&mut ctx.accounts.X.to_account_info()` is a borrow of a fresh AccountInfo, NOT a write to X.
        # Demanding `mut` for it would be an IDL/ABI change that widens write locks for every client.
        _hb = re.sub(r"&mut ctx\.accounts\.\w+\.to_account_info\(\)", " ", _hb)
        for _field in sorted(_nonmut):
            # Names may contain digits, the assignment may be `+=`, and `x.a.b = v` is a write to x.
            if re.search(r"&mut ctx\.accounts\." + _field + r"\b", _hb) or \
               re.search(r"ctx\.accounts\." + _field + r"(?:\.\w+)+\s*[-+|&^*/]?=[^=]", _hb):
                _bad.append(f"{_path.name}: {_name}.{_field} is written but not declared mut")
if _bad:
    for _b in _bad:
        print(f"   FAIL: {_b}")
    check(False, f"every written account is declared mut ({len(_bad)} violation(s))")
elif _structs == 0 or _orphan_structs:
    # SELF-CHECK: a struct pattern that stopped matching would otherwise print "ok" over an empty set.
    if _structs == 0:
        print("   FAIL: the Accounts-struct pattern matched NOTHING. The scan checked an empty set.")
    for _o in _orphan_structs:
        print(f"   FAIL: no handler found for {_o}, so its non-mut fields were never checked")
    check(False, f"the mutability scan actually scanned ({_structs} struct(s), {len(_orphan_structs)} unreadable)")
else:
    print(f"   ok: every account a handler writes is declared mut ({_structs} Accounts structs scanned)")

print("4b. scripts/ typecheck")
# Nothing else typechecks scripts/: `npx tsx script.ts` transpiles and runs, so an error on a line the
# run never reaches is invisible. tsconfig.scripts.json stubs the ONE package whose .d.ts aborts tsc on
# a parse error before it reaches this directory, which skipLibCheck does not suppress.
_tc = subprocess.run(
    ["npx", "--no-install", "tsc", "-p", "tsconfig.scripts.json"],
    capture_output=True, text=True,
)
_diags = [l for l in _tc.stdout.splitlines() if l.startswith("scripts/") and "error" in l]
# The RETURN CODE is read, not only the diagnostic lines: when tsc aborts inside node_modules nothing
# begins with "scripts/", so a lines-only check prints "ok" over a run that checked nothing.
if _tc.returncode != 0 or _diags:
    for _d in _diags[:10]:
        print(f"   FAIL: {_d}")
    if _tc.returncode != 0 and not _diags:
        print(f"   FAIL: tsc exited {_tc.returncode} with no scripts/ diagnostics, so it checked NOTHING.")
        print(f"          First tsc output: {(_tc.stdout or _tc.stderr).splitlines()[:1]}")
    check(False, f"scripts/ typechecks clean (exit {_tc.returncode}, {len(_diags)} diagnostic(s))")
else:
    print("   ok: scripts/ typechecks clean")

# The typecheck above is silenced by ONE suppression directive, so all three are banned in scripts/.
# None exists there today. If one is ever needed, fix the type instead of blinding the gate.
_suppressors = []
for _f in sorted(pathlib.Path("scripts").rglob("*.ts")):
    for _n, _line in enumerate(_f.read_text().splitlines(), 1):
        if re.search(r"@ts-(nocheck|ignore|expect-error)", _line):
            _suppressors.append(f"{_f}:{_n}: {_line.strip()[:80]}")
for _sp in _suppressors:
    print(f"   FAIL: {_sp}")
if _suppressors:
    print("          A type-check suppression in scripts/ silences the gate that exists because these")
    print("          scripts sign mainnet transactions. Fix the type instead.")
check(not _suppressors, "no @ts-nocheck / @ts-ignore / @ts-expect-error anywhere in scripts/")

print("4c. Every state rule is called, in the right place, outside test code")
# The rules are pure functions in `state/`, so the unit tests prove the RULE and nothing proved the
# HANDLER still calls it: deleting a call site left every Rust test green. Three properties make this
# fail rather than reassure: each rule declares WHICH files must call it (two call sites means both are
# named, so deleting either fails), `#[cfg(test)]` mods are stripped before looking, and the manifest
# is checked for COMPLETENESS against what `state/` declares.
_pdir = pathlib.Path("programs/dominion_silver_mint_v2/src")


def _strip_code(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    # String and char literals, so `require!(x, "call validate_kyc_subject")` proves nothing.
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    return text


def _strip_test_mods(text):
    """Remove every `#[cfg(test)] mod ... { ... }` block, brace-matched. A call MOVED INTO test code is
    not a call the program makes, and three instruction files already carry such mods."""
    out, i = [], 0
    while True:
        m = re.search(r"#\[cfg\(test\)\]\s*mod\s+\w+\s*\{", text[i:])
        if not m:
            out.append(text[i:])
            break
        out.append(text[i : i + m.start()])
        j, depth = i + m.end(), 1
        while j < len(text) and depth > 0:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        i = j
    return "".join(out)


def _prog(rel):
    return _strip_test_mods(_strip_code((_pdir / rel).read_text()))


# THE MANIFEST. rule -> every file that must call it, relative to programs/dominion_silver_mint_v2/src/.
_RULES = {
    # ---- KYC (C-02 and round 3) ----
    "validate_kyc_scope": ["instructions/admin/kyc_admin.rs"],
    "validate_kyc_arming": ["instructions/admin/kyc_admin.rs"],
    "validate_kyc_subject": ["instructions/admin/kyc_admin.rs"],
    "next_attestation_count": ["instructions/admin/kyc_admin.rs"],
    "resolve_revocation": ["instructions/admin/kyc_admin.rs"],
    "validate_kyc_operator_assignment": ["instructions/admin/kyc_admin.rs"],
    # BOTH sides. The redeem side is the one the gate is armed for first.
    "enforce_kyc": ["instructions/mint_silv.rs", "instructions/redeem_silv.rs"],
    # Called by validate_kyc_operator_assignment, not a handler. Declared for the completeness sweep.
    "kyc_operator_may_be_cleared": ["state/kyc.rs"],
    # ---- fee exemptions (C-01 and the whitelist) ----
    "validate_fee_exempt_expiry": ["instructions/admin/fee_whitelist.rs"],
    "validate_fee_exempt_flags": ["instructions/admin/fee_whitelist.rs"],
    "effective_premium_bps": ["instructions/mint_silv.rs", "instructions/redeem_silv.rs"],
    # ---- guardians ----
    "may_act": [
        "instructions/emergency/pause.rs",
        "instructions/admin/timelock.rs",
        "instructions/admin/transfer.rs",
    ],
    "may_schedule_removal": ["instructions/admin/guardian.rs"],
    "removal_schedule_expired": ["instructions/admin/guardian.rs"],
    "active_not_pending": ["state/guardian.rs"],
    "roll_window": ["instructions/redeem_silv.rs"],
    # A post-write invariant at every premium mutation site.
    "assert_premium_within_bounds": [
        "instructions/initialize.rs",
        "instructions/admin/execute.rs",
        "instructions/admin/dev.rs",
    ],
    # ---- small predicates, called from within state/ ----
    "attests": ["state/kyc.rs"],
    "exempts": ["state/fee_exempt.rs"],
    "is_expired": ["state/fee_exempt.rs"],
    "is_set_in": ["state/fee_exempt.rs", "state/kyc.rs"],
    "bit": ["state/side.rs"],
    "side_flags_valid_allow_empty": ["state/kyc.rs"],
    "side_flags_valid_nonempty": ["state/fee_exempt.rs"],
}
_missing, _absent, _uncovered = [], [], []
for _rule, _wheres in sorted(_RULES.items()):
    _decl = [
        _f
        for _f in sorted((_pdir / "state").rglob("*.rs"))
        if re.search(r"\bpub fn " + _rule + r"\s*\(", _strip_test_mods(_strip_code(_f.read_text())))
    ]
    if not _decl:
        # Renamed or retired without updating this list. A FAILURE, not a skip.
        _absent.append(_rule)
        continue
    for _where in _wheres:
        if not re.search(r"\b" + _rule + r"\s*\(", _prog(_where)):
            _missing.append(f"{_rule} is not called in {_where}")

# COMPLETENESS: every public function in state/ must be in the manifest, which catches an unwired rule.
_NOT_RULES = {
    "space",  # size helpers
    "size",
}
for _f in sorted((_pdir / "state").rglob("*.rs")):
    for _m in re.finditer(r"\bpub fn ([a-z0-9_]+)\s*\(", _strip_test_mods(_strip_code(_f.read_text()))):
        _n = _m.group(1)
        if _n in _RULES or _n in _NOT_RULES:
            continue
        _uncovered.append(f"{_n} (state/{_f.name})")
if _absent:
    print(f"   FAIL: rule(s) named here no longer exist in state/: {', '.join(_absent)}")
    print("          If a rule was renamed or genuinely retired, update _RULES in the SAME commit.")
for _mi in _missing:
    print(f"   FAIL: {_mi}")
if _missing:
    print("          A rule nothing calls is a rule that does not run. This is section 4a's class,")
    print("          one level up: present in the source, absent from the executed path.")
for _u in sorted(set(_uncovered)):
    print(f"   FAIL: {_u} is declared in state/ and absent from the 4c manifest, so nothing checks it runs")
check(
    not _absent and not _missing and not _uncovered,
    f"all {len(_RULES)} state rules are called where they must be ({sum(len(v) for v in _RULES.values())} sites)",
)

print("5. Retired program ids")
# WHEN YOU RETIRE A PROGRAM ID, ADD IT HERE IN THE SAME COMMIT. The gate cannot catch what it does not
# know, and this list has shipped one generation behind twice, each time missing the id just retired.
RETIRED = {
    "2ujQgKtxvaU9Ax3jL22374SypSyTR9J4yztqYkX23oMT": "devnet, the original Lazer deploy",
    "gc5TWUkmKpTfoL88HwsBduxbo2rZNEzhYinW7WqYaDc": "devnet 2026-07-26, CLOSED on-chain",
    "AX7seVo6Mu1j8jgipvN4dMk4erNrwdSUXNPDACYoHw2W": "devnet 2026-07-25, CLOSED on-chain",
    "GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX": "devnet, pre-Lazer",
    "J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5": "devnet, older still",
}
LIVE_PATHS = [
    "Anchor.toml",
    "apps/admin/src/lib/constants.ts",
    "apps/public/src/lib/constants.ts",
    "programs/dominion_silver_mint_v2/src/lib.rs",
]
# scripts/ is in scope: the E2E scripts that actually get run kept hardcoded id fallbacks.
LIVE_PATHS += sorted(str(q) for q in pathlib.Path("scripts").rglob("*.ts"))
# Per-app scripts dirs are GLOBBED and rglob'd, so a new or nested one is scanned the day it appears.
for _app_scripts in sorted(pathlib.Path(".").glob("apps/*/scripts")):
    LIVE_PATHS += sorted(str(q) for q in _app_scripts.rglob("*.ts"))
found_retired = False
for path in LIVE_PATHS:
    src = pathlib.Path(path).read_text()
    for rid, why in RETIRED.items():
        # A retired id in a comment is a historical note; "*" catches block-comment continuation lines.
        offenders = [ln for ln in src.splitlines()
                     if rid in ln and not ln.strip().startswith(("//", "#", "*", "/*"))]
        if offenders:
            found_retired = True
            check(False, f"{path} references retired id {rid} ({why}) on a live line")
if not found_retired:
    print("   ok: no retired id on an active line in the files that drive deploys")

print()
if fail:
    print(f"CONSTANTS INCONSISTENT: {len(fail)} problem(s). Fix before deploying.")
    sys.exit(1)
print("CONSTANTS OK: every hand-copied address agrees with declare_id!.")
PY
