#!/usr/bin/env bash
#
# Deploy the Dominion Silver Mint program to devnet.
# Uses the .so binary from GitHub Actions (or a local anchor build).
#
# Prereqs:
#   - solana CLI installed and configured for devnet: `solana config set --url devnet`
#   - ~/.config/solana/id.json funded with at least 5 SOL (devnet faucet: solana airdrop 2)
#   - gh CLI authenticated (for --from-ci mode)
#
# Usage:
#   ./scripts/deploy-devnet.sh              # uses target/deploy/dominion_silver_mint.so (local anchor build)
#   ./scripts/deploy-devnet.sh --from-ci    # downloads latest successful CI artifact
#   ./scripts/deploy-devnet.sh --keypair <path>  # custom program keypair (default: target/deploy/dominion_silver_mint-keypair.json)

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
  gh run download "$RUN_ID" --name program-binary --dir /tmp/dominion-artifact
  gh run download "$RUN_ID" --name idl --dir /tmp/dominion-artifact
  mkdir -p target/deploy target/idl
  cp /tmp/dominion-artifact/dominion_silver_mint.so target/deploy/
  cp /tmp/dominion-artifact/dominion_silver_mint.json target/idl/
  echo "==> Copied .so and IDL into target/"
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
