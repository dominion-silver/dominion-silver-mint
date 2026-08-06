#!/usr/bin/env bash
#
# SUPERSEDED by scripts/upgrade-program.ts, which shares scripts/_cluster.ts with the rest of the
# tooling and extends the ProgramData account before deploying. Kept as a pointer so that nothing
# referencing this filename silently does nothing.

set -euo pipefail

cat >&2 <<'EOF'
scripts/upgrade-devnet.sh is SUPERSEDED. Use:

  npx tsx scripts/upgrade-program.ts                 # dry run, prints the plan, sends nothing
  DOMINION_INTENT=extend_program_data,deploy_program \
    npx tsx scripts/upgrade-program.ts --execute      # performs it

Cluster comes from DOMINION_RPC (default devnet). The dry run reports the ProgramData shortfall,
whether an extend is required, and the config fields it will verify afterwards.
EOF
exit 64 # EX_USAGE: not a failure of the upgrade, a wrong entry point
