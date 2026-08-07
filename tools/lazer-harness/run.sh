#!/usr/bin/env bash
# Hermetic runner for the Lazer behavioral harness. Builds BOTH SBF artifacts with
# the correct features into target/harness, asserts the probe IS present there, runs
# the litesvm suite, then asserts target/deploy is still probe-free.
#
# It does NOT rebuild target/deploy: since the harness stopped writing there, there
# is nothing to restore. (An earlier version of this header still claimed it did.)
#
# AUDIT review of daac4ac (P1, found independently by two reviewers): both probe
# assertions used `strings f | grep -q TOKEN` under `set -euo pipefail`. grep -q exits
# on first match, strings then dies of SIGPIPE, and pipefail reports 141 for the whole
# pipeline. Read as a boolean that is "no match", which made the step-4 assertion fail
# OPEN on a contaminated deploy artifact and the step-1 assertion fail spuriously when
# the probe WAS present. scripts/verify-release-artifact.sh records this exact defect
# in its own header, having been bitten by it first. Both sites now scan a materialized
# file with no pipeline, so the exit code means what it says.
set -euo pipefail

# scan_for <file> <needle> -> exits 0 if present, 1 if absent, aborts if unreadable.
scan_for() {
  local f="$1" needle="$2" tmp
  if [[ ! -f "$f" ]]; then
    echo "ERROR: expected artifact does not exist: $f" >&2
    exit 1
  fi
  # Review-of-fixes F3: removing the pipeline was not enough. `strings > tmp` had its
  # exit status DISCARDED, and because scan_for is invoked as an `if` condition bash
  # suspends errexit for the entire function body. So a file that exists but cannot be
  # READ (chmod 000, or a failing mktemp) produced an empty temp, grep found nothing,
  # and step 4 printed "OK: is the clean (no-probe) deploy artifact" and exited 0. The
  # header's old claim that "the exit code means what it says" was false: the pipeline
  # was gone but the swallowed status was not. Now an unreadable artifact ABORTS.
  if ! tmp="$(mktemp)"; then
    echo "ERROR: mktemp failed, cannot scan $f" >&2
    exit 1
  fi
  if ! strings "$f" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "ERROR: cannot read $f (permissions? truncated?). Refusing to report on it." >&2
    exit 1
  fi
  if ! [[ -s "$tmp" ]]; then
    rm -f "$tmp"
    echo "ERROR: $f yielded no strings at all, which is not a real .so" >&2
    exit 1
  fi
  if grep -q -- "$needle" "$tmp"; then
    rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"; return 1
}
cd "$(dirname "$0")/../.."

echo "[1/4] build dominion (--features test-harness) + mock-lazer -> SBF"
# AUDIT root-cause fix: build the harness artifact into its OWN directory so
# target/deploy (the path `solana program deploy` reads) is never touched.
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml --sbf-out-dir target/harness --features test-harness
cargo build-sbf --manifest-path tools/mock-lazer/Cargo.toml --sbf-out-dir target/harness
# Anchor emits the PascalCase ix-name (ProbeOraclePrice) in the binary, NOT the
# snake_case fn name - so this is the correct probe-presence token.
if ! scan_for target/harness/dominion_silver_mint.so ProbeOraclePrice; then
  echo "ERROR: probe absent from the harness .so (feature build failed)"; exit 1
fi

echo "[2/4] run litesvm harness (rustc 1.89; litesvm needs >= 1.86)"
# ROUND 4 P2-04. Le runner state avait ce defaut et il a ete corrige; celui-ci le gardait. Un `cargo test`
# dont le filtre ne matche rien sort 0, et ce script imprimait alors son message OK sur une execution de
# ZERO test. Le compte est lu et asserte, avec le total attendu epingle: un test perdu est aussi grave
# qu un test rouge, et il est plus silencieux.
EXPECTED_LAZER_TESTS=7
if ! _out="$(mktemp)"; then echo "ERROR: mktemp failed" >&2; exit 1; fi
set +e
cargo +1.89.0 test --manifest-path tools/lazer-harness/Cargo.toml "$@" 2>&1 | tee "$_out"
_rc="${PIPESTATUS[0]}"
set -e
if [[ "$_rc" -ne 0 ]]; then rm -f "$_out"; echo "FAIL: la suite Lazer n a pas passe (cargo $_rc)" >&2; exit "$_rc"; fi
_ran="$(awk '/^test result:/ { for (i = 1; i <= NF; i++) if ($i == "passed;") t += $(i-1) } END { print t + 0 }' "$_out")"
rm -f "$_out"
if [[ "$_ran" -ne "$EXPECTED_LAZER_TESTS" ]]; then
  echo "FAIL: $_ran test(s) Lazer executes, $EXPECTED_LAZER_TESTS attendus." >&2
  echo "      Un test ajoute ou supprime: mettez a jour EXPECTED_LAZER_TESTS dans le MEME commit." >&2
  exit 1
fi
echo "  $_ran/$EXPECTED_LAZER_TESTS tests Lazer executes."

echo "[3/4] target/deploy untouched by design (harness builds into target/harness),"
echo "      so there is nothing to restore. Verify the deploy artifact separately:"
echo "        scripts/verify-release-artifact.sh"
echo "[4/4] assert the deploy artifact is probe-free"
# scan_for aborts if the file is missing, which is deliberate: the previous form
# printed "OK: ... is the clean deploy artifact" about a file that did not exist.
if scan_for target/deploy/dominion_silver_mint.so ProbeOraclePrice; then
  echo "ERROR: default .so still contains the probe!"; exit 1
fi
echo "OK: target/deploy/dominion_silver_mint.so is the clean (no-probe) deploy artifact."
