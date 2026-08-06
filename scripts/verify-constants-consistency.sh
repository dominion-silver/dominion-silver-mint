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
import json, re, sys, hashlib, pathlib

fail = []
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
    addr = json.loads(raw).get("address")
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
LIVE_PATHS += sorted(str(q) for q in pathlib.Path("scripts").glob("*.ts"))
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
