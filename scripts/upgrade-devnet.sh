#!/usr/bin/env bash
#
# Upgrade the deployed Dominion Silver program on devnet with the latest CI artifact.
# Requires: gh CLI authenticated, solana config set to devnet + correct wallet.

set -euo pipefail

WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKDIR"

echo "==> Downloading latest successful CI artifact..."
RUN_ID=$(gh run list --workflow "Anchor Build + Test" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
if [[ -z "$RUN_ID" ]]; then
  echo "ERROR: no successful CI run found" >&2
  exit 1
fi
echo "==> Run: $RUN_ID"

rm -rf /tmp/dominion-upgrade
mkdir -p /tmp/dominion-upgrade
gh run download "$RUN_ID" --name program-binary --dir /tmp/dominion-upgrade
gh run download "$RUN_ID" --name idl --dir /tmp/dominion-upgrade
mkdir -p target/deploy target/idl
cp /tmp/dominion-upgrade/dominion_silver_mint.so target/deploy/
cp /tmp/dominion-upgrade/dominion_silver_mint.json target/idl/

PROGRAM_ID=$(solana-keygen pubkey target/deploy/dominion_silver_mint-keypair.json)
echo "==> Program ID: $PROGRAM_ID"
echo "==> Cluster: $(solana config get json_rpc_url | awk '{print $3}')"
echo "==> Wallet balance: $(solana balance)"

echo "==> Upgrading..."
solana program deploy \
  --program-id target/deploy/dominion_silver_mint-keypair.json \
  target/deploy/dominion_silver_mint.so

echo ""
echo "✅ Upgrade complete."
echo "==> New binary hash: $(sha256sum target/deploy/dominion_silver_mint.so | awk '{print $1}')"
echo "==> Program ID: $PROGRAM_ID"
echo "==> Program details:"
solana program show "$PROGRAM_ID" | grep -E "Authority|Data Length|Balance|Last Deployed" || true
