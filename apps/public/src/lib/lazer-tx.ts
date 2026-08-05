// Pyth Lazer transaction builders for the dominion oracle-consuming
// instructions (mint / instant-redeem / claim). Each builds the dominion ix
// with the 5 Lazer verify accounts + the inner-payload-free envelope as
// `message_data`, prepends the ed25519 precompile instruction whose offsets the
// on-chain Lazer verify_message cross-checks (lazer-assembly.ts), and assembles
// `[ed25519, ...preIxs, dominionIx]`.
//
// STATUS: the instruction ASSEMBLY (account set, args, ed25519 offset
// cross-referencing) is pure + unit-tested. The end-to-end flow (a real signed
// envelope from /api/lazer + landing the tx) is gated on the Pyth Starter API
// key; the compute-unit budget is an estimate pending a live measurement.
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { WalletContextState } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getProgram, type RedemptionRequestView } from "./anchor-client";
import {
  configPda,
  lazerFeePayerPda,
  silvMintAuthorityPda,
  treasuryPda,
  feeExemptPda,
  feeVaultPda,
  kycPda,
} from "./pdas";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CU_LIMIT,
  LAZER_PROGRAM_ID,
  LAZER_STORAGE,
  LAZER_TREASURY,
  SILV_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
} from "./constants";
import { assembleLazerTx, lazerMessageData } from "./lazer-assembly";

// CRITICAL ix ORDERING (the ed25519 precompile uses ABSOLUTE instruction-index
// offsets, so the tx layout must be stable end-to-end):
//   [cb_limit, cb_price, ed25519, ...ataIxs, dominionIx]
// The 2 compute-budget ixs go FIRST and we set the priority fee OURSELVES.
// Wallets (Phantom) otherwise PREPEND their own setComputeUnitPrice ix at index
// 0, which shifts every instruction by 1 -> the ed25519 offsets (pinned to the
// dominion ix's absolute index) then point one slot short, at an ATA ix ->
// the precompile fails `InvalidDataOffsets` (Custom 3) and the mint reverts in
// the wallet's pre-sign simulation. Setting the price ourselves makes the wallet
// leave the tx untouched. The ed25519 ix therefore sits at index 2.
const COMPUTE_BUDGET_IX_COUNT = 2;
/** The ed25519 ix's tx position (= the dominion ix's `ed25519_instruction_index` arg). */
export const ED25519_IX_INDEX = COMPUTE_BUDGET_IX_COUNT;
// Modest devnet priority fee; its presence (not its size) is what stops the
// wallet from prepending its own and breaking the offsets.
const PRIORITY_FEE_MICROLAMPORTS = 1000;

/** The 5 Lazer verify accounts every dominion oracle ix needs. */
export function lazerOracleAccounts() {
  return {
    lazerProgram: LAZER_PROGRAM_ID,
    lazerStorage: LAZER_STORAGE,
    lazerTreasury: LAZER_TREASURY,
    lazerFeePayer: lazerFeePayerPda(),
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  };
}

function computeBudgetIxs(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
  ];
}

/**
 * Pure: order the instructions for a Lazer oracle tx as
 * `[cb_limit, cb_price, ed25519, ...ataIxs, dominionIx]`. The compute-budget ixs
 * lead so a wallet won't prepend its own and shift the ed25519 ix's absolute
 * instruction-index offsets; the ed25519 ix sits at `COMPUTE_BUDGET_IX_COUNT`
 * and its offsets reference the dominion ix at the tail. Unit-tested offline.
 */
export function assembleLazerOracleIxs(
  dominionIx: TransactionInstruction,
  envelope: Uint8Array,
  ataIxs: TransactionInstruction[],
): TransactionInstruction[] {
  const cbIxs = computeBudgetIxs();
  const dominionInstructionIndex = cbIxs.length + 1 + ataIxs.length;
  const { ed25519Ix } = assembleLazerTx(dominionIx.data, envelope, {
    dominionInstructionIndex,
    ed25519InstructionIndex: ED25519_IX_INDEX,
  });
  return [...cbIxs, ed25519Ix, ...ataIxs, dominionIx];
}

async function finalize(
  connection: Connection,
  feePayer: TransactionInstruction["keys"][number]["pubkey"],
  ixs: TransactionInstruction[],
): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer;
  return tx;
}

/** The premium fee vault: the USDC ATA of the fee_vault PDA.
 *
 * allowOwnerOffCurve = true is MANDATORY (the owner is a PDA); omitting it throws
 * TokenOwnerOffCurveError. mint_silv and redeem_silv both REQUIRE this account to exist, so if
 * it was never created every mint and every redeem reverts. */
export function feeVaultUsdcAta(): PublicKey {
  return getAssociatedTokenAddressSync(
    USDC_MINT,
    feeVaultPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
}

/** Resolve the caller's OPTIONAL per-wallet accounts (fee exemption, KYC attestation).
 *
 * Anchor optional accounts must be `null` when absent. Passing the PDA address of an account
 * that does NOT exist is worse than passing null: the program would try to deserialize it and
 * fail. So this checks existence first, with ONE batched RPC call.
 *
 * Resolving from chain rather than from a caller-supplied flag makes the client self-healing: a
 * wallet that gets whitelisted or approved starts benefiting on its next transaction with no
 * front-end change and no cache to invalidate.
 *
 * On RPC failure both fall back to null, which is the safe direction: the caller pays the full
 * fee (never a wrong discount), and if the KYC gate is armed the transaction fails with a clear
 * KycRequired rather than silently pricing wrong. */
export async function resolveWalletFlags(
  connection: Connection,
  user: PublicKey,
): Promise<{ feeExempt: PublicKey | null; kyc: PublicKey | null }> {
  const fe = feeExemptPda(user);
  const ky = kycPda(user);
  try {
    const infos = await connection.getMultipleAccountsInfo([fe, ky]);
    return {
      feeExempt: infos[0] ? fe : null,
      kyc: infos[1] ? ky : null,
    };
  } catch {
    return { feeExempt: null, kyc: null };
  }
}


export interface BuildLazerMintTxArgs {
  amountUsdc: BN;
  minSilvOut: BN;
  envelope: Uint8Array;
}

export async function buildLazerMintTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildLazerMintTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;

  const usdcTreasuryAta = getAssociatedTokenAddressSync(USDC_MINT, treasuryPda(), true, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  const messageData = Buffer.from(lazerMessageData(args.envelope));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opt = await resolveWalletFlags(connection, user);
  const dominionIx = await (program.methods as any)
    .mintSilv(args.amountUsdc, args.minSilvOut, messageData, ED25519_IX_INDEX, 0)
    .accounts({
      config: configPda(),
      feeVaultPda: feeVaultPda(),
      feeVault: feeVaultUsdcAta(),
      feeExempt: opt.feeExempt,
      kyc: opt.kyc,
      user,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      silvMintAuthority: silvMintAuthorityPda(),
      ...lazerOracleAccounts(),
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(user, userSilvAta, user, SILV_MINT, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, user, assembleLazerOracleIxs(dominionIx, args.envelope, ataIxs));
}

export interface BuildLazerRedeemTxArgs {
  amountSilv: BN;
  minUsdcOut: BN;
  envelope: Uint8Array;
}

export async function buildLazerRedeemTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildLazerRedeemTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;

  const usdcTreasuryAta = getAssociatedTokenAddressSync(USDC_MINT, treasuryPda(), true, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  const messageData = Buffer.from(lazerMessageData(args.envelope));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opt = await resolveWalletFlags(connection, user);
  const dominionIx = await (program.methods as any)
    .redeemSilv(args.amountSilv, args.minUsdcOut, messageData, ED25519_IX_INDEX, 0)
    .accounts({
      config: configPda(),
      feeVaultPda: feeVaultPda(),
      feeVault: feeVaultUsdcAta(),
      feeExempt: opt.feeExempt,
      kyc: opt.kyc,
      user,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      treasuryPda: treasuryPda(),
      ...lazerOracleAccounts(),
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, user, assembleLazerOracleIxs(dominionIx, args.envelope, ataIxs));
}

export interface BuildLazerClaimTxArgs {
  request: RedemptionRequestView;
  envelope: Uint8Array;
}

/** DEAD PATH. Throws unconditionally.
 *
 * Kept as a throwing stub rather than deleted so the removal is a LOUD, explained failure
 * instead of a silent one, and so the remaining queue UI in MintRedeemCard still compiles while
 * it is being removed. It is unreachable in practice: `fetchRedemptionRequests` now returns an
 * empty list, so no Claim button ever renders.
 *
 * TODO: delete this together with the queued-redemption UI in MintRedeemCard.tsx. */
export async function buildLazerClaimTx(
  _connection: Connection,
  _wallet: WalletContextState,
  _args: BuildLazerClaimTxArgs,
): Promise<Transaction> {
  throw new Error(
    "The queued redemption path was removed on 2026-08-05. Redemption is now a single " +
      "instant transaction: burn SILV, receive USDC, or it reverts. There is nothing to claim.",
  );
}

// The claimRedemption transaction builder was REMOVED on 2026-08-05 with the whole queued
// redemption path. `claim_redemption` no longer exists in the program or the IDL, so calling it
// threw at runtime rather than failing at build time -- the exact stale-client failure mode the
// constants gate guards against elsewhere.
//
// Redemption is now one instant transaction: buildLazerRedeemTx above burns the SILV and pays
// the USDC in the same transaction, or the whole thing reverts.
