// Pyth Lazer transaction builders for the oracle-consuming dominion instructions. Each builds the dominion
// ix with the 5 Lazer verify accounts plus the envelope as `message_data`, prepends the ed25519 precompile
// instruction whose offsets the on-chain `verify_message` cross-checks (lazer-assembly.ts), and assembles
// `[cb_limit, cb_price, ed25519, ...ataIxs, dominionIx]`. The compute-unit budget is still an estimate.
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

// CRITICAL ix ORDERING: the ed25519 precompile uses ABSOLUTE instruction-index offsets, so the tx layout
// must be stable end to end. The 2 compute-budget ixs go FIRST and we set the priority fee OURSELVES,
// because Phantom otherwise PREPENDS its own setComputeUnitPrice at index 0, shifting every ix by one, so
// the ed25519 offsets point one slot short at an ATA ix, the precompile fails InvalidDataOffsets (Custom 3),
// and the mint reverts inside the wallet's pre-sign simulation.
const COMPUTE_BUDGET_IX_COUNT = 2;
/** The ed25519 ix's tx position (= the dominion ix's `ed25519_instruction_index` arg). */
export const ED25519_IX_INDEX = COMPUTE_BUDGET_IX_COUNT;
// Modest devnet priority fee. Its PRESENCE, not its size, is what stops the wallet prepending its own.
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

/** Pure: order the instructions as `[cb_limit, cb_price, ed25519, ...ataIxs, dominionIx]`. The ed25519 ix
 *  sits at `COMPUTE_BUDGET_IX_COUNT` and its offsets reference the dominion ix at the tail. */
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

/** The premium fee vault: the USDC ATA of the fee_vault PDA. `allowOwnerOffCurve = true` is MANDATORY (the
 *  owner is a PDA) or this throws TokenOwnerOffCurveError. mint_silv and redeem_silv both REQUIRE the
 *  account to exist, so if it was never created every mint and every redeem reverts. */
export function feeVaultUsdcAta(): PublicKey {
  return getAssociatedTokenAddressSync(
    USDC_MINT,
    feeVaultPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
}

/** Resolve the caller's OPTIONAL per-wallet accounts (fee exemption, KYC attestation) in ONE batched RPC
 *  call. Anchor optional accounts must be `null` when absent, and passing the address of an account the
 *  program cannot deserialize is worse than passing null, so this validates with `usable`, not existence.
 *
 *  THROWS on RPC failure, so the consumer sees an error rather than "no accounts" and `kycAttested` stays
 *  `undefined` (NOT KNOWN) instead of hardening into a definite `false`. The builders below fall back to
 *  null themselves, where that IS the safe direction; the decision belongs at each call site. */
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
      owner: user,
      feeExempt: feeOk ? fe : null,
      kyc: usable(infos[1], KYC_DISCRIMINATOR) ? ky : null,
      // P-07: READ the account, do not merely locate it, or every quote uses the global premium.
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

/** The builders' fallback: full fee, no exemption, no attestation. Safe for the PROTOCOL (the program
 *  re-checks everything) but not free for the USER: an exempt wallet whose read blips is charged the full
 *  premium on a transaction that does NOT revert, so there is no second chance. Hence one retry before
 *  conceding. A sustained outage still makes that wallet overpay; refusing to build instead would penalise
 *  every non-exempt wallet for a fault affecting one. */
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
      return { owner: user, feeExempt: null, kyc: null, feeExemptFlags: null, feeExemptExpiresAt: null };
    }
  }
}

/** Anchor account discriminators, read from the IDL rather than hardcoded so they cannot drift. */
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

/** A wallet's on-chain entitlements: which optional accounts it has, and what they say. */
export interface WalletFlags {
  /** WHOSE flags these are. A snapshot is only usable for the wallet it describes, and `keepPreviousData`
   *  deliberately serves the PREVIOUS wallet's until the new fetch settles: pricing B from A's snapshot
   *  either omits B's live exemption (full premium, nothing reverts) or passes A's exemption PDA for B (a
   *  revert after the Lazer fee). Checkable only because the snapshot carries its owner. */
  owner: PublicKey;
  feeExempt: PublicKey | null;
  kyc: PublicKey | null;
  /** `Side` bitfield from the on-chain account: 1 = mint, 2 = redeem, 3 = both. */
  feeExemptFlags: number | null;
  /** Unix seconds. Mandatory and strictly future on chain since audit C-01. */
  feeExemptExpiresAt: number | null;
}

// FeeExemptAccount layout, from state/fee_exempt.rs::SIZE:
//   8 discriminator | 32 wallet | 1 flags | 8 added_at | 32 added_by | 1 version | 8 expires_at | 24 reserved
// Hand-decoded rather than through Anchor's coder: this runs inside `getMultipleAccountsInfo`, so the raw
// bytes are already in hand. Offsets are DERIVED from the IDL field types, never hardcoded: widening a field
// without renaming it moves `expires_at`, and a literal offset would then read `added_by` as the expiry and
// show an active waiver as expired or the reverse, changing the quoted fee and `min_out`. An unknown type
// throws at module load rather than returning a wrong number.
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
  // i64 LE via BigInt, then narrowed: an expiry in seconds fits a Number, and BigInt avoids the 32-bit
  // truncation a DataView getInt32 pair would risk.
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[FEE_EXEMPT_EXPIRES_AT_OFFSET + i]);
  // Interpret as signed.
  if (v >= 1n << 63n) v -= 1n << 64n;
  return Number(v);
}

/** The premium a GIVEN wallet pays on a GIVEN side, mirroring `state/fee_exempt.rs::effective_premium_bps`.
 *  Audit P-07: the preview, the price, the fee label and `min_out` must all use THIS number, not the global
 *  bps. `expiresAt` of 0 counts as EXPIRED, matching `FeeExemptAccount::is_expired`: failing open would
 *  quote 0% and then charge the premium, minting less SILV than the quote promised. */
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

/** Whether an account is genuinely one of OUR accounts of the expected type. EXISTENCE IS NOT ENOUGH:
 *  creating an account at a PDA address is permissionless (one lamport to `feeExemptPda(victim)` makes a
 *  System-owned account there), Anchor treats any supplied non-program-id key as "optional account
 *  SUPPLIED", and the owner check then reverts every mint and redeem from that wallet, permanently. Owner
 *  AND discriminator: together they mirror what `Account<'info, T>::try_from` enforces on chain. */
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
  /** The snapshot the QUOTE used, so the quote, `min_out` and the transaction rest on the SAME facts: two
   *  snapshots for one transaction disagree as an unexplainable SlippageExceeded. Omit it and the builder
   *  resolves its own, which is right for a non-UI caller with no quote to be consistent with. */
  walletFlags?: WalletFlags;
}

/** The mint_silv account set, as a pure function of the caller and their optional per-wallet accounts.
 *
 *  EXPORTED SO IT CAN BE TESTED, and a test is the ONLY guard on this list: `.accounts()` is not strict in
 *  Anchor 0.31.1 (it delegates to `accountsPartial`), so a missing key is silently derived from the IDL seeds,
 *  and for an OPTIONAL account that derivation yields a real address for an account that does not exist,
 *  which the program then fails to deserialize. `opt` must come from a resolver that used `usable`. */
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
  // Trust the caller's snapshot ONLY if it belongs to this signer: a mismatch means the UI is showing
  // another wallet's entitlements, so resolve fresh rather than price this transaction from them.
  const opt = flagsMatchOwner(args.walletFlags, user)
    ? args.walletFlags
    : await resolveWalletFlagsOrDefault(connection, user);
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

/**
 * Whether a wallet-flags snapshot describes THIS signer. `keepPreviousData` serves the previous wallet's
 * entitlements until the new fetch settles, so a snapshot must be checked against the signer before anything
 * is priced from it. ONE exported predicate, used by both builders and by the card: three copies of this
 * comparison is how one of them drifts. A type predicate rather than a `boolean`, so the compiler carries
 * the non-null narrowing instead of a hand-written `!` at each call site.
 */
export function flagsMatchOwner(
  flags: WalletFlags | undefined | null,
  owner: PublicKey,
): flags is WalletFlags {
  return !!flags && flags.owner.equals(owner);
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
  // Trust the caller's snapshot ONLY if it belongs to this signer: a mismatch means the UI is showing
  // another wallet's entitlements, so resolve fresh rather than price this transaction from them.
  const opt = flagsMatchOwner(args.walletFlags, user)
    ? args.walletFlags
    : await resolveWalletFlagsOrDefault(connection, user);
  const dominionIx = await (program.methods as any)
    .redeemSilv(args.amountSilv, args.minUsdcOut, messageData, ED25519_IX_INDEX, 0)
    .accounts(redeemSilvAccounts(user, opt))
    .instruction();

  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM_ID),
  ];
  return finalize(connection, user, assembleLazerOracleIxs(dominionIx, args.envelope, ataIxs));
}

// There is no claim-redemption builder: `claim_redemption` no longer exists in the program or the IDL.
// Redemption is one transaction, `buildLazerRedeemTx` above, which settles or reverts as a whole.
