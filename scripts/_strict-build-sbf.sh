#!/usr/bin/env bash
# THE ONE PLACE A .so IS BUILT, because a BPF stack overflow is not a build failure
# for cargo and must be one for us.
# `cargo build-sbf` prints, on its own line and prefixed "Error:",
#   Function ...::try_accounts Stack offset of 4112 exceeded max offset of 4096 by 16 bytes
# and then EXITS 0 and emits a .so. The overflow is real: adding one account to `initialize` silently
# zeroed 16 bytes of a neighbouring account's data, a correct on-chain check rejected a correct input,
# and the failure surfaced three layers from its cause. The number of corrupted bytes was exactly the
# number in the message.
# The first version of this guard lived only in tools/state-harness/run.sh, so the paths that actually
# BUILD, COMPARE and PUBLISH the release bytes still called `cargo build-sbf` raw. A future overflow
# would exit 0 there, produce a .so, and could even pass the reproducible comparison, because both
# sides would reproduce the same corrupted bytes. So the guard moved here and every caller uses it.
#   bash scripts/_strict-build-sbf.sh --manifest-path <Cargo.toml> [-- --locked]
# DOMINION_STRICT_BUILD_INJECT is a TEST HOOK, honoured only by scripts/test-strict-build-sbf.sh: it
# appends its value to the captured log so the fatal-line detection can be exercised without waiting
# for a real overflow. It never changes what is built, and the self-test proves the guard still fires
# on an exit code of 0.
set -uo pipefail

log="$(mktemp)" || { echo "ERROR: mktemp failed, refusing to build unmeasured" >&2; exit 1; }
cargo build-sbf "$@" > "$log" 2>&1
rc=$?
if [ -n "${DOMINION_STRICT_BUILD_INJECT:-}" ]; then
  printf '%s\n' "$DOMINION_STRICT_BUILD_INJECT" >> "$log"
fi

if [ "$rc" -ne 0 ]; then
  cat "$log" >&2
  rm -f "$log"
  echo "ERROR: cargo build-sbf failed ($*)" >&2
  exit "$rc"
fi
if grep -q "exceeded max offset" "$log"; then
  grep -n "exceeded max offset" "$log" >&2
  rm -f "$log"
  echo >&2
  echo "ERROR: the build overflowed the 4KB BPF stack frame. cargo exited 0 and produced a .so" >&2
  echo "       anyway, and the excess bytes silently corrupt whatever sits next to the frame." >&2
  echo "       Box the large Account<'info, T> payloads in the offending Accounts struct." >&2
  exit 1
fi
cat "$log"
rm -f "$log"
