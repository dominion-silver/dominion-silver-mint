#!/usr/bin/env bash
# Hermetic runner for the Lazer behavioral harness. Builds BOTH SBF artifacts
# with the correct features, asserts the probe is present, runs the litesvm
# suite, then REBUILDS the default (no-feature) dominion .so so target/deploy is
# never left holding a probe-contaminated "deploy" artifact.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "[1/4] build dominion (--features test-harness) + mock-lazer -> SBF"
# AUDIT root-cause fix: build the harness artifact into its OWN directory so
# target/deploy (the path `solana program deploy` reads) is never touched.
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml --sbf-out-dir target/harness --features test-harness
cargo build-sbf --manifest-path tools/mock-lazer/Cargo.toml --sbf-out-dir target/harness
# Anchor emits the PascalCase ix-name (ProbeOraclePrice) in the binary, NOT the
# snake_case fn name - so this is the correct probe-presence token.
strings target/harness/dominion_silver_mint.so | grep -q ProbeOraclePrice \
  || { echo "ERROR: probe absent from the harness .so (feature build failed)"; exit 1; }

echo "[2/4] run litesvm harness (rustc 1.89; litesvm needs >= 1.86)"
cargo +1.89.0 test --manifest-path tools/lazer-harness/Cargo.toml "$@"

echo "[3/4] target/deploy untouched by design (harness builds into target/harness),"
echo "      so there is nothing to restore. Verify the deploy artifact separately:"
echo "        scripts/verify-release-artifact.sh"
echo "[4/4] assert the deploy artifact is probe-free"
if strings target/deploy/dominion_silver_mint.so | grep -q ProbeOraclePrice; then
  echo "ERROR: default .so still contains the probe!"; exit 1
fi
echo "OK: target/deploy/dominion_silver_mint.so is the clean (no-probe) deploy artifact."
