#!/usr/bin/env bash
#
# SUPERSEDED 2026-08-06 by scripts/upgrade-program.ts. Kept as a pointer so nothing that references
# this filename silently does nothing.
#
# What this file used to be: a V1-era upgrade helper whose first executable line was `exit 1`, on the
# grounds that "V2 is a MANDATORY fresh deploy under a NEW program ID (the V1/V2 ConfigAccount layout
# is incompatible)". That was correct when written. It stopped being correct once the live target was
# itself V2, and external audit finding S-03 caught the consequence: the repository had NO working
# upgrade path at all for the program it actually runs, while the pending batch needs a V2 to V2
# upgrade that PRESERVES the config, the treasury, the SILV mint binding and the live proposal.
#
# The replacement is TypeScript so it can share scripts/_cluster.ts with the rest of the tooling.
# Re-implementing cluster selection in bash is what produced findings S-01, S-02 and D-01.
#
# It also does the thing this script never did: extend the ProgramData account. The binary outgrew
# its allocation by 84,928 bytes at the time of writing (the script recomputes it), and `solana program deploy` fails until that is closed.

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
