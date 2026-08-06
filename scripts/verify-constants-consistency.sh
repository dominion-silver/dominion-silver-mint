#!/usr/bin/env bash
# Assert that every hand-copied address in this repo agrees with declare_id!.
#
# WHY THIS EXISTS. The program id and the SILV mint are duplicated across six places
# that no compiler, type-checker or test connects:
#
#   programs/dominion_silver_mint_v2/src/lib.rs   declare_id!            (the truth)
#   Anchor.toml                                    [programs.localnet], [programs.devnet]
#   target/idl/dominion_silver_mint.json           address
#   apps/admin/src/lib/constants.ts                PROGRAM_ID, SILV_MINT
#   apps/public/src/lib/constants.ts               PROGRAM_ID, SILV_MINT
#   apps/{admin,public}/src/lib/idl/*.json         address  (bundled copies)
#
# This drift has already bitten this project three times: Anchor.toml pointed at a
# retired id (audit DOM-014), all three IDLs went stale at once, and the Lazer harness
# silently held a dead id and reported the oracle CPI as broken. The audit review of
# daac4ac noted that after all those fixes there was STILL nothing asserting the six
# sources agree, so a commit repointing an app at the wrong program (or an attacker's)
# passed the entire blocking gate green.
#
# Deliberately anchor-free and network-free, so it can be the gate's hard floor even
# when `anchor idl build` is unavailable or flaky in CI.
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
    """REVIEW-OF-FIXES P0: this was a bare json.loads, and a malformed target/idl artifact made the whole
    gate die with an uncaught JSONDecodeError. That is exactly what happened on CI: the workflow
    redirected `anchor idl build` STDOUT into the file, cargo's "Downloaded <crate>" lines landed at the
    top on a cache miss, and this line raised `Expecting value: line 1 column 3 (char 2)`. The gate has
    never passed on CI, so nothing after it ever ran.

    The redirect is fixed at the source (the workflow uses `-o` now), but a gate must not report an
    infrastructure fault as a constants inconsistency, and must not report it as a traceback."""
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

# ---- the source of truth ----
lib = pathlib.Path("programs/dominion_silver_mint_v2/src/lib.rs").read_text()
m = re.search(r'declare_id!\("(' + B58 + r')"\)', lib)
if not m:
    print("   FAIL: no declare_id! in programs/dominion_silver_mint_v2/src/lib.rs")
    sys.exit(1)
DECLARED = m.group(1)
print(f"1. declare_id! = {DECLARED}")

# A second declare_id! would make the harness's include_str! parse ambiguous
# (it takes the first match).
n_declare = len(re.findall(r'^\s*declare_id!\("', lib, re.M))
check(n_declare == 1, f"exactly one declare_id! in the program source (found {n_declare})")

# ---- Anchor.toml ----
print("2. Anchor.toml")
toml = pathlib.Path("Anchor.toml").read_text()
# Only UNCOMMENTED entries count; a commented mainnet entry is the documented state.
def section_entry(cluster):
    """The active dominion_silver_mint value inside [programs.<cluster>], or None.

    Review-of-fixes F10: the previous regex required dominion_silver_mint to be the
    section's FIRST non-comment line, so adding any sibling key (mock_lazer, say)
    made the gate report "no active entry" while the entry was present and correct.
    Now the section body is isolated first and searched anywhere within it.
    """
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

# ---- IDLs ----
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
        # Review-of-fixes F8: a missing generated IDL used to FAIL here, which made
        # this script strictly downstream of `anchor idl build` while its own header
        # claimed to be the anchor-free hard floor. target/idl is gitignored and only
        # exists after a build, so on a fresh checkout the honest answer is "not
        # built yet", not "inconsistent". The COMMITTED app copies are still checked.
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
    # WAS `== 3`. target/idl is GENERATED and gitignored, so on a fresh checkout only the two
    # committed app copies exist, and the check silently did not run at all. Since it is the ONLY
    # comparison between apps/admin and apps/public (each is otherwise checked for its `address`
    # field alone), skipping it meant the two app IDLs were compared to nothing.
    uniq = set(digests.values())
    # Report the ACTUAL count, not a hardcoded "three". With target/idl absent this printed
    # "all three IDL copies are byte-identical" after comparing two, which is the kind of
    # overclaim in a green check that stops anyone looking.
    check(len(uniq) == 1,
          f"all {len(digests)} present IDL copies are byte-identical"
          + ("" if len(uniq) == 1 else f" (got {len(uniq)} distinct digests)"))
    if len(uniq) == 1:
        print(f"        sha256 {next(iter(uniq))}")

# ---- app constants ----
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
    # SILV_MINT cannot be derived from anything: it is created by `initialize` and
    # only the live config knows it. The most this offline gate can prove is that the
    # two apps agree and that the value is not a known-retired mint.
    # Review-of-fixes F2: same staleness. SILV_MINT cannot be derived from anything,
    # so this list is the ONLY check on it, and it was one generation behind.
    RETIRED_MINTS = {
        "9jM14E8kV6asGw2FwNhKk3gXQNzGhoLrJGyFZ8U7gMoF",  # gc5TW era, program closed
        "5i13gz6vGKTYhpWbMuQfiBAApfNHCxxJu2GtDGM1A2Li",  # AX7se era, program closed
    }
    check(a["SILV_MINT"] not in RETIRED_MINTS,
          "SILV_MINT is not a known-retired mint")

# ---- retired program ids must not appear on any live path ----
print("4a. Anchor account mutability")
# ROUND 3 P0-2, and this is the CLASS check, not the instance.
#
# `attest_kyc` incremented `config.kyc_attestation_count` while its `config` account was declared WITHOUT
# `mut`. Anchor only serialises `mut` accounts back to the chain, so the increment was computed and silently
# discarded: the counter stayed at 0 forever and the KYC gate could never be armed. The mechanism was not
# weakened, it was inert.
#
# Nothing caught it. `cargo build` is happy, `cargo test` is happy (the six tests I wrote exercise the pure
# RULE, never the handler), and no gate looked at the relationship between an Accounts struct and the
# handler that writes through it. A pure-function test proves an implication; it never proves its premise
# is reachable.
#
# So: for every `#[derive(Accounts)]` struct, any field the matching handler writes must be declared
# `mut`, or `init`/`init_if_needed`/`close`/`realloc`, all of which imply writability.
#
# REVIEW-OF-FIXES P2. The reviewer lifted this scan out and ran it against synthetic cases. It catches the
# baseline shape and MISSED the same bug in six others, each closed below and named where it is closed. None
# of the six is present in the tree today (measured: 0 compound writes, 0 two-level writes, 0
# `&mut ...to_account_info()`, 49/49 handlers in the same file as their struct), so these are LATENT holes.
# They are worth closing anyway, for the same reason the section exists: the P0 it was built for was a
# handler and a struct disagreeing, and a scan that only sees one spelling of "writes" will be believed.
_MUT_IMPLIED = ("mut", "init", "init_if_needed", "close", "realloc", "zero")
# HOLE 1: `_MUT_IMPLIED` was matched against the RAW attribute text, so the word `mut` in a comment INSIDE
# `#[account(...)]` satisfied it. A gate satisfiable by prose is the exact failure the sibling gate in the
# same commit had just fixed, so it is stripped here too.
_decomment = lambda t: re.sub(r"//[^\n]*", " ", re.sub(r"/\*.*?\*/", " ", t, flags=re.S))
_bad = []
_structs = 0
_orphan_structs = []
_instr_files = sorted(pathlib.Path("programs/dominion_silver_mint_v2/src/instructions").rglob("*.rs"))
# HOLE 2: the handler was looked for in the SAME FILE as the struct, and `if not _hm: continue` skipped
# silently when it was elsewhere. Every source is concatenated so a handler can be found wherever it lives,
# and a struct whose handler cannot be found anywhere is now a FAILURE rather than a silent skip.
_all_instr = "\n".join(_f.read_text() for _f in _instr_files)
for _path in _instr_files:
    _src = _path.read_text()
    for _m in re.finditer(r"pub struct (\w+)<'info> \{(.*?)\n\}", _src, re.S):
        _structs += 1
        _name, _body = _m.group(1), _decomment(_m.group(2))
        _nonmut = set()
        # HOLE 3: `\s*` between the attribute and `pub field:` failed when a DOC COMMENT sat between them,
        # and the field was then skipped as if it had no attribute at all. Comments are stripped above, which
        # closes it; the pattern also tolerates the residual whitespace either way.
        # HOLE 4: the attribute pattern handled ONE level of nested parens, so a constraint like
        # `constraint = check(f(x))` made the field invisible. Two levels now.
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
        # HOLE 5: `&mut ctx.accounts.X.to_account_info()` is NOT a write to X, it is a borrow of a freshly
        # built AccountInfo. Reporting it demanded `#[account(mut)]`, which is an IDL/ABI change that marks
        # the account writable for every client and widens write locks. A gate that pressures an ABI change
        # to satisfy a regex is a gate that gets allowlisted, so that shape is excluded before matching.
        _hb = re.sub(r"&mut ctx\.accounts\.\w+\.to_account_info\(\)", " ", _hb)
        for _field in sorted(_nonmut):
            # HOLE 6: the member name was `[a-z_]+`, which cannot match a digit (`token_2022_program`
            # exists in this tree), the assignment had to be a bare `=` so `+=` / `|=` / `-=` were
            # invisible, and only ONE level of member access was considered so `x.a.b = v` was missed.
            if re.search(r"&mut ctx\.accounts\." + _field + r"\b", _hb) or \
               re.search(r"ctx\.accounts\." + _field + r"(?:\.\w+)+\s*[-+|&^*/]?=[^=]", _hb):
                _bad.append(f"{_path.name}: {_name}.{_field} is written but not declared mut")
if _bad:
    for _b in _bad:
        print(f"   FAIL: {_b}")
    check(False, f"every written account is declared mut ({len(_bad)} violation(s))")
elif _structs == 0 or _orphan_structs:
    # SELF-CHECK, and it is count-free on purpose: no floor to maintain, just "the scan found structs, and
    # every struct it found has a handler it could read". Without this, a struct pattern that stopped
    # matching printed "ok" over an empty set, which is the class this whole section exists to catch.
    if _structs == 0:
        print("   FAIL: the Accounts-struct pattern matched NOTHING. The scan checked an empty set.")
    for _o in _orphan_structs:
        print(f"   FAIL: no handler found for {_o}, so its non-mut fields were never checked")
    check(False, f"the mutability scan actually scanned ({_structs} struct(s), {len(_orphan_structs)} unreadable)")
else:
    print(f"   ok: every account a handler writes is declared mut ({_structs} Accounts structs scanned)")

print("4b. scripts/ typecheck")
# ROUND 3 P0-1 shipped because NOTHING typechecked scripts/. A five-argument call to a six-argument
# function sat in T1's hostile-mint case, so the ceremony could not compile, and `npx tsx script.ts`
# does not typecheck: it transpiles and runs, and the error was on a line the run never reached.
#
# My own attempts reported zero diagnostics and exit 0. They were checking nothing: tsc aborts on PARSE
# errors inside a nested node_modules .d.ts before it reaches this directory, and skipLibCheck does not
# suppress parse errors. tsconfig.scripts.json stubs that ONE package so the run gets that far.
_tc = subprocess.run(
    ["npx", "tsc", "-p", "tsconfig.scripts.json"],
    capture_output=True, text=True,
)
_diags = [l for l in _tc.stdout.splitlines() if l.startswith("scripts/") and "error" in l]
# REVIEW-OF-FIXES P0. `_tc.returncode` was never read, so this gate reproduced the EXACT false green it was
# installed to close. When tsc aborts on a parse error inside node_modules there are no lines beginning with
# "scripts/", `_diags` is empty, and the gate printed "ok: scripts/ typechecks clean" over a run that checked
# nothing. Measured by the reviewer: returncode 2, 160 tsc error lines, 0 of them matching, gate green.
#
# The trigger is routine rather than exotic: the ROOT package.json pins typescript ^4.3.5 and resolves 4.9.5
# while both apps pin ^5.5.0, and 4.9.5 cannot parse `<const T>`. Any dependency bump that lands another
# modern .d.ts aborts the run again.
#
# The commit that added this said "Mutation-verified: reverting the sixth argument produces TS2554". That
# proved the POSITIVE branch only, which is the same error the same commit message spends six lines
# diagnosing: proving an implication without proving its premise is reachable.
if _tc.returncode != 0 or _diags:
    for _d in _diags[:10]:
        print(f"   FAIL: {_d}")
    if _tc.returncode != 0 and not _diags:
        print(f"   FAIL: tsc exited {_tc.returncode} with no scripts/ diagnostics, so it checked NOTHING.")
        print(f"          First tsc output: {(_tc.stdout or _tc.stderr).splitlines()[:1]}")
    check(False, f"scripts/ typechecks clean (exit {_tc.returncode}, {len(_diags)} diagnostic(s))")
else:
    print("   ok: scripts/ typechecks clean")

# REVIEW-OF-FIXES, second round: the typecheck is silenced by ONE line. The reviewer added `// @ts-nocheck`
# plus an undeclared call and a type error to `t1-hostile-bootstrap.ts` (the exact file whose 5-arg call to a
# 6-arg function WAS round 3 P0-1) and the gate printed "ok: scripts/ typechecks clean". The commit closed
# "tsc aborted before it got here" and left "tsc was told not to look" wide open.
#
# None of these directives exists in scripts/ today, which is why banning them costs nothing. If one is ever
# genuinely needed, the right move is to fix the type or narrow the suppression to a single expression, not to
# blind the only gate that reads this directory.
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
# REVIEW-OF-FIXES P1, measured by the reviewer and reproduced here: the five WIRING-level mutations of the
# round-3 contract fixes each left all 153 Rust tests green.
#
#   delete `validate_kyc_revocation(...)` from the handler   -> 153 passed
#   delete `validate_kyc_subject(wallet)` from the handler   -> 153 passed
#   `next_attestation_count(.., is_new)` -> `(.., true)`     -> 153 passed
#
# The rules are pure functions in `state/`, unit-tested to death, and the tests prove the RULE. Nothing
# proved the HANDLER still calls it. That is the same shape as the P0 in section 4a (a mechanism present in
# the source and absent from the executed path), so it gets the same treatment: a class check.
#
# REVIEW-OF-FIXES, SECOND ROUND. My first version of this section asserted only that each name appeared in a
# call position SOMEWHERE under instructions/, and the reviewer defeated it three ways:
#
#   1. `enforce_kyc` has TWO call sites. Deleting the REDEEM-side gate (the side C-02 is armed for first)
#      left 4c green because mint_silv.rs still calls it.
#   2. Moving `validate_kyc_subject(wallet)?` out of the handler into a `#[cfg(test)] mod` in the same file
#      left 4c green. Those mods already exist in three instruction files.
#   3. The list named 8 of ~16 rule-shaped functions. Deleting `validate_fee_exempt_expiry` from
#      fee_whitelist.rs left 4c green, and `assert_premium_within_bounds` was declared and called by
#      NOTHING, which is precisely the orphan this section is for.
#
# So: each rule declares WHICH files must call it, `#[cfg(test)]` mods are stripped before looking, and the
# manifest is checked for COMPLETENESS against what `state/` actually declares. That last part is what stops
# the list from silently shrinking, which is how section 5 failed twice.
_pdir = pathlib.Path("programs/dominion_silver_mint_v2/src")


def _strip_code(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    # String and char literals, so `require!(x, "call validate_kyc_subject")` proves nothing.
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    return text


def _strip_test_mods(text):
    """Remove every `#[cfg(test)] mod ... { ... }` block, brace-matched.

    Hole 2 above: a call that has been MOVED INTO test code is not a call the program makes, and three
    instruction files already carry such mods, so this is a live shape rather than a contrived one.
    """
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


# THE MANIFEST. rule -> every file that must call it. A rule with two call sites names both, so deleting
# either one fails. Paths are relative to programs/dominion_silver_mint_v2/src/.
_RULES = {
    # ---- KYC (C-02 and round 3) ----
    "validate_kyc_scope": ["instructions/admin/kyc_admin.rs"],
    "validate_kyc_arming": ["instructions/admin/kyc_admin.rs"],
    "validate_kyc_subject": ["instructions/admin/kyc_admin.rs"],
    "next_attestation_count": ["instructions/admin/kyc_admin.rs"],
    "resolve_revocation": ["instructions/admin/kyc_admin.rs"],
    "validate_kyc_operator_assignment": ["instructions/admin/kyc_admin.rs"],
    # BOTH sides. The redeem side is the one the gate is armed for first, and it was the deletable one.
    "enforce_kyc": ["instructions/mint_silv.rs", "instructions/redeem_silv.rs"],
    # Called by validate_kyc_operator_assignment, not by a handler. Declared here so the completeness sweep
    # below does not report it, and so moving it into a handler is a deliberate edit to this line.
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
    # ---- redeem budget ----
    "roll_window": ["instructions/redeem_silv.rs"],
    # ---- premiums ----
    # Was ORPHANED. Now a post-write invariant at all four premium mutation sites.
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
        # Renamed or retired without updating this list. A FAILURE, not a skip: silently dropping unknown
        # names is exactly how a gate shrinks to checking nothing.
        _absent.append(_rule)
        continue
    for _where in _wheres:
        if not re.search(r"\b" + _rule + r"\s*\(", _prog(_where)):
            _missing.append(f"{_rule} is not called in {_where}")

# COMPLETENESS: every public function declared in state/ must appear in the manifest. This is what catches a
# newly added rule that nothing wires up, and it is the check whose absence let `assert_premium_within_bounds`
# sit orphaned. `_NOT_RULES` is for genuine non-rules (constructors, size helpers); keep it short and justified.
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
# Review-of-fixes F1: this list was STALE ON THE COMMIT THAT INTRODUCED IT. gc5TW,
# the id that commit retired, was missing, so a wholesale self-consistent regression
# to the only realistically reachable dead id passed with "CONSTANTS OK". Section 5
# exists precisely to catch that. WHEN YOU RETIRE AN ID, ADD IT HERE IN THE SAME
# COMMIT: the check is worthless one generation behind.
RETIRED = {
    # Review-of-fixes F1 again, and the lesson did not stick the first time: this list
    # was missing 2ujQg, and scripts/e2e-lazer-mint.ts still pointed at it. The gate
    # cannot catch what it does not know. ADD THE ID IN THE SAME COMMIT THAT RETIRES IT.
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
# Review-of-fixes F6: scripts/ was outside this check, so the three E2E scripts that
# actually get run kept a hardcoded id fallback and no gate could see it. This repo
# has rotated ids four times in two weeks and every rotation left stale hardcodes.
LIVE_PATHS += sorted(str(q) for q in pathlib.Path("scripts").rglob("*.ts"))
# AUDIT FINDING P-06: `apps/public/scripts/` was outside this check, and EIGHT of the ten scripts in it
# hardcoded the retired program id J9cw. The id was already in RETIRED above, so the gate KNEW it and
# simply never opened the files. `npm run test:auto` ran one of them. That whole directory is deleted
# now, but the blind spot is what needs closing, not the instance: any per-app scripts directory added
# later must be scanned from the day it appears, not after the next rotation leaves stale hardcodes in
# it. Globbed rather than listed for exactly that reason.
# rglob, not glob: both were one directory deep, so a re-introduced apps/public/scripts/lib/foo.ts
# or scripts/e2e/foo.ts stayed invisible. Same blind spot as P-06, one level down.
for _app_scripts in sorted(pathlib.Path(".").glob("apps/*/scripts")):
    LIVE_PATHS += sorted(str(q) for q in _app_scripts.rglob("*.ts"))
found_retired = False
for path in LIVE_PATHS:
    src = pathlib.Path(path).read_text()
    for rid, why in RETIRED.items():
        # A retired id inside a comment is a historical note and is fine.
        # "*" catches block-comment continuation lines (/** ... */), which are
        # historical notes, not live code. Without it the gate cries wolf and gets
        # ignored, which is worse than not having it.
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
