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
_MUT_IMPLIED = ("mut", "init", "init_if_needed", "close", "realloc", "zero")
_bad = []
for _path in sorted(pathlib.Path("programs/dominion_silver_mint_v2/src/instructions").rglob("*.rs")):
    _src = _path.read_text()
    for _m in re.finditer(r"pub struct (\w+)<'info> \{(.*?)\n\}", _src, re.S):
        _name, _body = _m.group(1), _m.group(2)
        _nonmut = set()
        for _fm in re.finditer(r"((?:\s*#\[account\((?:[^()]|\([^()]*\))*\)\]\s*)?)pub (\w+):", _body):
            _attrs, _field = _fm.group(1), _fm.group(2)
            if "#[account(" not in _attrs:
                continue
            if not any(re.search(r"\b" + _k + r"\b", _attrs) for _k in _MUT_IMPLIED):
                _nonmut.add(_field)
        if not _nonmut:
            continue
        _hm = re.search(r"fn \w+\(\s*ctx: Context<" + _name + r">.*?\n\}", _src, re.S)
        if not _hm:
            continue
        _hb = _hm.group(0)
        for _field in sorted(_nonmut):
            if re.search(r"&mut ctx\.accounts\." + _field + r"\b", _hb) or \
               re.search(r"ctx\.accounts\." + _field + r"\.[a-z_]+\s*=[^=]", _hb):
                _bad.append(f"{_path.name}: {_name}.{_field} is written but not declared mut")
if _bad:
    for _b in _bad:
        print(f"   FAIL: {_b}")
    check(False, f"every written account is declared mut ({len(_bad)} violation(s))")
else:
    print("   ok: every account a handler writes is declared mut")

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
if _diags:
    for _d in _diags[:10]:
        print(f"   FAIL: {_d}")
    check(False, f"scripts/ typechecks clean ({len(_diags)} diagnostic(s))")
else:
    print("   ok: scripts/ typechecks clean")

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
