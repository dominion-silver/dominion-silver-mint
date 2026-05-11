// Helpers for Squads v4 multisig integration.
// Used by the Admin UI to:
//   1. Verify the connected wallet is an active member of the Ops or Upgrade Squads.
//   2. Construct proposals for dominion_silver_mint admin instructions.
//   3. Read pending proposals + vote status.
//
// Docs: https://docs.squads.so/squads-v4-docs and @sqds/multisig SDK.

import { PublicKey } from "@solana/web3.js";

// Configure at deploy time.
export const OPS_SQUADS_MULTISIG = new PublicKey(
  process.env.NEXT_PUBLIC_OPS_SQUADS || "OpsSquadsPlaceholder1111111111111111111111111"
);
export const UPGRADE_SQUADS_MULTISIG = new PublicKey(
  process.env.NEXT_PUBLIC_UPGRADE_SQUADS || "UpgSquadsPlaceholder111111111111111111111111"
);

export const SQUADS_V4_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

// Vault index 0 is the default for Squads v4.
export function opsSquadsVaultPda(): PublicKey {
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      OPS_SQUADS_MULTISIG.toBuffer(),
      Buffer.from("vault"),
      Buffer.from([0]),
    ],
    SQUADS_V4_PROGRAM_ID
  );
  return vaultPda;
}

// TODO: once @sqds/multisig SDK is wired, export:
//   - getMembers(multisig): Promise<Pubkey[]>       -- verify wallet is member
//   - createProposal(ix: TransactionInstruction): builds a Squads proposal
//   - vote(proposalKey, approve: bool): casts approve/reject
//   - execute(proposalKey): runs after threshold met
//   - getPendingProposals(multisig): lists active proposals for UI display
