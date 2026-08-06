#!/usr/bin/env bash
# Gate: refuse to deploy an artifact that was not built from this source with the
# default feature set.
#
# WHY THIS EXISTS (audit finding A-33, demonstrated 2026-07-25). The Lazer harness
# reads target/deploy/dominion_silver_mint.so, and its tests only pass when that
# path is built with `--features test-harness`, which compiles the
# `probe_oracle_price` instruction into it. tools/lazer-harness/run.sh restores the
# default build afterwards, but a manual run, or a test failure under `set -e`,
# leaves a contaminated binary at exactly the path `solana program deploy` reads.
# The `dev-hatch` feature is worse: `dev_set_premiums` and `dev_set_max_staleness`
# mutate config with NO timelock.
#
# HOW THIS SCRIPT GOT HERE. Three earlier designs were each defeated, which is
# recorded because the lesson is the point: this repository's core CI problem is
# a gate that cannot fail.
#   v1: matched snake_case symbols only. Anchor emits the PascalCase instruction
#       name via msg!("Instruction: X") and the Rust fn name is optimized out, so
#       a dev-hatch build passed with "ARTIFACT OK". The probe was caught only by
#       accident, because ProbeOraclePrice happened to be listed too.
#   v2: added PascalCase. Still defeated by the crate's own `no-log-ix-name`
#       feature, which strips those msg! strings entirely, plus a latent
#       SIGPIPE fail-open: `strings f | grep -q X` under `set -euo pipefail`
#       returns 141 when grep exits early and strings dies of SIGPIPE, which the
#       `if` reads as "not found".
#   v3: matched the 8-byte Anchor discriminators, on the theory that dispatch
#       needs them so no feature could strip them. MEASURED AND FALSE: the
#       compiler does not keep them as contiguous byte sequences. Verified that
#       even `initialize`'s discriminator is absent from a known-good binary, so
#       that check would have rejected everything.
#   v4 (this one): the primary gate is a REPRODUCIBLE REBUILD. Rebuild from the
#       working tree with the default feature set into an isolated directory and
#       compare hashes. That catches every contamination, including
#       `no-log-ix-name`, without needing to know which symbol to look for. The
#       string scan is kept as a fast secondary signal only.
#
# Usage: scripts/verify-release-artifact.sh [path-to-so] [path-to-idl]
#   --skip-rebuild   only run the secondary checks (faster, weaker: use in a
#                    loop, never as the pre-deploy gate)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/programs/dominion_silver_mint_v2/Cargo.toml"
SKIP_REBUILD=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--skip-rebuild" ]]; then SKIP_REBUILD=1; else ARGS+=("$a"); fi
done
SO="${ARGS[0]:-$ROOT/target/deploy/dominion_silver_mint.so}"
IDL="${ARGS[1]:-$ROOT/target/idl/dominion_silver_mint.json}"
LIB_RS="$ROOT/programs/dominion_silver_mint_v2/src/lib.rs"

FORBIDDEN_IX=(probe_oracle_price dev_set_max_staleness dev_set_premiums)

echo "Verifying release artifact"
echo "  so:  $SO"
echo "  idl: $IDL"
echo

if [[ ! -f "$SO" ]]; then
  echo "FAIL: .so not found at $SO"
  echo "Build it: cargo build-sbf --manifest-path $MANIFEST"
  exit 1
fi

fail=0

# ---- 1. Primary gate: reproducible rebuild with default features ----
if [[ "$SKIP_REBUILD" -eq 1 ]]; then
  echo "1. Reproducible rebuild: SKIPPED (--skip-rebuild). This is the only check"
  echo "   that catches a no-log-ix-name build. Do not skip it before a deploy."
else
  echo "1. Reproducible rebuild with the default feature set"
  TMPDIR_BUILD="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_BUILD"' EXIT
  # AUDIT review of daac4ac (P1): --sbf-out-dir only changes where the FINAL .so is
  # copied. Compilation still used the shared target/ dir, which CI restores from
  # actions/cache under a key that hashes only Cargo.lock. A stale or tampered rlib
  # in that cache would be linked into both the artifact AND its "clean reference",
  # so the hashes would agree and this gate would pass. The reference build now gets
  # its own CARGO_TARGET_DIR and shares no intermediate objects with the artifact
  # under test. Costs a full cold rebuild; that is the point.
  if ! CARGO_TARGET_DIR="$TMPDIR_BUILD/target" \
      cargo build-sbf --manifest-path "$MANIFEST" --sbf-out-dir "$TMPDIR_BUILD" -- --locked >"$TMPDIR_BUILD/build.log" 2>&1; then
    echo "   FAIL: the default-feature rebuild did not succeed"
    tail -5 "$TMPDIR_BUILD/build.log" | sed 's/^/     /'
    exit 1
  fi
  REF="$TMPDIR_BUILD/dominion_silver_mint.so"
  if [[ ! -f "$REF" ]]; then
    echo "   FAIL: rebuild produced no artifact at $REF"
    exit 1
  fi
  h_have="$(shasum -a 256 "$SO" | awk '{print $1}')"
  h_ref="$(shasum -a 256 "$REF" | awk '{print $1}')"
  if [[ "$h_have" != "$h_ref" ]]; then
    echo "   FAIL: the artifact does NOT match a clean default-feature rebuild."
    echo "     artifact: $h_have"
    echo "     rebuild:  $h_ref"
    echo "   The artifact was built with extra features, from different source, or"
    echo "   with a different toolchain. Do not deploy it."
    fail=1
  else
    echo "   ok: byte-identical to a clean default rebuild ($h_ref)"
  fi
fi

# ---- 2. Secondary: forbidden name strings (no pipeline, so no SIGPIPE) ----
echo "2. Forbidden instruction names as strings (secondary signal)"
( python3 - "$SO" "${FORBIDDEN_IX[@]}" <<'PY'
import sys
blob = open(sys.argv[1], "rb").read()
bad = []
for name in sys.argv[2:]:
    pascal = "".join(p.capitalize() for p in name.split("_"))
    for probe in (name, pascal):
        if blob.find(probe.encode()) != -1:
            print(f"   FAIL: string '{probe}' present in the binary")
            bad.append(probe)
if not bad:
    print("   ok: none of the forbidden names appear")
sys.exit(1 if bad else 0)
PY
# Review-of-fixes F9: was `[[ $? -eq 0 ]] || fail=1`, dead under `set -e`.
) || fail=1

# ---- 3. IDL must exist and must not advertise the forbidden instructions ----
echo "3. IDL"
if [[ ! -f "$IDL" ]]; then
  # A missing IDL is a FAILURE, not a skip: an unverifiable IDL is not a pass.
  echo "   FAIL: IDL not found at $IDL"
  echo "   regenerate: (cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked)"
  fail=1
else
  # AUDIT review of daac4ac (P1): this used to only PRINT idl.address. An IDL that
  # describes a different program is exactly the drift that ships a console pointed
  # at the wrong deployment, so it is now asserted against declare_id!.
  ( python3 - "$IDL" "$LIB_RS" "${FORBIDDEN_IX[@]}" <<'PY'
import json, re, sys
idl = json.load(open(sys.argv[1]))
src = open(sys.argv[2]).read()
names = [i["name"] for i in idl.get("instructions", [])]
bad = [n for n in sys.argv[3:] if n in names]
for n in bad:
    print(f"   FAIL: '{n}' is present in the IDL")
if not bad:
    print(f"   ok: {len(names)} instructions, none forbidden")

m = re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', src)
if not m:
    print("   FAIL: could not find declare_id! in the program source")
    sys.exit(1)
declared, addr = m.group(1), idl.get("address")
if addr != declared:
    print(f"   FAIL: idl address {addr} != declare_id! {declared}")
    bad.append("address-mismatch")
else:
    print(f"   ok: idl address == declare_id! ({declared})")
sys.exit(1 if bad else 0)
PY
  # Review-of-fixes F9: this used to be `[[ $? -eq 0 ]] || fail=1`, which is dead code
  # under `set -e`: the script died the instant the heredoc python exited non-zero, so
  # $? was never observed, the `fail` accumulator never fired, and the operator saw
  # ONE finding instead of all of them. `|| fail=1` on the command itself is what
  # actually suppresses errexit and accumulates.
  ) || fail=1
fi

echo "4. Release record"
echo "   sha256: $(shasum -a 256 "$SO" | awk '{print $1}')"
echo "   bytes:  $(wc -c < "$SO" | tr -d ' ')"
echo
if [[ "$fail" -ne 0 ]]; then
  echo "ARTIFACT REJECTED. Rebuild with the default feature set:"
  echo "  cargo build-sbf --manifest-path $MANIFEST"
  echo "  (cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked)"
  exit 1
fi
# AUDIT FINDING S-06. This line used to be unconditional, so
# `verify-release-artifact.sh --skip-rebuild` exited 0 while claiming "matches a clean default
# rebuild" when no rebuild had happened. The warning printed 100 lines earlier does not travel: what
# gets pasted into a release checklist is the LAST line. And this file's own header records that a
# dev-hatch build once passed with "ARTIFACT OK", so this exact confusion has already cost something.
#
# The message now states what was actually proven, and skipping the rebuild is no longer reported as
# a pass at all: it exits 2, which is neither the 0 a checklist wants nor the 1 of a real rejection.
if [[ "$SKIP_REBUILD" -eq 1 ]]; then
  echo "ARTIFACT PARTIALLY CHECKED: the secondary scans found no forbidden instruction,"
  echo "but the reproducible rebuild was SKIPPED, so this is NOT a release attestation."
  echo "A binary built with a feature flag can pass everything above. Re-run without"
  echo "--skip-rebuild before any deploy."
  exit 2
fi
# REVIEW-OF-FIXES P2, and this deletes a class rather than an instance. The runbook carried the release
# hash INLINE, and it went stale three times: twice within the hour of the commit that changed the program.
# A number maintained by hand in two places disagrees with itself. So `config/mainnet-authorities.json` is
# the only copy, and no document may reintroduce one: a bare 64-hex string in docs/ is now a hard failure,
# whether or not it happens to be correct today, because "correct today" is exactly what the last three were.
_stray=$(grep -rnoE "\b[0-9a-f]{64}\b" docs/*.md 2>/dev/null || true)
if [ -n "$_stray" ]; then
  echo ""
  echo "FAIL: a bare sha256 appears in docs/. The release hash has ONE home:"
  echo "      config/mainnet-authorities.json -> release_artifact.sha256"
  echo "      Replace the literal with a pointer to that file plus 'bash scripts/verify-release-artifact.sh'."
  echo "$_stray"
  exit 1
fi

echo "ARTIFACT OK: matches a clean default rebuild, no forbidden instruction."
