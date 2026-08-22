#!/usr/bin/env bash
# The guard must fire on a build that EXITS 0 and prints the fatal line.
# That combination is the entire point and it cannot be reached by waiting for a real overflow, so the
# line is INJECTED into the captured log through a hook the production path ignores. Without this the
# guard is a grep nobody has ever seen match.
set -uo pipefail
cd "$(dirname "$0")/.."
M=programs/dominion_silver_mint_v2/Cargo.toml
pass=0; fail=0
ok()  { echo "ok: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

out="$(mktemp)"
DOMINION_STRICT_BUILD_INJECT="Error: Function _ZN7probe17try_accounts Stack offset of 4112 exceeded max offset of 4096 by 16 bytes" \
  bash scripts/_strict-build-sbf.sh --manifest-path "$M" -- --locked > "$out" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  bad "an injected overflow on a successful build was ACCEPTED (exit 0)"
  sed -n '1,20p' "$out"
else
  ok "an injected overflow is rejected even though cargo exited 0"
fi
if grep -q "exceeded max offset" "$out"; then
  ok "the refusal quotes the offending line"
else
  bad "the refusal does not quote the offending line"
fi
rm -f "$out"

# The positive control: the SAME build with no injection must succeed, or the case above proves only
# that the script is broken.
if bash scripts/_strict-build-sbf.sh --manifest-path "$M" -- --locked >/dev/null 2>&1; then
  ok "a clean build of the real program is accepted"
else
  bad "a clean build of the real program was rejected, so the case above proves nothing"
fi

echo
if [ "$fail" -ne 0 ]; then echo "STRICT BUILD SELF-TEST FAILED: $fail"; exit 1; fi
echo "STRICT BUILD SELF-TEST OK: $pass/$pass"
