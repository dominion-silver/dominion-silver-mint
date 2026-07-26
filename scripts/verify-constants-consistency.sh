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
for cluster in ("localnet", "devnet"):
    mm = re.search(
        r'^\[programs\.' + cluster + r'\]\s*\n(?:^\s*#.*\n)*^\s*dominion_silver_mint\s*=\s*"(' + B58 + r')"',
        toml, re.M)
    if not mm:
        check(False, f"[programs.{cluster}] has no active dominion_silver_mint entry")
        continue
    check(mm.group(1) == DECLARED, f"[programs.{cluster}] == declare_id!")
# mainnet must stay absent until the mainnet ceremony (audit DOM-014).
active_mainnet = re.search(
    r'^\[programs\.mainnet\]\s*\n(?:^\s*#.*\n)*^\s*dominion_silver_mint\s*=\s*"(' + B58 + r')"',
    toml, re.M)
if active_mainnet:
    check(active_mainnet.group(1) == DECLARED,
          "[programs.mainnet] (present) == declare_id!")
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
        check(False, f"{path} is missing")
        continue
    raw = p.read_bytes()
    digests[path] = hashlib.sha256(raw).hexdigest()
    addr = json.loads(raw).get("address")
    check(addr == DECLARED, f"{path} address == declare_id!")
if len(digests) == 3:
    uniq = set(digests.values())
    check(len(uniq) == 1,
          "all three IDL copies are byte-identical"
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
    RETIRED_MINTS = {"5i13gz6vGKTYhpWbMuQfiBAApfNHCxxJu2GtDGM1A2Li"}
    check(a["SILV_MINT"] not in RETIRED_MINTS,
          "SILV_MINT is not a known-retired mint")

# ---- retired program ids must not appear on any live path ----
print("5. Retired program ids")
RETIRED = {
    "AX7seVo6Mu1j8jgipvN4dMk4erNrwdSUXNPDACYoHw2W": "devnet 2026-07-13",
    "GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX": "devnet, pre-Lazer",
    "J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5": "devnet, older still",
}
LIVE_PATHS = [
    "Anchor.toml",
    "apps/admin/src/lib/constants.ts",
    "apps/public/src/lib/constants.ts",
    "programs/dominion_silver_mint_v2/src/lib.rs",
]
found_retired = False
for path in LIVE_PATHS:
    src = pathlib.Path(path).read_text()
    for rid, why in RETIRED.items():
        # A retired id inside a comment is a historical note and is fine.
        offenders = [ln for ln in src.splitlines()
                     if rid in ln and not ln.strip().startswith(("//", "#"))]
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
