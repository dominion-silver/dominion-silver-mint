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
import { getProgram } from "./anchor-client";
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
  PROGRAM_ID,
  SILV_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
} from "./constants";
import idl from "./idl/dominion_silver_mint.json";
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
 * Anchor optional accounts must be `null` when absent. Passing the PDA address of an account the
 * program cannot deserialize is worse than passing null: the program reverts. So this validates
 * OWNER and DISCRIMINATOR, not merely existence, in ONE batched RPC call.
 *
 * An earlier version checked existence only, and said so in this docstring as though that were the
 * guard. It was not: anyone can create an account at a PDA address with a dust transfer, which
 * bricked the victim's mint and redeem permanently. See `usable` below.
 *
 * Resolving from chain rather than from a caller-supplied flag makes the client self-healing: a
 * wallet that gets whitelisted or approved starts benefiting on its next transaction with no
 * front-end change and no cache to invalidate.
 *
 * THROWS on RPC failure. It used to swallow the error and return `{null, null}`, which looked like
 * the safe choice and defeated the tri-state `classifyRedeem` was given: SWR recorded a SUCCESS,
 * never retried with backoff, and `kycAttested` became a definite `false` rather than `undefined`.
 * With `keepPreviousData` an ATTESTED user was told "Redemption requires identity verification on
 * this wallet" for 30 seconds on any RPC blip. The `undefined` branch was only reachable before the
 * first fetch, never after a failure.
 *
 * The transaction builders below catch and fall back to null themselves, where that IS the safe
 * direction: full fee rather than a wrong discount, and a clear KycRequired rather than mispricing.
 * The decision belongs at each call site, not buried here. */
export async function resolveWalletFlags(
  connection: Connection,
  user: PublicKey,
): Promise<{ feeExempt: PublicKey | null; kyc: PublicKey | null }> {
  const fe = feeExemptPda(user);
  const ky = kycPda(user);
  try {
    const infos = await connection.getMultipleAccountsInfo([fe, ky]);
    return {
      feeExempt: usable(infos[0], FEE_EXEMPT_DISCRIMINATOR) ? fe : null,
      kyc: usable(infos[1], KYC_DISCRIMINATOR) ? ky : null,
    };
  } catch (e) {
    // Rethrow: the SWR consumer needs to see this as an error, not as "no accounts".
    throw e instanceof Error
      ? e
      : new Error(`could not resolve wallet flags: ${String(e)}`);
  }
}

/** The builders' fallback: full fee, no exemption, no attestation.
 *
 * Safe HERE in a way it is not for display, because the program re-checks everything: an omitted
 * exemption charges the full premium and an omitted attestation reverts KycRequired with a mapped
 * message. Building nothing at all would be worse than building a correctly-priced transaction. */
async function resolveWalletFlagsOrDefault(
  connection: Connection,
  user: PublicKey,
): Promise<{ feeExempt: PublicKey | null; kyc: PublicKey | null }> {
  try {
    return await resolveWalletFlags(connection, user);
  } catch {
    return { feeExempt: null, kyc: null };
  }
}

/** Anchor account discriminators: the first 8 bytes of sha256("account:<StructName>").
 *
 *  Read from the IDL rather than hardcoded, so they cannot drift from the program. */
function discriminatorFromIdl(name: string): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc = (idl as any).accounts?.find((a: any) => a.name === name);
  if (!acc?.discriminator) {
    throw new Error(`no discriminator for account ${name} in the IDL`);
  }
  return Uint8Array.from(acc.discriminator as number[]);
}
const FEE_EXEMPT_DISCRIMINATOR = discriminatorFromIdl("FeeExemptAccount");
const KYC_DISCRIMINATOR = discriminatorFromIdl("KycAccount");

/** Whether an account is genuinely one of OUR accounts of the expected type.
 *
 * EXISTENCE IS NOT ENOUGH, and assuming it was is a P0 this code shipped with. Creating an account
 * at a PDA address is PERMISSIONLESS for anybody: a bare `SystemProgram.transfer` of one lamport to
 * `feeExemptPda(victim)` produces a System-owned, zero-data account there. The previous version saw
 * a non-null AccountInfo, reported the exemption as present, and the builder passed the real PDA.
 * Anchor treats any key that is not the program id as "optional account SUPPLIED", so
 * `Option<Account<'info, FeeExemptAccount>>` then failed its owner check and the program reverted.
 *
 * Result: every mint and every redeem from that wallet reverted, permanently, for the price of a
 * dust transfer, with no self-service remedy, because nobody can sign for a PDA to close it. A
 * griefing attack on any address an attacker can name.
 *
 * So: owner must be THIS program, and the first 8 bytes must be the expected Anchor discriminator.
 * Both are needed. The owner check alone would still accept a different account type of ours at a
 * colliding address, and the discriminator alone would accept a spoofed account owned by someone
 * else. Together they match exactly what `Account<'info, T>::try_from` enforces on chain, which is
 * the property this function has to mirror.
 */
export function usable(
  info: { owner: PublicKey; data: Uint8Array | Buffer } | null,
  discriminator: Uint8Array,
): boolean {
  if (!info) return false;
  if (!info.owner.equals(PROGRAM_ID)) return false;
  if (info.data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (info.data[i] !== discriminator[i]) return false;
  }
  return true;
}


export interface BuildLazerMintTxArgs {
  amountUsdc: BN;
  minSilvOut: BN;
  envelope: Uint8Array;
}

/** The mint_silv account set, as a pure function of the caller and their optional per-wallet
 *  accounts.
 *
 *  EXPORTED SO IT CAN BE TESTED. The previous unit test hand-wrote its own 17-key account object
 *  and never called the real builder, so `buildLazerMintTx` could lose `feeVault` tomorrow and
 *  every test would still pass. That is not a theoretical risk: `.accounts()` is NOT strict in
 *  Anchor 0.31.1 (it delegates to `accountsPartial`), so a missing key is silently derived from
 *  the IDL seeds rather than rejected, and for the OPTIONAL accounts that derivation produces a
 *  real PDA address for an account that does not exist, which the program then fails to
 *  deserialize. There is no compiler and no runtime check on this list: a test is the only guard.
 *
 *  `opt` comes from `resolveWalletFlags`, which must have already checked EXISTENCE. Passing a
 *  PDA address for a non-existent optional account is worse than passing null. */
export function mintSilvAccounts(
  user: PublicKey,
  opt: { feeExempt: PublicKey | null; kyc: PublicKey | null },
) {
  return {
    config: configPda(),
    feeVaultPda: feeVaultPda(),
    feeVault: feeVaultUsdcAta(),
    feeExempt: opt.feeExempt,
    kyc: opt.kyc,
    user,
    usdcMint: USDC_MINT,
    silvMint: SILV_MINT,
    usdcTreasury: getAssociatedTokenAddressSync(
      USDC_MINT,
      treasuryPda(),
      true,
      TOKEN_PROGRAM_ID,
    ),
    userUsdcAta: getAssociatedTokenAddressSync(
      USDC_MINT,
      user,
      false,
      TOKEN_PROGRAM_ID,
    ),
    userSilvAta: getAssociatedTokenAddressSync(
      SILV_MINT,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
    ),
    silvMintAuthority: silvMintAuthorityPda(),
    ...lazerOracleAccounts(),
    classicTokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

/** The redeem_silv account set. Same as mint plus `treasuryPda` (which signs the payout) and
 *  minus `silvMintAuthority` (nothing is minted). Same testing rationale. */
export function redeemSilvAccounts(
  user: PublicKey,
  opt: { feeExempt: PublicKey | null; kyc: PublicKey | null },
) {
  const { silvMintAuthority: _unused, ...rest } = mintSilvAccounts(user, opt);
  return { ...rest, treasuryPda: treasuryPda() };
}

export async function buildLazerMintTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildLazerMintTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;

  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  const messageData = Buffer.from(lazerMessageData(args.envelope));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opt = await resolveWalletFlagsOrDefault(connection, user);
  const dominionIx = await (program.methods as any)
    .mintSilv(args.amountUsdc, args.minSilvOut, messageData, ED25519_IX_INDEX, 0)
    .accounts(mintSilvAccounts(user, opt))
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

  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user, false, TOKEN_2022_PROGRAM_ID);
  const messageData = Buffer.from(lazerMessageData(args.envelope));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opt = await resolveWalletFlagsOrDefault(connection, user);
  const dominionIx = await (program.methods as any)
    .redeemSilv(args.amountSilv, args.minUsdcOut, messageData, ED25519_IX_INDEX, 0)
    .accounts(redeemSilvAccounts(user, opt))
    .instruction();

  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, user, assembleLazerOracleIxs(dominionIx, args.envelope, ataIxs));
}

// The claim-redemption builder and its args type were REMOVED on 2026-08-05 with the whole queued
// redemption path. `claim_redemption` no longer exists in the program or the IDL, so calling it
// threw at runtime rather than failing at build time -- the exact stale-client failure mode the
// constants gate guards against elsewhere.
//
// Redemption is now one instant transaction: buildLazerRedeemTx above burns the SILV and pays
// the USDC in the same transaction, or the whole thing reverts.
