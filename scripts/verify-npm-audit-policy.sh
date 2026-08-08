#!/usr/bin/env bash
# ROUND 5 P2-06. A production-dependency audit policy that can actually fail.
#
# THE FINDING. `npm audit --omit=dev` was red in all three workspaces (root, apps/public, apps/admin),
# nothing in CI ran it, and the only supply-chain gate was `cargo audit`. So the JavaScript half of
# what ships had no gate at all, and the advisory list could grow without anyone noticing.
#
# WHY THIS IS A RATCHET AND NOT A ZERO-TOLERANCE GATE. Forty-odd advisories cannot honestly be cleared
# in one batch, and the audit's own remediation says to triage advisory by advisory rather than to
# bulk-upgrade. A gate that demands zero would be turned off within a week, which is worse than no
# gate. This one pins the CURRENT state and fails on anything WORSE: a new high, a new critical, a new
# vulnerable package. The backlog is visible and bounded; drift is not possible.
#
# THE REACHABILITY EVIDENCE, measured 2026-08-08 and not assumed. Almost every high and the single
# critical arrive through ONE path:
#
#   @dominion/public-app -> @solana/wallet-adapter-react -> @solana-mobile/wallet-adapter-mobile
#                        -> react-native -> metro, image-size, shell-quote, ...
#
# That is the React Native BUILD toolchain, pulled in transitively by a wallet adapter the app never
# imports. Measured against the real production build of apps/public: `shell-quote`, `metro`,
# `image-size`, `react-native` and `bigint-buffer` appear in ZERO files under `.next/static` and
# `.next/server`. They are in the dependency graph and not in the artifact.
#
# That is a reachability argument, not an all-clear: it says these advisories cannot be triggered by a
# browser or by our server, because the code is not there. Re-measure it when the wallet adapter is
# upgraded, because the conclusion is about THIS graph.
#
# Usage: bash scripts/verify-npm-audit-policy.sh
set -uo pipefail
cd "$(dirname "$0")/.."

# BASELINE, measured 2026-08-08. Lower these whenever an advisory is genuinely resolved; raising one
# means accepting a new vulnerability and belongs in a commit that says why.
# workspace:critical:high:moderate:low
BASELINE=(
  ".:0:4:7:0"
  "apps/public:1:19:18:1"
  "apps/admin:1:20:19:1"
)

# Packages allowed to carry a HIGH or CRITICAL today. A high/critical on any package NOT listed here
# fails even when the totals are unchanged: a swap (one resolved, one new) is exactly the drift a
# count-only gate misses. This list caught `@sqds/multisig` the first time it ran.
#
# TWO CATEGORIES, and the distinction is the triage. Calling everything "unreachable" would be the
# same overclaim as calling a lexical grep a semantic proof.
#
# (A) NOT IN THE SHIPPED ARTIFACT, measured. The React Native build toolchain, transitive through
#     @solana/wallet-adapter-react -> @solana-mobile/wallet-adapter-mobile. Grepping the real
#     production build of apps/public for shell-quote, metro, image-size, react-native and
#     bigint-buffer returns ZERO files under .next/static and .next/server. The code is not there, so
#     the advisories cannot fire. Re-measure when the wallet adapter is upgraded.
#
# (B) REACHABLE, and no fix exists that does not break the product. `npm audit fix` offers
#     @sqds/multisig 1.3.1 for the 2.1.4 we use: a MAJOR DOWNGRADE to the pre-v4 API the entire admin
#     Squads path is built on. Taking it would remove the only working mainnet ceremony path to remove
#     a transitive advisory in bigint-buffer's toBigIntLE(), whose input here is RPC account data
#     bounded by the account size. That is a worse trade, and it is recorded as a trade rather than
#     dressed up as a non-issue.
ALLOWED_HIGH=$(cat <<'EOF'
shell-quote
@react-native/community-cli-plugin
@react-native/virtualized-lists
@solana-mobile/mobile-wallet-adapter-protocol
@solana-mobile/mobile-wallet-adapter-protocol-web3js
@solana-mobile/wallet-adapter-mobile
@solana-mobile/wallet-standard-mobile
image-size
metro
metro-config
metro-transform-worker
nanoid
next
postcss
react-native
sharp
ws
@solana/buffer-layout-utils
@solana/spl-token
@sqds/multisig
@metaplex-foundation/beet-solana
bigint-buffer
EOF
)

fail=0

for entry in "${BASELINE[@]}"; do
  IFS=: read -r ws b_crit b_high b_mod b_low <<<"$entry"
  echo "== $ws =="
  json="$( (cd "$ws" && npm audit --omit=dev --json 2>/dev/null) )"
  # A NON-EMPTY STRING IS NOT A MEASUREMENT. When npm cannot audit (registry unreachable, missing
  # lockfile, private-registry auth failure) it prints `{"error":{...}}` on stdout and exits 1. That is
  # valid JSON with no `metadata` key, so every count came back 0, every severity took the `-lt`
  # branch, the gate printed "improved (N -> 0). Lower the baseline in this commit." and exited 0
  # having measured nothing, while actively inviting the operator to zero out the baseline. A gate
  # whose failure mode is "everything is fine" is worse than no gate.
  #
  # REVIEW PASS ON 3bf3097. The guard above proved `metadata.vulnerabilities` was a dict and stopped
  # there, which left two shapes that still read as "everything is fine":
  #
  #   1. A report with every count at 0 and an EMPTY `vulnerabilities` map. Measured: the gate printed
  #      "critical improved (1 -> 0). Lower the baseline in this commit." and exited 0, i.e. it
  #      instructed the operator to destroy the only memory the gate has. An offline mirror, a proxy
  #      returning no advisory data or any soft failure produces exactly this.
  #   2. A report with NO top-level `vulnerabilities` key at all (the npm 6 shape, which uses
  #      `advisories`). The counts still compared and passed while the entire R6-09 advisory-id
  #      ratchet silently did nothing.
  #
  # Both are now shape failures. A gate must be able to tell "I measured zero" from "I measured
  # nothing", and only the second one is an emergency.
  b_total=$((b_crit + b_high + b_mod + b_low))
  if [ -z "$json" ] || ! printf '%s' "$json" | B_TOTAL="$b_total" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
if not isinstance(d.get("metadata", {}).get("vulnerabilities"), dict):
    sys.exit(1)
vulns = d.get("vulnerabilities")
if not isinstance(vulns, dict):
    sys.exit(1)
# An EMPTY map where the baseline expects findings is a collapse, not a clean bill of health. If a
# workspace genuinely reaches zero, the baseline is lowered to zero in the same commit and this stops
# firing, which is the correct order: the human states the new expectation, the gate does not infer it.
if not vulns and int(os.environ["B_TOTAL"]) > 0:
    sys.exit(1)
sys.exit(0)
' 2>/dev/null; then
    echo "   FAIL: npm audit produced no usable report in $ws (it may have errored)."
    echo "         A gate that cannot measure must not pass. Output was:"
    printf '%s\n' "${json:0:300}" | sed 's/^/         /'
    fail=1
    continue
  fi
  read -r crit high mod low unlisted newids <<<"$(
    printf '%s' "$json" | ALLOWED="$ALLOWED_HIGH" WS="$ws" python3 "$PWD/scripts/_npm-audit-summary.py"
  )"
  echo "   critical $crit (baseline $b_crit), high $high ($b_high), moderate $mod ($b_mod), low $low ($b_low)"
  for pair in "critical:$crit:$b_crit" "high:$high:$b_high" "moderate:$mod:$b_mod" "low:$low:$b_low"; do
    IFS=: read -r label got want <<<"$pair"
    if [ "$got" -gt "$want" ]; then
      echo "   FAIL: $label went from $want to $got. A new production vulnerability entered the graph."
      fail=1
    elif [ "$got" -lt "$want" ]; then
      echo "   note: $label improved ($want -> $got). Lower the baseline in this commit."
    fi
  done
  if [ "$unlisted" != "-" ]; then
    echo "   FAIL: high/critical on package(s) not in the documented allowlist: $unlisted"
    echo "         Triage each one, then either fix it or add it with its reachability evidence."
    fail=1
  fi
  # ROUND 6 R6-09. THE CHECK THAT ACTUALLY CATCHES A NEW VULNERABILITY. Counts and package names both
  # stay put when a brand new advisory lands on a package that is already vulnerable and already
  # allowlisted, which is the common case for `next`, `ws`, `sharp` and `postcss`. An advisory ID is an
  # identity, so a new one is new whatever the totals do.
  if [ "$newids" != "-" ]; then
    echo "   FAIL: advisory ID(s) not in config/npm-advisory-baseline.json: $newids"
    echo "         Look each one up (https://github.com/advisories/GHSA-... via npm audit), decide"
    echo "         whether the shipped artifact is reachable, then either fix it or add the ID to the"
    echo "         baseline in a commit that records the reachability argument."
    fail=1
  fi
done

echo
if [ "$fail" -ne 0 ]; then
  echo "NPM AUDIT POLICY: FAILED. The production dependency graph got worse."
  exit 1
fi
echo "NPM AUDIT POLICY OK: no NEW advisory id, no count grew, and every high/critical is on the"
echo "triaged list. That list is a BACKLOG, not an all-clear: category (A) is measured absent from the"
echo "shipped build, category (B) is reachable with no non-breaking fix. See the header."
