// Squads v4 multisig integration for the Dominion admin console.
//
// The on-chain `config.admin` of dominion_silver_mint is the Ops Squads
// VAULT PDA (not a single key). Every admin action is therefore a Squads
// flow: wrap the dominion instruction into a vault transaction, create a
// proposal, members approve to threshold, then execute. The Upgrade Squads
// is a separate multisig (its vault is the Solana program upgrade authority,
// set via the Solana CLI, not from this app).
//
// Designed for the browser wallet adapter: we BUILD instructions and let the
// connected wallet sign/send. We do NOT use the SDK `rpc.*` helpers (those
// expect a Keypair signer). Verified against @sqds/multisig 2.1.4.

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

export type SquadsRole = "ops" | "upgrade";

// Configured at deploy time (Mark provides the real multisig addresses).
// Until then these are placeholders so the app builds; every flow that
// needs a real multisig checks `isConfigured()` first.
// Fable audit P3-h: parse defensively. A typo in the env value (the exact
// moment Mark's real vaults get wired) must fall back to the placeholder so
// `isConfigured()` shows the clean "not configured" banner, NEVER throw at
// module load and white-screen the whole admin app.
function configuredPk(envValue: string | undefined): PublicKey {
  const PLACEHOLDER = "11111111111111111111111111111111";
  try {
    return new PublicKey(envValue || PLACEHOLDER);
  } catch {
    return new PublicKey(PLACEHOLDER);
  }
}
export const OPS_SQUADS_MULTISIG = configuredPk(
  process.env.NEXT_PUBLIC_OPS_SQUADS,
);
export const UPGRADE_SQUADS_MULTISIG = configuredPk(
  process.env.NEXT_PUBLIC_UPGRADE_SQUADS,
);

export const SQUADS_V4_PROGRAM_ID = multisig.PROGRAM_ID;

const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export function roleMultisigPda(role: SquadsRole): PublicKey {
  return role === "ops" ? OPS_SQUADS_MULTISIG : UPGRADE_SQUADS_MULTISIG;
}

/** True once a real (non-placeholder) multisig address is configured. */
export function isConfigured(role: SquadsRole): boolean {
  return !roleMultisigPda(role).equals(SYSTEM_PROGRAM);
}

/**
 * The Squads vault PDA for a role. For "ops" this MUST equal the on-chain
 * `config.admin`. Vault index 0 is the Squads v4 default.
 */
export function roleVaultPda(role: SquadsRole, index = 0): PublicKey {
  const [vaultPda] = multisig.getVaultPda({
    multisigPda: roleMultisigPda(role),
    index,
  });
  return vaultPda;
}

export interface MultisigInfo {
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  threshold: number;
  members: PublicKey[];
  /** Current highest transaction index (the counter). */
  transactionIndex: bigint;
}

export async function fetchMultisig(
  connection: Connection,
  role: SquadsRole,
): Promise<MultisigInfo> {
  const multisigPda = roleMultisigPda(role);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  return {
    multisigPda,
    vaultPda: roleVaultPda(role),
    threshold: Number(ms.threshold),
    members: ms.members.map((m) => new PublicKey(m.key)),
    transactionIndex: BigInt(ms.transactionIndex.toString()),
  };
}

/** Is `member` an active signer of this role's multisig? */
export async function isActiveMember(
  connection: Connection,
  role: SquadsRole,
  member: PublicKey,
): Promise<boolean> {
  try {
    const info = await fetchMultisig(connection, role);
    return info.members.some((k) => k.equals(member));
  } catch {
    return false;
  }
}

/** Next free transaction index = current counter + 1. */
export async function nextTransactionIndex(
  connection: Connection,
  role: SquadsRole,
): Promise<bigint> {
  const info = await fetchMultisig(connection, role);
  return info.transactionIndex + 1n;
}

/** Minimal structural wallet (matches @solana/wallet-adapter). */
export interface SignerWallet {
  publicKey: PublicKey;
}

/**
 * Build ONE legacy Transaction that: wraps `innerInstructions` (the dominion
 * admin ix, whose required signer is the role vault PDA) into a Squads vault
 * transaction, creates the proposal, and self-approves as `creator`. The
 * connected wallet (a multisig member) signs + sends this. Returns the
 * Squads `transactionIndex` so the UI can track approve/execute.
 */
export async function buildCreateProposalTx(params: {
  connection: Connection;
  role: SquadsRole;
  creator: PublicKey;
  innerInstructions: TransactionInstruction[];
  memo?: string;
}): Promise<{ tx: Transaction; transactionIndex: bigint }> {
  const { connection, role, creator, innerInstructions, memo } = params;
  if (!isConfigured(role)) {
    throw new Error(
      `${role} Squads multisig is not configured (placeholder address). ` +
        `Set NEXT_PUBLIC_${role === "ops" ? "OPS" : "UPGRADE"}_SQUADS.`,
    );
  }
  const multisigPda = roleMultisigPda(role);
  const vaultPda = roleVaultPda(role);
  const transactionIndex = await nextTransactionIndex(connection, role);

  // The inner message is executed by the vault PDA, so payerKey = vaultPda.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: innerInstructions,
  });

  const createIx = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex,
    creator,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo,
  });
  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda,
    creator,
    transactionIndex,
  });
  // Creator self-approves (1 of threshold). Other members approve later.
  const approveIx = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex,
    member: creator,
  });

  const tx = new Transaction().add(createIx, proposalIx, approveIx);
  tx.feePayer = creator;
  tx.recentBlockhash = blockhash;
  return { tx, transactionIndex };
}

/** Build the approve Transaction for an existing proposal. */
export async function buildApproveTx(params: {
  connection: Connection;
  role: SquadsRole;
  transactionIndex: bigint;
  member: PublicKey;
}): Promise<Transaction> {
  const { connection, role, transactionIndex, member } = params;
  const ix = multisig.instructions.proposalApprove({
    multisigPda: roleMultisigPda(role),
    transactionIndex,
    member,
  });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(ix);
  tx.feePayer = member;
  tx.recentBlockhash = blockhash;
  return tx;
}

/**
 * Build the execute VersionedTransaction (v0) for a proposal that has
 * reached threshold. `vaultTransactionExecute` is async (it reads the
 * stored message + resolves LUTs) and returns the ix + lookup tables.
 */
export async function buildExecuteTx(params: {
  connection: Connection;
  role: SquadsRole;
  transactionIndex: bigint;
  member: PublicKey;
}): Promise<VersionedTransaction> {
  const { connection, role, transactionIndex, member } = params;
  const { instruction, lookupTableAccounts } =
    await multisig.instructions.vaultTransactionExecute({
      connection,
      multisigPda: roleMultisigPda(role),
      transactionIndex,
      member,
    });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: member,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message(lookupTableAccounts);
  return new VersionedTransaction(message);
}

export interface ProposalView {
  /**
   * Is this index below the multisig's `staleTransactionIndex`, i.e. voided by a later config change?
   *
   * ADDED 2026-08-12. Squads bumps `staleTransactionIndex` whenever membership or the threshold changes,
   * and every proposal at or below it can no longer be approved or executed (`StaleProposal`, 0x1777).
   * The ops multisig today has `staleTransactionIndex == transactionIndex == 9`, and index 6 is an
   * `AddMember` sitting at `Approved` with 2 of 3. Without this flag the panel rendered it with live
   * Approve and Execute buttons reading "one signature short" on the highest-privilege change that
   * exists, immediately next to the real ceremony rows. On launch day that is a mis-click waiting to
   * happen, and the click wastes a fee and confuses the operator about what still needs signing.
   */
  stale: boolean;
  transactionIndex: bigint;
  status: string;
  approvals: number;
  rejections: number;
  threshold: number;
}

/**
 * List the last `lookback` proposals (newest first) with vote status, for
 * the admin UI pending-actions panel. Best-effort: missing/closed entries
 * are skipped.
 */
export async function listProposals(params: {
  connection: Connection;
  role: SquadsRole;
  lookback?: number;
}): Promise<ProposalView[]> {
  const { connection, role, lookback = 20 } = params;
  if (!isConfigured(role)) return [];
  const info = await fetchMultisig(connection, role);
  const multisigPda = info.multisigPda;
  const out: ProposalView[] = [];
  const start = info.transactionIndex;
  // `staleTransactionIndex` is on the Multisig account; anything at or below it is void.
  const staleAtOrBelow = BigInt((info as unknown as { staleTransactionIndex: bigint | number }).staleTransactionIndex ?? 0);
  for (let i = start; i > 0n && i > start - BigInt(lookback); i -= 1n) {
    const [proposalPda] = multisig.getProposalPda({
      multisigPda,
      transactionIndex: i,
    });
    try {
      const p = await multisig.accounts.Proposal.fromAccountAddress(
        connection,
        proposalPda,
      );
      out.push({
        stale: i <= staleAtOrBelow,
        transactionIndex: i,
        status: (p.status?.__kind as string) ?? "Unknown",
        approvals: p.approved?.length ?? 0,
        rejections: p.rejected?.length ?? 0,
        threshold: info.threshold,
      });
    } catch {
      // No proposal at this index (or closed): skip.
    }
  }
  return out;
}
