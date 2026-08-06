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
): Promise<WalletFlags> {
  const fe = feeExemptPda(user);
  const ky = kycPda(user);
  try {
    const infos = await connection.getMultipleAccountsInfo([fe, ky]);
    const feeOk = usable(infos[0], FEE_EXEMPT_DISCRIMINATOR);
    return {
      feeExempt: feeOk ? fe : null,
      kyc: usable(infos[1], KYC_DISCRIMINATOR) ? ky : null,
      // AUDIT P-07: the account was located and never READ, so the UI could not tell WHICH side was
      // waived or whether the term was still live, and every quote used the global premium.
      feeExemptFlags: feeOk ? decodeFeeExemptFlags(infos[0]!.data) : null,
      feeExemptExpiresAt: feeOk ? decodeFeeExemptExpiry(infos[0]!.data) : null,
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
 * message. Building nothing at all would be worse than building a correctly-priced transaction.
 *
 * But "safe" is not "free", and the review-of-fixes was too quick to call it safe and stop. Safe
 * means the PROTOCOL cannot be cheated. The USER can still lose: if this wallet really does hold a
 * `FeeExemptAccount` and the read blips, we omit the account, the program cannot see the exemption,
 * and it charges the full premium on a transaction the user already signed. Nothing reverts, so
 * there is no second chance. That is a real (if small) cost imposed by our RPC flake, not theirs.
 *
 * So retry once before conceding. One extra `getMultipleAccountsInfo` covers the transient blip
 * that motivates the fallback in the first place, and costs one round trip on the rare failure path
 * only. It cannot fix a sustained outage: if the wallet is exempt and both reads fail, they overpay.
 * Closing THAT would mean refusing to build the transaction, which penalises every non-exempt
 * wallet (nearly all of them) for a fault that affects one, so it is the wrong trade. */
async function resolveWalletFlagsOrDefault(
  connection: Connection,
  user: PublicKey,
): Promise<WalletFlags> {
  try {
    return await resolveWalletFlags(connection, user);
  } catch {
    try {
      return await resolveWalletFlags(connection, user);
    } catch {
      return { feeExempt: null, kyc: null, feeExemptFlags: null, feeExemptExpiresAt: null };
    }
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
export interface WalletFlags {
  feeExempt: PublicKey | null;
  kyc: PublicKey | null;
  /** `Side` bitfield from the on-chain account: 1 = mint, 2 = redeem, 3 = both. */
  feeExemptFlags: number | null;
  /** Unix seconds. Mandatory and strictly future on chain since audit C-01. */
  feeExemptExpiresAt: number | null;
}

// FeeExemptAccount layout, from state/fee_exempt.rs::SIZE:
//   8 discriminator | 32 wallet | 1 flags | 8 added_at | 32 added_by | 1 version | 8 expires_at | 24 reserved
// Hand-decoded rather than via Anchor's coder because this runs inside `getMultipleAccountsInfo`, where
// we already hold the raw bytes and want no second RPC. The offsets are asserted in
// contract-parity.test.ts against the IDL so they cannot drift from the struct.
/**
 * Offsets DERIVED from the IDL's field types, not hardcoded.
 *
 * RE-AUDIT P2, and it was the fourth remediation test that could not fail for the class its comment
 * claimed to guard. The offsets were literals, the parity test asserted only field NAMES and ORDER, and
 * the round-trip test rebuilt its buffer from the same literals, so it was circular. Widen `added_at` from
 * i64 to i128 without renaming or reordering anything and both tests stay green while `expires_at` moves
 * eight bytes: the app then reads `added_by`/`version` as the expiry and shows an active waiver as expired
 * or the reverse. That directly changes the quoted fee and `min_out`.
 *
 * Computing from the IDL removes the class: a widened field changes the offset automatically, and a type
 * this table does not know throws at module load rather than silently returning a wrong number.
 */
const BORSH_WIDTH: Record<string, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  bool: 1,
  pubkey: 32,
};

function feeExemptOffset(field: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ty = (idl as any).types?.find((t: any) => t.name === "FeeExemptAccount");
  if (!ty?.type?.fields) {
    throw new Error("FeeExemptAccount is not in the IDL: cannot derive its layout");
  }
  let off = 8; // account discriminator
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const f of ty.type.fields as any[]) {
    if (f.name === field) return off;
    const t = f.type;
    if (typeof t === "string") {
      const w = BORSH_WIDTH[t];
      if (w === undefined) {
        throw new Error(`unhandled IDL type "${t}" before ${field} in FeeExemptAccount`);
      }
      off += w;
    } else if (t?.array) {
      const [inner, len] = t.array as [string, number];
      const w = BORSH_WIDTH[inner];
      if (w === undefined) {
        throw new Error(`unhandled IDL array type "${inner}" in FeeExemptAccount`);
      }
      off += w * len;
    } else {
      throw new Error(
        `unhandled IDL type ${JSON.stringify(t)} before ${field} in FeeExemptAccount`,
      );
    }
  }
  throw new Error(`field ${field} not found in FeeExemptAccount`);
}

const FEE_EXEMPT_FLAGS_OFFSET = feeExemptOffset("flags");
const FEE_EXEMPT_EXPIRES_AT_OFFSET = feeExemptOffset("expires_at");

export function decodeFeeExemptFlags(data: Uint8Array | Buffer): number | null {
  if (data.length < FEE_EXEMPT_FLAGS_OFFSET + 1) return null;
  return data[FEE_EXEMPT_FLAGS_OFFSET];
}

export function decodeFeeExemptExpiry(data: Uint8Array | Buffer): number | null {
  if (data.length < FEE_EXEMPT_EXPIRES_AT_OFFSET + 8) return null;
  // i64 LE. Read as BigInt then narrow: an expiry is seconds, so it fits a Number comfortably, and
  // going through BigInt avoids the 32-bit truncation a DataView getInt32 pair would risk.
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[FEE_EXEMPT_EXPIRES_AT_OFFSET + i]);
  // Interpret as signed.
  if (v >= 1n << 63n) v -= 1n << 64n;
  return Number(v);
}

/**
 * The premium a GIVEN wallet actually pays on a GIVEN side, mirroring
 * `state/fee_exempt.rs::effective_premium_bps`.
 *
 * AUDIT FINDING P-07. The resolver loaded the exemption PDA, but the preview, the effective price, the
 * fee label and `min_out` all kept using the global bps. A wallet whitelisted on mint saw "1% fee" and
 * an understated output while the program would charge 0%, so the user could not see the commercial
 * terms they had been granted before signing. Distinct from the deliberate RPC fallback: this happened
 * even when the read SUCCEEDED.
 *
 * `expiresAt` of 0 counts as EXPIRED here, matching `FeeExemptAccount::is_expired` after C-01. Failing
 * open would quote 0% and then charge the premium, which is the worse direction: the user would sign
 * expecting a discount and receive less SILV than the quote promised.
 */
export function effectivePremiumBps(
  configuredBps: number,
  flags: number | null,
  expiresAt: number | null,
  side: "mint" | "redeem",
  nowSecs: number,
): number {
  if (flags == null || expiresAt == null) return configuredBps;
  if (expiresAt === 0 || nowSecs >= expiresAt) return configuredBps;
  const bit = side === "mint" ? 1 : 2;
  return (flags & bit) !== 0 ? 0 : configuredBps;
}

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


/** A wallet-entitlement snapshot the CALLER already resolved.
 *
 *  RE-AUDIT P2: the builders used to re-read these accounts themselves, so the transaction was built from
 *  a different snapshot than the one the quote and `min_out` were derived from. Two snapshots, one
 *  transaction, and the disagreement surfaces as an unexplainable SlippageExceeded. Pass the quote's
 *  snapshot; omit it and the builder resolves its own, which is the correct behaviour for a non-UI caller
 *  (a script) that has no quote to be consistent with. */
export interface BuildLazerMintTxArgs {
  amountUsdc: BN;
  minSilvOut: BN;
  envelope: Uint8Array;
  /** The snapshot the QUOTE used. See the note above. */
  walletFlags?: WalletFlags;
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
  // The caller's snapshot if it has one, so the transaction is priced by the same facts the user saw.
  const opt = args.walletFlags ?? (await resolveWalletFlagsOrDefault(connection, user));
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
  /** The snapshot the QUOTE used. See BuildLazerMintTxArgs. */
  walletFlags?: WalletFlags;
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
  const opt = args.walletFlags ?? (await resolveWalletFlagsOrDefault(connection, user));
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
