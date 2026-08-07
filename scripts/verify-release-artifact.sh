#!/usr/bin/env bash
# Gate: refuse to deploy an artifact not built from this tree with the default features.
#
# ASSERTS: the .so is byte-identical to a clean default-feature rebuild; the forbidden
# instruction names are absent as strings; the IDL exists, advertises none of them, and its
# address equals declare_id!. It asserts NOTHING about what is deployed on-chain.
# The rebuild is the primary gate. The string scan is a secondary signal only, because a
# `no-log-ix-name` build strips the msg! names it looks for. `test-harness` and `dev-hatch`
# builds land at target/deploy/dominion_silver_mint.so, the exact path `solana program deploy`
# reads, and dev-hatch compiles in setters that mutate config with NO timelock. Three defeated
# earlier designs of this gate: private/trimmed-notes/gates.md

# Usage: scripts/verify-release-artifact.sh [path-to-so] [path-to-idl]
#   --skip-rebuild   secondary checks only. Weaker, and exits 2, never 0.
set -euo pipefail

# The release hash has ONE home, config/mainnet-authorities.json. A bare 64-hex string in docs/
# fails whether or not it is correct today: a hand-maintained duplicate goes stale, and this one
# went stale three times. Before the --skip-rebuild exit, since that path is the hurried one.
_stray=$(grep -rnoE --include="*.md" "\b[0-9a-f]{64}\b" docs 2>/dev/null || true)
if [ -n "$_stray" ]; then
  echo ""
  echo "FAIL: a bare sha256 appears in docs/. The release hash has ONE home:"
  echo "      config/mainnet-authorities.json -> release_artifact.sha256"
  echo "      Replace the literal with a pointer to that file plus 'bash scripts/verify-release-artifact.sh'."
  echo "$_stray"
  exit 1
fi
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
  # The reference build gets its OWN CARGO_TARGET_DIR. --sbf-out-dir only moves the final .so, so
  # compilation would otherwise reuse the shared target/ that CI restores from a Cargo.lock-keyed
  # cache: a tampered rlib would be linked into both sides and the hashes would agree.
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
    echo "   ok: byte-identical to a clean default rebuild on THIS host ($h_ref)"
  fi

  # ---- 1b. And that is NOT the same claim as matching the release pin ----
  #
  # S-07, measured 2026-08-07. Check 1a compares two builds made on the SAME machine, so it proves the
  # artifact is a clean default build here. It says NOTHING about whether it matches what ships, because
  # SBF builds are not deterministic across host platforms: our .so embeds
  # /Users/runner/work/platform-tools/... paths baked into the macOS-built platform-tools std, and the
  # linux-x86_64 tarball carries /home/runner/... of a different length, shifting every rodata offset
  # after it. macOS and Linux disagree at v1.51 AND at v1.52.
  #
  # The Solana docs state it directly: "Solana program builds are not deterministic across different
  # systems", and "make sure that you actually deploy the verified build and don't accidentally overwrite
  # it with anchor build or cargo build-sbf". The RELEASE artifact is therefore a Linux container build
  # produced by `solana-verify build`, and release_artifact.sha256 pins THAT.
  #
  # So this check reports the comparison honestly instead of letting 1a's green imply something it cannot
  # mean. It FAILS only on linux/x86_64, where the two should agree.
  PINNED="$(python3 -c "import json;print(json.load(open('config/mainnet-authorities.json'))['release_artifact']['sha256'])" 2>/dev/null || echo "")"
  HOST_OS="$(uname -s)"; HOST_ARCH="$(uname -m)"
  echo "1b. The local artifact versus the PINNED release hash"
  if [[ -z "$PINNED" ]]; then
    echo "   FAIL: could not read release_artifact.sha256 from config/mainnet-authorities.json"
    fail=1
  elif [[ "$h_have" == "$PINNED" ]]; then
    echo "   ok: the local artifact IS the pinned release artifact ($PINNED)"
  elif [[ "$HOST_OS" == "Linux" && ( "$HOST_ARCH" == "x86_64" || "$HOST_ARCH" == "amd64" ) ]]; then
    echo "   FAIL: on linux/x86_64 the local build should reproduce the pinned release artifact."
    echo "     local : $h_have"
    echo "     pinned: $PINNED"
    echo "   Either the pin is stale (re-record it from a solana-verify build) or the source differs."
    fail=1
  else
    echo "   EXPECTED MISMATCH on $HOST_OS/$HOST_ARCH, and it is not a defect:"
    echo "     local : $h_have"
    echo "     pinned: $PINNED   (a linux/amd64 solana-verify container build)"
    echo "   This host CANNOT reproduce the release artifact. Do not deploy this .so to mainnet."
    echo "   The deployable bytes come from CI: solana-verify build, job reproducible-build."
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
# `|| fail=1` must sit on the command itself: under `set -e` a later `$?` test is dead code.
) || fail=1

# ---- 3. IDL must exist and must not advertise the forbidden instructions ----
echo "3. IDL"
if [[ ! -f "$IDL" ]]; then
  # A missing IDL is a FAILURE, not a skip: an unverifiable IDL is not a pass.
  echo "   FAIL: IDL not found at $IDL"
  echo "   regenerate: (cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked)"
  fail=1
else
  # The IDL address is ASSERTED against declare_id!, not merely printed: an IDL describing a
  # different program is the drift that ships a console pointed at the wrong deployment.
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
# Skipping the rebuild exits 2, never 0: the LAST line is what gets pasted into a checklist.
if [[ "$SKIP_REBUILD" -eq 1 ]]; then
  echo "ARTIFACT PARTIALLY CHECKED: the secondary scans found no forbidden instruction,"
  echo "but the reproducible rebuild was SKIPPED, so this is NOT a release attestation."
  echo "A binary built with a feature flag can pass everything above. Re-run without"
  echo "--skip-rebuild before any deploy."
  exit 2
fi

echo "ARTIFACT OK: matches a clean default rebuild, no forbidden instruction."
