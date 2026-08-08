#!/usr/bin/env bash
# ROUND 5 P0-02. The self-test for scripts/verify-release-artifact.sh.
#
# WHY IT EXISTS, and why it runs the whole script instead of its pieces. The verifier used to print
# `EXPECTED MISMATCH`, fall through, print `ARTIFACT OK` and exit 0. The previous session tested the
# branch, saw the intended text in its output, and read the trailing 0 as the intended behaviour. The
# only thing that would have caught it is what this file does: run the script END TO END in the
# configuration that must NOT be attested, and assert the EXIT CODE and the LAST LINE PRINTED, which
# are the two things a caller and a human actually read.
#
# Handover section 1, mode B: "test the branch, not the conclusion". This tests the conclusion.
#
# It is slow (each full case rebuilds the program into an isolated CARGO_TARGET_DIR, about 35s on the
# owner's machine) and that is the price of exercising the real thing. The cheap cases run first so a
# typo fails in seconds.
#
# ROUND 6 R6-03. THE CASES THAT NEED A DIFFERENT PIN NOW RUN AGAINST A COPY OF THE REPOSITORY.
#
# They used to drive `DOMINION_RELEASE_MANIFEST`, an override the verifier honoured. That override was
# a channel for a FALSE RELEASE ATTESTATION: an injected manifest carrying the local .so's hash made
# the production script exit 0 with `ARTIFACT OK`, and this file's positive case blessed exactly that.
# An attestation tool must have one source of truth and no way to point it elsewhere, so the override
# is gone from the verifier and the TEST moved instead of the code under test.
#
# The sandbox is a real copy: same sources, same Cargo.lock, same .so, same IDL, different
# `config/mainnet-authorities.json`. Measured before adopting it: a build from a copied source tree
# produces BYTE-IDENTICAL output (the project directory is not baked into the binary, unlike the
# platform-tools std paths of S-07), so check 1a behaves in the sandbox exactly as in the repo.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
VERIFY=scripts/verify-release-artifact.sh
SO=target/deploy/dominion_silver_mint.so
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One sandbox, reused by every manifest-mutating case. `target/` is excluded and the two build
# products the verifier reads are copied in explicitly, so the copy stays small.
SANDBOX="$TMP/repo"
mkdir -p "$SANDBOX"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='target/' \
      "$REPO/" "$SANDBOX/" || { echo "FAIL: could not build the sandbox copy"; exit 1; }
mkdir -p "$SANDBOX/target/deploy" "$SANDBOX/target/idl"
cp "$REPO/target/deploy/dominion_silver_mint.so" "$SANDBOX/target/deploy/" 2>/dev/null || true
cp "$REPO/target/idl/dominion_silver_mint.json" "$SANDBOX/target/idl/" 2>/dev/null || true

pass=0
fail=0

# run_case <label> <expected exit> <expected substring of the LAST line> [-- args...]
# Runs the verifier, captures everything, and asserts BOTH the code and the final line. Asserting only
# one of the two is how the original defect survived: the code said 0 while the text said mismatch.
run_case() {
  local label="$1" want_code="$2" want_last="$3"; shift 3
  [[ "${1:-}" == "--" ]] && shift
  local out="$TMP/out.$$"
  "$@" >"$out" 2>&1
  local code=$?
  local last
  last="$(grep -v '^[[:space:]]*$' "$out" | tail -1)"
  local ok=1
  if [[ "$code" -ne "$want_code" ]]; then
    echo "  FAIL: $label"
    echo "        exit code: got $code, want $want_code"
    ok=0
  fi
  if [[ "$last" != *"$want_last"* ]]; then
    echo "  FAIL: $label"
    echo "        last line: $last"
    echo "        must contain: $want_last"
    ok=0
  fi
  if [[ "$ok" -eq 1 ]]; then
    echo "  ok  : $label (exit $code)"
    pass=$((pass + 1))
  else
    echo "        full output: $out"
    cp "$out" "$TMP/failed.$label.log" 2>/dev/null || true
    fail=$((fail + 1))
  fi
}

# Put a chosen release_artifact block into the SANDBOX's manifest, leaving the rest of the real file
# intact so the script reads a realistic document rather than a stub with the right keys. Every field
# the `pinned` schema requires is filled from real values, because a half-filled pin is a different
# test and case 10 covers that one deliberately.
sandbox_manifest() {
  python3 scripts/_selftest-manifest.py "$1" "$2" "$3" "$REPO" "$SANDBOX"
}

echo "Self-test: scripts/verify-release-artifact.sh"
echo

if [[ ! -f "$SO" ]]; then
  echo "FAIL: $SO does not exist. Build it first:"
  echo "  cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked"
  exit 1
fi
LOCAL_SHA="$(shasum -a 256 "$SO" | awk '{print $1}')"
LOCAL_BYTES="$(wc -c < "$SO" | tr -d ' ')"
HOST="$(uname -s)/$(uname -m)"
echo "  host       : $HOST"
echo "  local .so  : $LOCAL_SHA ($LOCAL_BYTES bytes)"
echo

echo "-- cheap cases (no rebuild) --"

# 1. --skip-rebuild must never be mistaken for an attestation. Exit 2, and the last line says so.
run_case "--skip-rebuild exits 2 and the verdict is the final line" 2 \
  "ARTIFACT PARTIALLY CHECKED" -- bash "$VERIFY" --skip-rebuild

# 2. A missing artifact is a failure, never a skip.
run_case "a missing .so is rejected" 1 \
  "ARTIFACT REJECTED" -- bash "$VERIFY" "$TMP/does-not-exist.so"

echo
echo "-- full cases (each rebuilds; about 35s apiece) --"

# 3. THE REGRESSION THIS FILE EXISTS FOR. With no candidate pinned, the script must NOT exit 0 and
#    must NOT end on a line that reads as approval.
#
#    It drives an EXPLICIT no-candidate manifest rather than the committed one. The first version read
#    the committed file and hardcoded exit 3, which is correct today and turns red the moment runbook
#    step 2c sets status to "pinned" with a linux/amd64 container hash: on the linux gate runner that
#    becomes exit 1, and the self-test would block the merge of the pin itself while pointing at the
#    verifier. A test of a state machine states the state it is testing.
sandbox_manifest no-candidate - -
run_case "no pinned candidate: exit 3, and the last line forbids deploying" 3 \
  "DO NOT DEPLOY THIS FILE" -- bash "$SANDBOX/$VERIFY"

# 4. The same host, but with a pin it CANNOT reproduce (any macOS/arm64 build versus a linux/amd64
#    container hash). This is the exact branch that used to print EXPECTED MISMATCH and then OK.
sandbox_manifest pinned "184df9895f2d5bf0b0787b182e07ed9af2a1773982873a16ab02c6385eb010e5" 1193592
if [[ "$HOST" == Linux/x86_64 || "$HOST" == Linux/amd64 ]]; then
  # On the host that SHOULD reproduce it, an unreachable pin is a hard failure, not a shrug.
  run_case "linux/amd64 with a pin it does not reproduce: exit 1" 1 \
    "ARTIFACT REJECTED" -- bash "$SANDBOX/$VERIFY"
else
  run_case "a host that cannot reproduce the pin: exit 3, never 0" 3 \
    "DO NOT DEPLOY THIS FILE" -- bash "$SANDBOX/$VERIFY"
fi

# 5. The positive case, so the negatives above mean something. Pin THIS host's own build and the
#    script must attest it, on any platform.
sandbox_manifest pinned "$LOCAL_SHA" "$LOCAL_BYTES"
run_case "a pin this host does reproduce: exit 0 and ARTIFACT OK" 0 \
  "ARTIFACT OK" -- bash "$SANDBOX/$VERIFY"

# 6. Hash right, size wrong. A manifest that disagrees with itself was hand-edited (round 5 P2-01:
#    the committed one carried a macOS hash next to a macOS size while the artifact was neither).
sandbox_manifest pinned "$LOCAL_SHA" $((LOCAL_BYTES + 1))
run_case "a manifest whose size contradicts its hash is rejected" 1 \
  "ARTIFACT REJECTED" -- bash "$SANDBOX/$VERIFY"

# 7. An unknown status must fail closed. A typo in the state machine must not read as "no candidate".
sandbox_manifest almost-pinned "$LOCAL_SHA" "$LOCAL_BYTES"
run_case "an unrecognised status fails closed" 1 \
  "ARTIFACT REJECTED" -- bash "$SANDBOX/$VERIFY"

# 8. --local-only answers the narrow question and says out loud that it is narrow. Verdict LAST.
run_case "--local-only exits 0 and the verdict is the final line" 0 \
  "LOCAL BUILD OK" -- bash "$VERIFY" --local-only

# 10. R6-03 REGRESSION GUARD. `DOMINION_RELEASE_MANIFEST` must do NOTHING.
#
#     REVIEW PASS ON 3bf3097. This case used to assert an ABSOLUTE exit 3, which is only reachable
#     while the committed manifest says `no-candidate`. Runbook step 2c sets it to `pinned`, and from
#     that moment the verifier answers 0 or 1 on the CI host, so this case would have failed on the
#     very commit that pins the release candidate, in a BLOCKING job. That is the exact trap case 3
#     was rewritten with a sandbox to avoid.
#
#     What is actually under test is not a number: it is that the env var changes NOTHING. So run the
#     verifier twice, with and without it, and require both runs to agree. That property holds in
#     every manifest state, before and after the pin.
#     REVIEW OF FIXES ON 993e628, P1. Comparing the two runs is right, but the sandbox was pinned to
#     THIS HOST'S build, which makes the case vacuous in exactly the state it was rewritten to survive.
#     Once runbook step 2c pins the committed manifest to the container hash, on a linux runner that
#     reproduces it, the plain run answers 0/ARTIFACT OK and a sandbox pinned to the same bytes answers
#     0/ARTIFACT OK too: identical, so the case would PASS with the override restored.
#
#     The sandbox must be pinned to whatever the committed manifest is NOT, so an honoured override
#     always yields a different verdict. no-candidate answers 3, a pin to the local build answers 0,
#     and they cannot collide in either state.
echo "-- the removed override --"
committed_status="$(python3 -c '
import json
d = json.load(open("config/mainnet-authorities.json"))
print(d.get("release_artifact", {}).get("status", "unknown"))
')"
if [[ "$committed_status" == "no-candidate" ]]; then
  sandbox_manifest pinned "$LOCAL_SHA" "$LOCAL_BYTES"
  echo "  (committed manifest is no-candidate, so the sandbox is pinned to this host's build)"
else
  sandbox_manifest no-candidate "$LOCAL_SHA" "$LOCAL_BYTES"
  echo "  (committed manifest is $committed_status, so the sandbox is set to no-candidate)"
fi
plain_out="$TMP/override-plain.log"; ovr_out="$TMP/override-set.log"
bash "$VERIFY" >"$plain_out" 2>&1; plain_code=$?
env DOMINION_RELEASE_MANIFEST="$SANDBOX/config/mainnet-authorities.json" bash "$VERIFY" >"$ovr_out" 2>&1
ovr_code=$?
plain_last="$(grep -v '^[[:space:]]*$' "$plain_out" | tail -1)"
ovr_last="$(grep -v '^[[:space:]]*$' "$ovr_out" | tail -1)"
if [[ "$plain_code" == "$ovr_code" && "$plain_last" == "$ovr_last" ]]; then
  echo "  ok  : DOMINION_RELEASE_MANIFEST changes nothing (both runs: exit $plain_code, same verdict)"
  pass=$((pass + 1))
else
  echo "  FAIL: DOMINION_RELEASE_MANIFEST changed the answer."
  echo "        without: exit $plain_code | $plain_last"
  echo "        with   : exit $ovr_code | $ovr_last"
  echo "        The override was restored, or something else reads that variable."
  fail=$((fail + 1))
fi

# 9. The COMMITTED manifest, whatever state it is in, must produce a verdict this script recognises and
#    an exit code that agrees with it. Deliberately not pinned to a number: this case exists to catch a
#    manifest edited into a state no branch handles, not to re-assert case 3.
echo "-- the committed manifest --"
out="$TMP/committed.log"
bash "$VERIFY" >"$out" 2>&1
code=$?
last="$(grep -v '^[[:space:]]*$' "$out" | tail -1)"
case "$code:$last" in
  0:ARTIFACT\ OK*|1:ARTIFACT\ REJECTED*|3:ARTIFACT\ NOT\ ATTESTED*)
    echo "  ok  : the committed manifest yields exit $code with a matching verdict"
    pass=$((pass + 1)) ;;
  *)
    echo "  FAIL: the committed manifest yields exit $code with last line: $last"
    echo "        No branch of the exit contract covers that pair."
    fail=$((fail + 1)) ;;
esac

echo
if [[ "$fail" -ne 0 ]]; then
  echo "SELF-TEST FAILED: $pass passed, $fail failed."
  echo "Logs for the failures are under $TMP (not cleaned up on failure)."
  trap - EXIT
  exit 1
fi
echo "SELF-TEST OK: $pass cases. Nine assert BOTH an exit code and the final line; case 10 asserts"
echo "that two runs AGREE, the only form of that property that survives the manifest being pinned."
