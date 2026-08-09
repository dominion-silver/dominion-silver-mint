#!/usr/bin/env bash
# Hermetic runner for the on-chain state harness. Builds the DEFAULT-feature SBF artifact into
# target/deploy (the path `solana program deploy` reads, and the one the suite loads), asserts that
# artifact carries none of the forbidden test-only instructions, then runs the litesvm suite.
#
# WHY THIS ONE BUILDS INTO target/deploy AND tools/lazer-harness/run.sh DOES NOT: the Lazer harness
# needs `--features test-harness` (it drives probe_oracle_price), so it must build elsewhere or it
# leaves a probe-contaminated binary at the deploy path. Nothing here needs a feature flag, so this
# suite runs against the exact bytes that ship, and building with the default feature set into
# target/deploy is both safe and the point.
#
# The BUILD is the primary guarantee that no probe or dev hatch is present; the string scan is a
# SECONDARY signal only, because a no-log-ix-name build strips the names it looks for (see the header
# of scripts/verify-release-artifact.sh). Run that script for a real release attestation.
#
# Inherited bug worth not repeating (from tools/lazer-harness/run.sh and its own audit): `strings f |
# grep -q X` under `set -euo pipefail` returns 141 on SIGPIPE and was read as "no match", so the
# assertion failed OPEN; and a later fix left `strings > tmp`'s exit status DISCARDED, so an
# unreadable artifact also passed. Both are handled below: no pipeline, and an unreadable or
# stringless artifact ABORTS instead of reporting OK.
set -euo pipefail

cd "$(dirname "$0")/../.."
SO=target/deploy/dominion_silver_mint.so
MANIFEST=programs/dominion_silver_mint_v2/Cargo.toml

# Same list as scripts/verify-release-artifact.sh: probe_oracle_price is the Lazer harness probe,
# the dev_* pair are the dev-hatch setters that mutate config with NO timelock.
FORBIDDEN=(probe_oracle_price ProbeOraclePrice
           dev_set_max_staleness DevSetMaxStaleness
           dev_set_premiums DevSetPremiums)

DO_BUILD=1
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--no-build" ]]; then DO_BUILD=0; else ARGS+=("$a"); fi
done

# has_string <file> <needle> -> 0 present, 1 absent; aborts if the file cannot be read.
has_string() {
  local f="$1" needle="$2" tmp
  if [[ ! -f "$f" ]]; then
    echo "ERROR: expected artifact does not exist: $f" >&2; exit 1
  fi
  if ! tmp="$(mktemp)"; then
    echo "ERROR: mktemp failed, cannot scan $f" >&2; exit 1
  fi
  if ! strings "$f" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "ERROR: cannot read $f (permissions? truncated?). Refusing to report on it." >&2; exit 1
  fi
  if ! [[ -s "$tmp" ]]; then
    rm -f "$tmp"
    echo "ERROR: $f yielded no strings at all, which is not a real .so" >&2; exit 1
  fi
  if grep -q -- "$needle" "$tmp"; then rm -f "$tmp"; return 0; fi
  rm -f "$tmp"; return 1
}

# ROUND 8 F-03. The BPF stack-overflow guard moved to scripts/_strict-build-sbf.sh so that EVERY
# path which builds, compares or publishes a .so uses the same barrier. It lived only here, and the
# release paths still called `cargo build-sbf` raw.
strict_build() { bash scripts/_strict-build-sbf.sh "$@"; }

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "[1/3] build dominion with the DEFAULT feature set -> $SO"
  # `anchor build` is broken in this repo; --locked is mandatory.
  strict_build --manifest-path "$MANIFEST" -- --locked
else
  echo "[1/3] build SKIPPED (--no-build): testing whatever artifact is already at $SO"
fi

# ROUND 5 P1-03. The mock Lazer program, ALWAYS built, INCLUDING under --no-build. `--no-build` means
# "do not rebuild the dominion artifact under test", which is what CI needs when that artifact came
# out of the release container; it has never meant "run without the mock". Built into target/harness,
# never target/deploy, for the same reason tools/lazer-harness/run.sh does it: nothing that is not the
# release artifact may land on the path `solana program deploy` reads.
echo "      + mock-lazer -> target/harness (the anti-replay persistence tests need a Lazer that runs)"
strict_build --manifest-path tools/mock-lazer/Cargo.toml --sbf-out-dir target/harness
# A missing mock is a hard failure and not a skip. The tests that need it would otherwise panic on a
# read, or worse, a future refactor could make them skip silently, which is the exact false-green
# class this harness exists to close.
if [[ ! -f target/harness/mock_lazer.so ]]; then
  echo "ERROR: mock-lazer produced no target/harness/mock_lazer.so. Refusing to run." >&2
  exit 1
fi

echo "[2/3] assert $SO is probe-free and dev-hatch-free"
# A MISSING artifact is a hard failure, never a skip: the previous generation of this check in
# tools/lazer-harness printed OK about a file that did not exist.
if [[ ! -f "$SO" ]]; then
  echo "ERROR: $SO is missing. Build it:"
  echo "  cargo build-sbf --manifest-path $MANIFEST -- --locked"
  exit 1
fi
for name in "${FORBIDDEN[@]}"; do
  if has_string "$SO" "$name"; then
    echo "ERROR: forbidden instruction name '$name' is present in $SO."
    echo "       That is a --features test-harness or dev-hatch build, not the artifact that ships."
    exit 1
  fi
done
echo "      ok: none of ${#FORBIDDEN[@]} forbidden names appear"

echo "[3/3] run the litesvm suite (rustc 1.89; litesvm needs >= 1.86, the machine default is 1.85)"
# Tee rather than run bare, because the exit code alone does not distinguish "everything passed" from
# "nothing ran". A filter that matches no test exits 0, and this runner then printed OK over a run that
# executed zero tests. That is the false-green class this whole harness exists to close, reintroduced in
# the runner that reports on it, so the count is now read and asserted below.
if ! tmp_out="$(mktemp)"; then
  echo "ERROR: mktemp failed, refusing to run unmeasured" >&2; exit 1
fi
set +e
cargo +1.89.0 test --manifest-path tools/state-harness/Cargo.toml ${ARGS[@]+"${ARGS[@]}"} 2>&1 | tee "$tmp_out"
rc="${PIPESTATUS[0]}"
set -e
if [[ "$rc" -ne 0 ]]; then
  rm -f "$tmp_out"
  echo >&2
  echo "FAIL: the litesvm suite did not pass (cargo exited $rc)." >&2
  exit "$rc"
fi

# Sum the "N passed" across every test binary. Zero executed is a FAILURE, whatever cargo's exit code says.
executed="$(awk '/^test result:/ { for (i = 1; i <= NF; i++) if ($i == "passed;") total += $(i-1) } END { print total + 0 }' "$tmp_out")"
rm -f "$tmp_out"
# ROUND 4 P2-04: compter n est pas suffisant, il faut EPINGLER. Un test silencieusement perdu (un fichier
# renomme, un module non declare) laissait le total baisser sans rien signaler. Mettez ce nombre a jour dans
# le meme commit que tout ajout ou suppression de test.
# REVIEW OF FIXES ON 993e628, P0. 155 -> 154. That commit deleted two tests for the unreachable
# `close_timelock_account` and added one invariant test in their place, and did NOT move this
# number, so this runner exited 1 in TWO blocking jobs (gate, reproducible-build). The commit
# message quoted 154, measured with `cargo test` directly, which is precisely the path that does
# not go through the check whose error text says to update this in the SAME commit.
# ROUND 8 lot 1. 164 -> 166: two `option_a_` scenarios plus the zero-inventory and timelocked-reopen
# tests, minus the two tests of the deleted `set_inventory_wallet` first binding.
# ROUND 8 lot 1 FIX PACK. 166 -> 178: tools/state-harness/tests/launch_open_posture.rs, the twelve
# scenarios that qualify the open posture (Codex L1-04). They were the gap that let the posture ship
# with no test of the posture.
# ROUND 8 FINAL-03. 178 -> 179: a_prebuilt_unpause_is_refused_after_a_matured_action_changed_the_
# approved_state, the acceptance test Codex specified. It builds the unpause once, executes a matured
# feed change while paused, asserts the action DISARMED itself (which is what made the previous
# counter guard blind), then submits the pre-built instruction unchanged.
EXPECTED_STATE_TESTS=179
if [[ "$executed" -ne 0 && "$executed" -ne "$EXPECTED_STATE_TESTS" && ${#ARGS[@]} -eq 0 ]]; then
  echo >&2
  echo "FAIL: $executed test(s) executes, $EXPECTED_STATE_TESTS attendus (sans filtre)." >&2
  echo "      Un test a ete ajoute ou perdu. Mettez a jour EXPECTED_STATE_TESTS dans le MEME commit." >&2
  exit 1
fi
if [[ "$executed" -eq 0 ]]; then
  echo >&2
  echo "FAIL: the suite executed ZERO tests, so it proved nothing." >&2
  if [[ ${#ARGS[@]} -gt 0 ]]; then
    echo "      A filter was passed (${ARGS[*]}) and it matched no test name." >&2
    echo "      Filters match the test FUNCTION name, not the file: use e.g. 'attest_increments', not 'kyc::'." >&2
  else
    echo "      No filter was passed, so the harness itself found no tests. Something is broken." >&2
  fi
  exit 1
fi

echo
echo "OK: $executed on-chain test(s) passed against the default-feature $SO."
echo "    For a release attestation (reproducible rebuild + IDL), run:"
echo "      scripts/verify-release-artifact.sh"
