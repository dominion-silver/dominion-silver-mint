/**
 * Anchor client wrapper - V2 (Option B).
 *
 * Mint: pay USDC -> receive SILV at Pyth XAG/USD * (1 + premium_mint). Bounded
 *   by a HARD supply cap (no daily/reserve).
 * Redeem (2026-08-05): ONE instant route. `redeem_silv` burns the SILV and pays the USDC in the
 *   same transaction, or the whole thing reverts. There is no queue, no IOU and no off-chain
 *   settlement step. The client pre-flights via config to predict the outcome and to say so
 *   before the user signs, but the program is the source of truth and re-checks everything, so
 *   `parseRedeemError` must keep handling an on-send revert.
 *
 *   The three routes it can predict: "limit" (the rolling window budget is used up, retry when it
 *   rolls), "otc" (the treasury cannot cover it), "kyc" (the dormant gate is armed on redeem).
 *
 *   NOTE: the transaction builders live in lazer-tx.ts, not here. The pre-Lazer `buildMintTx` /
 *   `buildRedeemTx` that used to sit in this file were deleted: they took two args against a
 *   five-arg instruction, passed a `priceUpdate` account that no longer exists, and had no fee
 *   vault. Exported and unused, they were a footgun for anyone grepping for a mint builder.
 */
import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "./idl/dominion_silver_mint.json";
import { USDC_MINT, SILV_MINT, CU_LIMIT } from "./constants";
import {
  configPda,
  treasuryPda,
  silvMintAuthorityPda,
} from "./pdas";

// ---- types (mirror programs/dominion_silver_mint_v2/src/state/config.rs) ----

export interface ConfigAccount {
  admin: PublicKey;
  permanentDelegateExpected: PublicKey;
  freezeAuthorityExpected: PublicKey;
  complianceMode: boolean;
  premiumBpsMint: number;
  premiumBpsRedeem: number;
  usdcMint: PublicKey;
  silvMint: PublicKey;
  usdcTreasury: PublicKey;
  maxStalenessSeconds: number;
  // Option B economic params:
  maxSilvSupply: BN;
  treasuryMinFloatUsdc: BN;
  redemptionsEnabled: boolean;
  /** DEAD ON CHAIN since 2026-08-05: no instruction reads it. It still DECODES and still holds
   *  its $5,000 default, which is exactly how it silently blocked every redemption at or above
   *  $5,000 from this app. Declared so the shape matches the IDL; MUST NOT be read for any
   *  decision. Same for `redeemQueueDelaySeconds` and `nextRedeemRequestNonce`. */
  largeRedeemThresholdUsdc: BN;
  instantRedeemBudgetUsdc: BN;
  instantRedeemWindowSeconds: number;
  /** DEAD ON CHAIN since 2026-08-05. Do not read. */
  redeemQueueDelaySeconds: number;
  instantWindowStart: BN;
  instantUsedUsdc: BN;
  /** DEAD ON CHAIN since 2026-08-05. Do not read. */
  nextRedeemRequestNonce: BN;
  paused: boolean;
  mintPausedUntil: BN;
  pendingPremiumMintNonce: BN | null;
  // ---- launch-posture / new on-chain fields (order irrelevant; IDL decodes) ----
  pendingAdminEta: BN;
  pendingMaxSupplyNonce: BN | null;
  pendingRedeemLimitsNonce: BN | null;
  inventoryWallet: PublicKey;
  publicMintEnabled: boolean;
  kycOperator: PublicKey;
  /** DERIVED, never set independently: the program maintains
   *  `kycEnforced == (kycScopeFlags != 0)`. Safe to read as "is the gate on at all". */
  kycEnforced: boolean;
  pendingKycOperatorNonce: BN | null;
  /** THE KYC GATE (2026-08-05). Bit 0 = required on mint, bit 1 = required on redeem, 0 = off,
   *  which is the launch posture.
   *
   *  Declared here because omitting it was a real bug class: with the field absent from this
   *  interface, an armed gate would be invisible to the UI, which would keep reporting "instant"
   *  while every transaction reverted with a raw Custom:12104 dump. Optional because a config
   *  written before this upgrade decodes it as 0 rather than undefined, but `?? 0` at the read
   *  sites costs nothing and survives a stale RPC snapshot. */
  kycScopeFlags?: number;
  porFeed: PublicKey;
  porMaxStalenessSeconds: number;
  porEnforced: boolean;
  pendingPorFeedNonce: BN | null;
  mintPaused: boolean;
  redeemPaused: boolean;
  version: number;
}

export type RedemptionStatusKind = "pending" | "claimed" | "settledOffchain";

export interface RedemptionRequestView {
  pubkey: PublicKey;
  owner: PublicKey;
  amountSilv: BN;
  requestedAt: number;
  claimableAt: number;
  nonce: BN;
  status: RedemptionStatusKind;
}

/** Where a redemption lands. "queue" is GONE (2026-08-05: the T+3 queue was deleted from the
 *  program), replaced by "limit": the global rolling budget for this window is exhausted and the
 *  caller should retry after it rolls. "kyc" is the dormant gate, reachable only once an admin
 *  arms it. */
export type RedeemRoute = "instant" | "limit" | "otc" | "kyc" | "disabled";

// ---- provider / program ----

export function getAnchorProvider(
  connection: Connection,
  wallet: WalletContextState,
): AnchorProvider {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  const anchorWallet = {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction.bind(wallet),
    signAllTransactions: wallet.signAllTransactions!.bind(wallet),
  };
  return new AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export function getProgram(
  connection: Connection,
  wallet: WalletContextState,
): Program {
  return new Program(idl as Idl, getAnchorProvider(connection, wallet));
}

function getReadOnlyProgram(connection: Connection): Program {
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("read-only");
      },
      signAllTransactions: async () => {
        throw new Error("read-only");
      },
    } as never,
    { commitment: "confirmed" },
  );
  return new Program(idl as Idl, provider);
}

// ---- read helpers ----

export async function fetchConfig(
  connection: Connection,
): Promise<ConfigAccount | null> {
  const program = getReadOnlyProgram(connection);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (program.account as any).configAccount.fetchNullable(
      configPda(),
    );
    return acc as ConfigAccount | null;
  } catch (e) {
    console.error("fetchConfig error", e);
    return null;
  }
}

export async function fetchTreasuryBalance(connection: Connection): Promise<BN> {
  const treasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
  try {
    const info = await connection.getTokenAccountBalance(treasuryAta);
    return new BN(info.value.amount);
  } catch {
    return new BN(0);
  }
}

export async function fetchSilvSupply(connection: Connection): Promise<BN> {
  try {
    const info = await connection.getTokenSupply(SILV_MINT);
    return new BN(info.value.amount);
  } catch {
    return new BN(0);
  }
}

/**
 * REDEEM PREDICTION LAYER. Rewritten 2026-08-05 for the instant-only program.
 *
 * Three bugs lived here and all three came from the same place: the program changed underneath
 * these functions and they kept reading fields and using formulas that no longer describe it.
 *
 *   B1. `classifyRedeem` returned "queue" above `largeRedeemThresholdUsdc`, a field NO on-chain
 *       instruction reads any more but which still holds its $5,000 default. The UI then called
 *       a builder that throws. Every redemption at or above $5,000 was impossible from the front
 *       end while the program would have settled it instantly.
 *   B2. The client predicted on the NET (what the user receives) while the program now debits the
 *       budget and checks the treasury on the GROSS, because the treasury pays BOTH legs: the
 *       user's and the fee vault's. A 1.5% under-statement at launch fees, which near either
 *       boundary means the UI promises "instant" and the chain reverts.
 *   B3. `computeMaxInstantRedeemableUsdc` clamped to `threshold - 1`, advertising $4,999.99
 *       against a $20,000 budget, and $0 if an operator ever zeroed that dead field.
 *
 * The rule going forward: everything the PROGRAM compares is in GROSS. Only what the USER
 * receives is net. Keep the two named apart.
 */

/** GROSS USDC value of `amountSilv` at pure spot: what LEAVES THE TREASURY.
 *
 *  Mirrors `silv_to_usdc_at_oracle` in math.rs. This is the figure the rolling budget is debited
 *  by and the figure the solvency check uses, so it is the figure the client must compare. */
export function redeemGrossUsdc(amountSilv: BN, silverPriceScaled: BN): BN {
  return amountSilv.mul(silverPriceScaled).div(new BN(10).pow(new BN(9)));
}

/** The premium, taken off the top: `ceil(amount * bps / 10_000)`.
 *
 *  Mirrors `fee_from_amount` in math.rs, INCLUDING the ceiling. The old client computed the
 *  premium as a marked-down price (`spot * (1 - bps/1e4)`) and floored twice, which drifts from
 *  the program by an atomic unit or two. Matching the contract exactly matters here because the
 *  result feeds a slippage floor. */
export function feeFromAmount(amount: BN, bps: number): BN {
  if (bps === 0) return new BN(0);
  const d = new BN(10_000);
  return amount.mul(new BN(bps)).add(d.subn(1)).div(d);
}

/** NET USDC the user receives: gross minus the premium. */
export function redeemUsdcOut(
  amountSilv: BN,
  silverPriceScaled: BN,
  premiumBpsRedeem: number,
): BN {
  const gross = redeemGrossUsdc(amountSilv, silverPriceScaled);
  return gross.sub(feeFromAmount(gross, premiumBpsRedeem));
}

/**
 * The maximum a user can RECEIVE right now, in net USDC.
 *
 * Computed as a GROSS ceiling first (that is what the program bounds), then converted to net for
 * display, because "you can redeem X" has to mean X in the user's hand.
 *
 * Two bounds, both gross, and NO size tier: `largeRedeemThresholdUsdc` is dead on chain and is
 * deliberately not read here.
 */
export function computeMaxInstantRedeemableUsdc(
  cfg: ConfigAccount,
  treasuryBalanceUsdc: BN,
  nowUnixSecs: number,
): BN {
  if (cfg.paused || !cfg.redemptionsEnabled) return new BN(0);
  const windowEnd =
    cfg.instantWindowStart.toNumber() + cfg.instantRedeemWindowSeconds;
  const windowExpired = nowUnixSecs >= windowEnd;
  const usedThisWindow = windowExpired ? new BN(0) : cfg.instantUsedUsdc;
  let budgetRemaining = cfg.instantRedeemBudgetUsdc.sub(usedThisWindow);
  if (budgetRemaining.ltn(0)) budgetRemaining = new BN(0);

  let grossMax = budgetRemaining;
  if (treasuryBalanceUsdc.lt(grossMax)) grossMax = treasuryBalanceUsdc;
  if (grossMax.ltn(0)) grossMax = new BN(0);

  return grossMax.sub(feeFromAmount(grossMax, cfg.premiumBpsRedeem));
}

/**
 * Predict where a redemption lands, so the UI can say so before the user signs.
 *
 * Takes the GROSS, not the net. The program is still the source of truth and re-checks
 * everything, so `parseRedeemError` must keep handling an on-send revert.
 */
export function classifyRedeem(
  cfg: ConfigAccount,
  treasuryBalanceUsdc: BN,
  grossUsdc: BN,
  nowUnixSecs: number,
): RedeemRoute {
  if (cfg.paused || !cfg.redemptionsEnabled) return "disabled";
  // The dormant KYC gate. Bit 1 is the redeem side (state/side.rs). Predicting it needs the
  // caller's attestation, which this function does not have, so it only reports that the gate is
  // armed; MintRedeemCard resolves the per-wallet answer.
  if (((cfg.kycScopeFlags ?? 0) & 2) !== 0) return "kyc";
  const windowEnd =
    cfg.instantWindowStart.toNumber() + cfg.instantRedeemWindowSeconds;
  const used = nowUnixSecs >= windowEnd ? new BN(0) : cfg.instantUsedUsdc;
  if (used.add(grossUsdc).gt(cfg.instantRedeemBudgetUsdc)) return "limit";
  if (treasuryBalanceUsdc.lt(grossUsdc)) return "otc";
  return "instant";
}

/**
 * Map an on-chain revert (logs / message / structured err) to a route.
 *
 * Matches BOTH the symbolic Anchor error name (present in program logs) AND the numeric code
 * (`Custom:<dec>` / `custom program error: 0x<hex>` / `number:<dec>`). The numeric forms matter
 * because when `getTransaction` returns null right after inclusion (common RPC lag at
 * "confirmed") the structured `value.err` is the only signal left and it carries no name.
 *
 * Codes verified against the committed IDL, not from memory:
 *   Paused 12000, InsufficientTreasury 12014, RedemptionsDisabled 12060,
 *   RedeemLimitExceeded 12103, KycRequired 12104, InsufficientFeeVault 12108.
 *
 * MustUseQueue (12061) is deliberately NOT mapped: the variant still exists in the enum for
 * discriminant stability but `redeem_silv` can no longer raise it, and the copy it used to drive
 * told users to retry into a queue that does not exist.
 */
function anchorErr(t: string, name: string, codeDec: number): boolean {
  const hex = "0x" + codeDec.toString(16);
  return (
    new RegExp("\\b" + name + "\\b").test(t) ||
    new RegExp("custom program error:\\s*" + hex + "\\b", "i").test(t) ||
    new RegExp('\\bCustom"?\\s*[:=(]\\s*' + codeDec + "\\b").test(t) ||
    new RegExp("\\bnumber:" + codeDec + "\\b").test(t)
  );
}
export function parseRedeemError(errText: string): RedeemRoute | null {
  if (anchorErr(errText, "RedeemLimitExceeded", 12103)) return "limit";
  if (anchorErr(errText, "KycRequired", 12104)) return "kyc";
  if (anchorErr(errText, "InsufficientTreasury", 12014)) return "otc";
  // The fee vault could not be paid. Not a route the user can choose: it means the treasury is
  // short of the premium leg, which is the same practical situation as InsufficientTreasury.
  if (anchorErr(errText, "InsufficientFeeVault", 12108)) return "otc";
  if (
    anchorErr(errText, "RedemptionsDisabled", 12060) ||
    anchorErr(errText, "Paused", 12000)
  )
    return "disabled";
  return null;
}

/**
 * StaleOracle = 12004 / 0x2ee4 (oracle.rs: get_price_no_older_than vs
 * config.max_staleness_seconds). Hit on ANY Pyth-priced path (mint,
 * redeem, claim) when too much wall-clock passes between fetching the
 * signed Lazer price and the consumer tx landing. max_staleness is 15s on
 * the deployed devnet program (MAX_STALENESS_CEILING_SECONDS is 30, so 60s was never a
 * possible value: the comment predated that ceiling), so a human slow to
 * approve the single wallet prompt trips it. Detect it so the UI shows a
 * clear "be faster / retry" message instead of the raw
 * `Simulation reverted: {...Custom:12004...}` dump.
 */
export function isStaleOracleError(errText: string): boolean {
  return anchorErr(errText, "StaleOracle", 12004);
}

/** Canonical user-facing copy for the StaleOracle case (single source). */
// Action-first so the guidance survives the toast preview slice
// (~120 chars): the user must "be faster", that is the actionable part.
export const STALE_ORACLE_USER_MESSAGE =
  "Please retry and approve the transaction quickly. " +
  "The live oracle price expired before the transaction could confirm.";

/**
 * Flatten an unknown error into one searchable string, INCLUDING program
 * logs. Solana `SendTransactionError` carries the human-readable Anchor lines
 * (`Program log: AnchorError ... Error Code: NonceMismatch ...`) in `.logs`,
 * not always in `.message`. A nonce-race detector that only reads `.message`
 * would miss the signal on the preflight-simulation-failure path.
 */
export function errorToText(e: unknown): string {
  if (e == null) return "";
  const parts: string[] = [];
  if (e instanceof Error) parts.push(e.message);
  else if (typeof e === "string") parts.push(e);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyE = e as any;
  if (anyE && typeof anyE === "object") {
    if (Array.isArray(anyE.logs)) parts.push(anyE.logs.join("\n"));
    if (anyE.error?.errorCode?.code)
      parts.push(String(anyE.error.errorCode.code));
    if (anyE.error?.errorCode?.number != null)
      parts.push(`number:${anyE.error.errorCode.number}`);
    if (anyE.transactionMessage) parts.push(String(anyE.transactionMessage));
    // confirmTransaction's `value.err` (and our attached `onChainErr`) is the
    // structured `{ InstructionError: [idx, { Custom: <code> }] }` shape.
    if (anyE.onChainErr != null) {
      try {
        parts.push(JSON.stringify(anyE.onChainErr));
      } catch {
        parts.push(String(anyE.onChainErr));
      }
    }
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(e));
    } catch {
      parts.push(String(e));
    }
  }
  return parts.join(" | ");
}


// ---- transaction builders ----












// ---- parsing ----

// Parse a plain non-negative decimal string to atomic units (6 decimals).
// Fable audit P2-G: `<input type="number">` accepts scientific notation
// ("2e3"), and these run inside a render-time useMemo, so a `new BN("2e3")`
// throw would crash the whole page via the error boundary. Reject anything that
// is not a plain decimal (no exponent, no sign) by returning 0 - the caller's
// zero-amount guards then handle it cleanly, and the preview shows nothing.
function parseDecimalToAtomic6(input: string): BN {
  if (!/^\d*\.?\d*$/.test(input.trim())) return new BN(0);
  const [whole = "0", frac = ""] = input.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return new BN(whole || "0")
    .mul(new BN(1_000_000))
    .add(new BN(fracPadded || "0"));
}

export function parseUsdcAmount(input: string): BN {
  return parseDecimalToAtomic6(input);
}

export function parseSilvAmount(input: string): BN {
  return parseDecimalToAtomic6(input);
}
