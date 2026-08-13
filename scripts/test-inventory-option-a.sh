#!/usr/bin/env bash
# ROUND 8 T8-03, the acceptance runner. Option A: the pre-mint destination is an argument of
# `initialize`, bound atomically and validated non-default, and `set_inventory_wallet` is DELETED.
#
# Five scenarios, in the order the criterion lists them. Each one either passes or this script exits
# non-zero, and a run in which ZERO scenarios executed is a FAILURE, not a pass: that false-green is
# the exact class this whole harness exists to close, and it has been reintroduced twice in this repo
# by a filter that matched nothing.
#
# The on-chain scenarios go through the REAL `.so` via LiteSVM. `tools/state-harness/run.sh` builds
# it, so this runner never tests yesterday's binary, which is the other repeat failure here.
#
#   bash scripts/test-inventory-option-a.sh              # build the .so, then run everything
#   bash scripts/test-inventory-option-a.sh --no-build   # reuse the artifact already at target/deploy
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_ARGS=()
for a in "$@"; do
  if [[ "$a" == "--no-build" ]]; then BUILD_ARGS+=(--no-build); fi
done

pass=0
fail=0
note() { echo "$*"; }
scenario_ok() { echo "ok: $1"; pass=$((pass + 1)); }
scenario_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Run a harness filter and report against ONE scenario label. `tools/state-harness/run.sh` already
# exits non-zero when a filter matches no test, so a typo in a name below is a failure and not a
# silent skip. NEVER pipe this: under zsh and bash alike `$?` after a pipeline is the LAST command's
# status, which is how a green `tail` reported success over a failing suite twice in this repo.
harness() {
  local label="$1"
  shift
  local log
  log="$(mktemp)"
  set +e
  bash tools/state-harness/run.sh "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" "$@" > "$log" 2>&1
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    scenario_ok "$label"
  else
    scenario_fail "$label"
    sed -n '1,200p' "$log"
  fi
  rm -f "$log"
  # Every later harness call reuses the artifact this one just built.
  BUILD_ARGS=(--no-build)
}

note "== T8-03 option A =="

# 1 + 2. `initialize` binds the requested wallet and refuses the default. Both read ConfigAccount back
# out of the VM after a real transaction, which is the only thing that can tell an applied write from
# a handler that returned Ok and wrote nothing.
harness "initialize binds a non-default inventory wallet atomically" \
  option_a_initialize_binds_the_inventory_wallet_atomically
harness "initialize rejects Pubkey::default inventory" \
  initialize_refuses_a_zero_inventory_wallet

# 3. The deleted discriminator, sent at the real dispatcher. Codex was explicit that an `rg` is not
# the proof here: the test builds the historical eight bytes, sends them, and re-reads the config.
harness "the removed instant-setter discriminator is not dispatched and changes no state" \
  option_a_the_removed_instant_setter_discriminator_is_not_dispatched

# 4. The only remaining writer: propose, refused before the delay, guardian-cancellable, applied after.
# Three tests because they are three separate properties and a single one passing would not imply the
# others; `--test inventory_wallet` covers the whole file including the redirect-then-premint pair.
harness "a later change fails before 24h, is guardian-cancellable, and succeeds only after 24h" \
  --test inventory_wallet

# 5. No IDL and no client exposes the instruction any more. The parity gate carries
# `setInventoryWallet` in its REMOVED list, so a call site anywhere under apps/ or scripts/ fails it.
IDL_COPIES=(
  target/idl/dominion_silver_mint.json
  apps/admin/src/lib/idl/dominion_silver_mint.json
  apps/public/src/lib/idl/dominion_silver_mint.json
)
idl_clean=1
for f in "${IDL_COPIES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  missing IDL copy: $f"
    idl_clean=0
    continue
  fi
  # The INSTRUCTION LIST, not a substring of the whole file: `propose_set_inventory_wallet` and
  # `execute_set_inventory_wallet` must survive, and a plain grep for the name would match both of
  # them plus the doc comments and report a false failure.
  if ! python3 - "$f" <<'PY'
import json, sys
idl = json.load(open(sys.argv[1]))
names = {i["name"] for i in idl["instructions"]}
if "set_inventory_wallet" in names:
    print(f"  {sys.argv[1]}: still declares set_inventory_wallet")
    sys.exit(1)
for required in ("propose_set_inventory_wallet", "execute_set_inventory_wallet"):
    if required not in names:
        print(f"  {sys.argv[1]}: lost {required}, so the only remaining writer is gone too")
        sys.exit(1)
PY
  then
    idl_clean=0
  fi
done

set +e
npx tsx scripts/verify-client-idl-parity.ts > /dev/null 2>&1
parity_rc=$?
set -e
if [[ $idl_clean -eq 1 && $parity_rc -eq 0 ]]; then
  scenario_ok "no IDL or client exposes set_inventory_wallet"
else
  scenario_fail "no IDL or client exposes set_inventory_wallet"
  [[ $parity_rc -ne 0 ]] && npx tsx scripts/verify-client-idl-parity.ts
fi

total=$((pass + fail))
echo
if [[ $total -eq 0 ]]; then
  echo "INVENTORY OPTION A TEST FAILED: zero scenarios ran, so nothing was proved"
  exit 1
fi
if [[ $fail -ne 0 ]]; then
  echo "INVENTORY OPTION A TEST FAILED: $fail/$total"
  exit 1
fi
echo "INVENTORY OPTION A TEST OK: $pass/$total"
