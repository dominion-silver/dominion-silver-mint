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

// The ed25519 precompile ix is ALWAYS first in the tx (index 0), placed there by
// assembleLazerOracleIxs. This single constant is therefore correct as BOTH the
// ed25519 ix's tx position AND the dominion ix's `ed25519_instruction_index` arg.
// INVARIANT: nothing may be prepended before the ed25519 ix - if that ever
// changes, this constant + assembleLazerOracleIxs's ordering must change together.
const ED25519_IX_INDEX = 0;

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

/**
 * Pure: order the instructions for a Lazer oracle tx. The dominion ix (carrying
 * the envelope as `message_data`) lands at index `1 + preIxs.length` (the
 * ed25519 ix is 0, then the pre-ixs), and the ed25519 ix's offsets are built to
 * reference exactly that index. Returns the ordered list `[ed25519, ...preIxs,
 * dominionIx]`. Unit-tested offline.
 */
export function assembleLazerOracleIxs(
  dominionIx: TransactionInstruction,
  envelope: Uint8Array,
  preIxs: TransactionInstruction[],
): TransactionInstruction[] {
  const dominionInstructionIndex = 1 + preIxs.length;
  const { ed25519Ix } = assembleLazerTx(dominionIx.data, envelope, {
    dominionInstructionIndex,
    ed25519InstructionIndex: ED25519_IX_INDEX,
  });
  return [ed25519Ix, ...preIxs, dominionIx];
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
  const dominionIx = await (program.methods as any)
    .mintSilv(args.amountUsdc, args.minSilvOut, messageData, ED25519_IX_INDEX, 0)
    .accounts({
      config: configPda(),
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

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    createAssociatedTokenAccountIdempotentInstruction(user, userSilvAta, user, SILV_MINT, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, user, assembleLazerOracleIxs(dominionIx, args.envelope, preIxs));
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
  const dominionIx = await (program.methods as any)
    .redeemSilv(args.amountSilv, args.minUsdcOut, messageData, ED25519_IX_INDEX, 0)
    .accounts({
      config: configPda(),
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

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, user, assembleLazerOracleIxs(dominionIx, args.envelope, preIxs));
}

export interface BuildLazerClaimTxArgs {
  request: RedemptionRequestView;
  envelope: Uint8Array;
}

export async function buildLazerClaimTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildLazerClaimTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const owner = wallet.publicKey;

  const usdcTreasuryAta = getAssociatedTokenAddressSync(USDC_MINT, treasuryPda(), true, TOKEN_PROGRAM_ID);
  const ownerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, owner, false, TOKEN_PROGRAM_ID);
  const messageData = Buffer.from(lazerMessageData(args.envelope));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dominionIx = await (program.methods as any)
    .claimRedemption(messageData, ED25519_IX_INDEX, 0)
    .accounts({
      config: configPda(),
      owner,
      redemptionRequest: args.request.pubkey,
      usdcMint: USDC_MINT,
      usdcTreasury: usdcTreasuryAta,
      ownerUsdcAta,
      treasuryPda: treasuryPda(),
      ...lazerOracleAccounts(),
      classicTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ownerUsdcAta, owner, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, owner, assembleLazerOracleIxs(dominionIx, args.envelope, preIxs));
}
