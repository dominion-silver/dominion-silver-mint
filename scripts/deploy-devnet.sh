#!/usr/bin/env bash
#
# Deploy the Dominion Silver Mint program to devnet (V1-era helper).

# CODEX P2-05 HARD GUARD: this script is V1-era and unsafe for V2. It defaults
# to the V1 keypair/.so/crate path (target/deploy/dominion_silver_mint-
# keypair.json, programs/dominion_silver_mint/src/lib.rs) and runs an ad-hoc
# `solana program deploy` - exactly the stale-program-id footgun in a
# fresh-deploy-only architecture (same P0 class as upgrade-devnet.sh). Kept
# only as historical reference; hard-disabled.
#
# To (re)deploy V2 follow the governed runbook (private/NEXT_STEPS.md C):
#   build -> sha256-verify -> FRESH program keypair
#   (target/deploy/dominion_silver_mint_v2-keypair.json, NEVER reuse an id)
#   -> solana program deploy -> scripts/initialize-devnet.ts
#   -> update constants + bundled IDL -> redeploy frontends.
echo "REFUSING TO RUN: deploy-devnet.sh is V1-era and unsafe for V2 (fresh-deploy-only). Use the governed deploy runbook in private/NEXT_STEPS.md." >&2
exit 1

set -euo pipefail

MODE="local"
PROGRAM_KEYPAIR="target/deploy/dominion_silver_mint-keypair.json"
WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKDIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-ci) MODE="ci"; shift ;;
    --keypair) PROGRAM_KEYPAIR="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

echo "==> Deploy mode: $MODE"
echo "==> Working dir: $WORKDIR"
echo "==> Program keypair: $PROGRAM_KEYPAIR"

# 1. Fetch binary
if [[ "$MODE" == "ci" ]]; then
  echo "==> Downloading latest successful CI artifact..."
  RUN_ID=$(gh run list --workflow "Anchor Build + Test" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
  if [[ -z "$RUN_ID" ]]; then
    echo "ERROR: no successful CI run found" >&2
    exit 1
  fi
  echo "==> Latest success run: $RUN_ID"
  rm -rf /tmp/dominion-artifact
  mkdir -p /tmp/dominion-artifact
  # REVIEW PASS ON 3bf3097. This block was DEAD and failed on its first line. It downloaded
  # `program-binary`, an artifact round 5 P1-01 deleted precisely because it came from a
  # continue-on-error build and could be stale, and `idl`, deleted in this pass for the same reason.
  # The only downloadable binary is now the container build from `reproducible-build`, published after
  # the gate that judges it, and the IDL that matches it is the one committed in-repo: that job builds
  # the IDL from the pinned toolchain and diffs it against both committed copies, so the repo copy IS
  # the built one or CI is red.
  gh run download "$RUN_ID" --name dominion_silver_mint-verifiable-so --dir /tmp/dominion-artifact
  mkdir -p target/deploy target/idl
  cp /tmp/dominion-artifact/dominion_silver_mint.so target/deploy/
  cp apps/public/src/lib/idl/dominion_silver_mint.json target/idl/
  echo "==> Copied the verifiable .so from CI, and the committed IDL, into target/"
fi

if [[ ! -f target/deploy/dominion_silver_mint.so ]]; then
  echo "ERROR: target/deploy/dominion_silver_mint.so not found" >&2
  echo "       Run: anchor build  (or use --from-ci)" >&2
  exit 1
fi

# 2. Generate program keypair if missing
if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "==> Generating new program keypair at $PROGRAM_KEYPAIR"
  mkdir -p "$(dirname "$PROGRAM_KEYPAIR")"
  solana-keygen new --no-bip39-passphrase -s -o "$PROGRAM_KEYPAIR"
fi
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
echo "==> Program ID: $PROGRAM_ID"

# 3. Confirm current cluster
CLUSTER=$(solana config get json_rpc_url | awk '{print $3}')
echo "==> Target cluster: $CLUSTER"
if [[ "$CLUSTER" != *"devnet"* ]]; then
  echo "WARNING: cluster is not devnet. Continue? (y/N)"
  read -r ans
  if [[ "$ans" != "y" ]]; then exit 1; fi
fi

# 4. Check balance
BALANCE=$(solana balance)
echo "==> Wallet balance: $BALANCE"

# 5. Deploy
echo "==> Deploying program..."
solana program deploy \
  --program-id "$PROGRAM_KEYPAIR" \
  target/deploy/dominion_silver_mint.so

# 6. Upload IDL
if [[ -f target/idl/dominion_silver_mint.json ]]; then
  echo "==> Uploading IDL..."
  anchor idl init -f target/idl/dominion_silver_mint.json "$PROGRAM_ID" \
    || anchor idl upgrade -f target/idl/dominion_silver_mint.json "$PROGRAM_ID"
fi

echo ""
echo "==> Deploy complete."
echo "==> Program ID: $PROGRAM_ID"
echo "==> Next steps:"
echo "    1. Update Anchor.toml [programs.devnet] with: $PROGRAM_ID"
echo "    2. Update apps/public/src/lib/constants.ts PROGRAM_ID with: $PROGRAM_ID"
echo "    3. Update apps/admin/src/lib/constants.ts PROGRAM_ID with: $PROGRAM_ID"
echo "    4. Update declare_id!() in programs/dominion_silver_mint/src/lib.rs"
echo "    5. Rebuild to embed the correct program ID in the binary, then re-deploy"
