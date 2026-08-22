/**
 * Anchor client wrapper (V2, Option B). The transaction builders live in lazer-tx.ts, not here.
 * Mint: pay USDC, receive SILV at Pyth XAG/USD * (1 + premium_mint), bounded by a HARD supply cap.
 * Redeem: ONE instant route, `redeem_silv`, which burns the SILV and pays the USDC in the same transaction
 * or reverts. This client predicts "instant" / "limit" (window budget used up) / "otc" (treasury short) /
 * "kyc" (gate armed) before the user signs, but the program re-checks everything, so `parseRedeemError`
 * must keep handling an on-send revert.
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
  /** DEAD ON CHAIN: no instruction reads it, but it still decodes and still holds its $5,000 default.
   *  Declared so the shape matches the IDL. MUST NOT be read for any decision, here or anywhere. */
  largeRedeemThresholdUsdc: BN;
  instantRedeemBudgetUsdc: BN;
  instantRedeemWindowSeconds: number;
  /** DEAD ON CHAIN. Do not read. */
  redeemQueueDelaySeconds: number;
  instantWindowStart: BN;
  instantUsedUsdc: BN;
  /** Usage of the PREVIOUS window bucket, for the sliding counter. Optional (a pre-upgrade config decodes
   *  it as 0, meaning "no prior bucket") but it MUST be read: omitting it models a FIXED window. */
  instantUsedPrevUsdc?: BN;
  /** DEAD ON CHAIN. Do not read. */
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
  /** DERIVED, never set independently: the program maintains `kycEnforced == (kycScopeFlags != 0)`. */
  kycEnforced: boolean;
  pendingKycOperatorNonce: BN | null;
  /** THE KYC GATE. Bit 0 = required on mint, bit 1 = required on redeem, 0 = off (the launch posture). Must
   *  stay read, or an armed gate is invisible and every tx reverts with a raw Custom:12104. Read as `?? 0`. */
  kycScopeFlags?: number;
  /** The fee-vault escape hatch, NEGATED: false = routing ON. It does not change what a user PAYS (only the
   *  premium's destination), so quotes do not branch on it. It DOES change outflow: `redeemOutflowForGross`. */
  feeRoutingDisabled?: boolean;
  porFeed: PublicKey;
  porMaxStalenessSeconds: number;
  porEnforced: boolean;
  pendingPorFeedNonce: BN | null;
  mintPaused: boolean;
  redeemPaused: boolean;
  version: number;
  /** . The minimum size of a priced operation, atomic USDC: `amount_usdc` on mint, the
   *  gross USDC value on redeem. Zero means no floor, which
   *  is what a config initialised before this field existed decodes out of `reserved`, so read it as
   *  `?? 0` and never assume a non-zero value. It is admin-settable and instant in both directions, so
   *  the live account is the only source: quoting against a hardcoded copy would send a user into a
   *  OperationBelowMinimum revert the moment the floor moves. */
  minOperationUsdc?: BN;
}

/** Where a redemption lands. "limit" = the rolling window budget is exhausted, retry after it rolls.
 *  "kyc" = the dormant gate, reachable only once an admin arms it. There is no "queue" route. */
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
    // THROW, never `return null`: `fetchNullable` already uses null for a genuinely absent account, so null
    // here would make an RPC failure a SUCCESS with `data === null`, and the panel keeps its green dot.
    throw new Error(`config unavailable: ${String(e).slice(0, 200)}`);
  }
}

/** This and `fetchSilvSupply` THROW on an RPC failure and never return BN(0) (audit ): zero is a
 *  MEANINGFUL protocol value, so answering it for "the RPC did not answer" shows supply 0, treasury 0 and
 *  max-instant 0 behind a green status light and routes every redeem to "otc", and SWR records it as a
 *  success that is never retried. A missing ATA is a legitimate zero and stays one. */
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
  } catch (e) {
    // "could not find account" is the ATA genuinely not existing: a real zero, not a failure.
    if (/could not find account|Invalid param: could not find account/i.test(String(e))) {
      return new BN(0);
    }
    throw new Error(`treasury balance unavailable: ${String(e).slice(0, 200)}`);
  }
}

export async function fetchSilvSupply(connection: Connection): Promise<BN> {
  try {
    const info = await connection.getTokenSupply(SILV_MINT);
    return new BN(info.value.amount);
  } catch (e) {
    throw new Error(`SILV supply unavailable: ${String(e).slice(0, 200)}`);
  }
}

// REDEEM PREDICTION LAYER. THE RULE: everything the PROGRAM compares is in GROSS, because the treasury pays
// both legs (the user's and the fee vault's). Only what the USER receives is net. Keep the two named apart:
// conflating them under-states every protocol check by the redeem premium, and both sides are BN so nothing
// type-checks it. `largeRedeemThresholdUsdc` is dead on chain and is never read here.

/** The program's SLIDING window counter, a faithful port of `state/redeem_window.rs::roll_window`:
 *  `used = current + prev * (w - into) / w`, NOT `now >= windowEnd ? 0 : used`. Just after a bucket boundary
 *  the program counts the WHOLE previous bucket (weight 1.0 at `into == 0`), so a fixed-reset model believes
 *  zero is used, says "redeems INSTANTLY", and the chain answers RedeemLimitExceeded after the Lazer fee. */
export function effectiveRedeemUsed(
  cfg: ConfigAccount,
  nowUnixSecs: number,
): BN {
  const w = cfg.instantRedeemWindowSeconds;
  if (w <= 0) return new BN(0); // degenerate config; the program fails open here too

  const windowStart = cfg.instantWindowStart.toNumber();
  const usedCurrent = cfg.instantUsedUsdc;
  const usedPrev = cfg.instantUsedPrevUsdc ?? new BN(0);

  const elapsed = Math.max(0, nowUnixSecs - windowStart);

  let start: number;
  let current: BN;
  let prev: BN;
  if (windowStart === 0) {
    // Bootstrap sentinel: `initialize` leaves it at 0, which is not a real bucket start.
    start = nowUnixSecs;
    current = usedCurrent;
    prev = usedPrev;
  } else if (elapsed >= 2 * w) {
    start = nowUnixSecs;
    current = new BN(0);
    prev = new BN(0);
  } else if (elapsed >= w) {
    start = windowStart + w;
    current = new BN(0);
    prev = usedCurrent;
  } else {
    start = windowStart;
    current = usedCurrent;
    prev = usedPrev;
  }

  const into = Math.min(Math.max(0, nowUnixSecs - start), w);
  const weightedPrev = prev.muln(w - into).divn(w);
  return current.add(weightedPrev);
}

/** GROSS USDC value of `amountSilv` at pure spot. Mirrors `silv_to_usdc_at_oracle` in math.rs. */
export function redeemGrossUsdc(amountSilv: BN, silverPriceScaled: BN): BN {
  return amountSilv.mul(silverPriceScaled).div(new BN(10).pow(new BN(9)));
}

/** The premium, off the top: `ceil(amount * bps / 10_000)`. Mirrors `fee_from_amount` in math.rs INCLUDING
 *  the ceiling: the result feeds a slippage floor, so an atomic-unit drift from the program is a revert.
 *  Do not re-derive it as a marked-down price, which floors twice. */
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

/** The maximum a user can RECEIVE right now, in NET USDC. An OUTFLOW ceiling first (that is what the program
 *  bounds: window budget, treasury balance, no size tier), then converted to net for display. */
export function computeMaxInstantRedeemableUsdc(
  cfg: ConfigAccount,
  treasuryBalanceUsdc: BN,
  nowUnixSecs: number,
  /** The redeem premium THIS WALLET pays. Omit for the configured rate. */
  effectiveBpsRedeem?: number,
): BN {
  if (cfg.paused || !cfg.redemptionsEnabled) return new BN(0);
  // SLIDING, not a fixed reset. See effectiveRedeemUsed.
  let budgetRemaining = cfg.instantRedeemBudgetUsdc.sub(
    effectiveRedeemUsed(cfg, nowUnixSecs),
  );
  if (budgetRemaining.ltn(0)) budgetRemaining = new BN(0);

  let outflowMax = budgetRemaining;
  if (treasuryBalanceUsdc.lt(outflowMax)) outflowMax = treasuryBalanceUsdc;
  if (outflowMax.ltn(0)) outflowMax = new BN(0);

  // With fee routing OFF the premium is retained, so the whole of `outflowMax` reaches the user.
  const bps = effectiveBpsRedeem ?? cfg.premiumBpsRedeem;
  return cfg.feeRoutingDisabled
    ? outflowMax
    : outflowMax.sub(feeFromAmount(outflowMax, bps));
}

/**
 * What a redemption of `grossUsdc` takes OUT of the treasury, mirroring `redeem_silv.rs`:
 *   `let fee_routed = if fee_routing_disabled { 0 } else { fee_usdc }; total_out = to_user + fee_routed;`
 * Audit : comparing the GROSS unconditionally refuses redemptions the chain would serve, and does so
 * exactly while `fee_routing_disabled` is on, i.e. during the incident that switch exists for.
 */
export function redeemOutflowForGross(
  cfg: ConfigAccount,
  grossUsdc: BN,
  /** The premium THIS WALLET pays on the redeem side, not the configured one: for an exempt wallet the
   *  program computes `fee_usdc = 0`, so with routing OFF `total_out = gross`, and subtracting a fee that is
   *  never charged under-states the outflow and predicts "instant" on a transaction that reverts. */
  effectiveBpsRedeem?: number,
): BN {
  if (!cfg.feeRoutingDisabled) return grossUsdc;
  const bps = effectiveBpsRedeem ?? cfg.premiumBpsRedeem;
  return grossUsdc.sub(feeFromAmount(grossUsdc, bps));
}

/** Predict where a redemption lands, so the UI can say so before the user signs. Takes the GROSS and derives
 *  the OUTFLOW itself. The program re-checks everything, so `parseRedeemError` still handles a revert. */
export function classifyRedeem(
  cfg: ConfigAccount,
  treasuryBalanceUsdc: BN,
  grossUsdc: BN,
  nowUnixSecs: number,
  /** Whether THIS wallet holds a KYC attestation. `undefined` = NOT KNOWN, never "no attestation". Required,
   *  not optional: routing on the gate alone tells every attested user they cannot redeem, once it is armed. */
  kycAttested: boolean | undefined,
  /** The redeem premium THIS WALLET pays. Omit for the configured rate. See `redeemOutflowForGross`. */
  effectiveBpsRedeem?: number,
): RedeemRoute {
  if (cfg.paused || !cfg.redemptionsEnabled) return "disabled";
  // Bit 1 is the redeem side (state/side.rs). `undefined` counts as NOT attested, the fail-closed direction:
  // "verification required" flipping to "Redeem" once the lookup lands is self-correcting, whereas a promised
  // "instant" that reverts KycRequired costs the user a Lazer fee to discover.
  if (((cfg.kycScopeFlags ?? 0) & 2) !== 0 && kycAttested !== true) return "kyc";
  // Both limits are on TREASURY OUTFLOW, which equals the gross only while fee routing is on.
  const outflow = redeemOutflowForGross(cfg, grossUsdc, effectiveBpsRedeem);
  if (
    effectiveRedeemUsed(cfg, nowUnixSecs)
      .add(outflow)
      .gt(cfg.instantRedeemBudgetUsdc)
  ) {
    return "limit";
  }
  if (treasuryBalanceUsdc.lt(outflow)) return "otc";
  return "instant";
}

/** Map an on-chain revert (logs / message / structured err) to a route. Matches the symbolic Anchor name AND
 *  the numeric code, because when `getTransaction` returns null right after inclusion (common RPC lag at
 *  "confirmed") the structured `value.err` is the only signal left and it carries no name. MustUseQueue
 *  (12061) is deliberately NOT mapped: it survives for discriminant stability but can no longer be raised. */
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
  // `redeem_silv` gained a minimum operation size, so this became a reachable revert
  // and had no mapping: the user saw a raw Custom:12118. It is a "too small", not a routing outcome,
  // so it returns null and the caller surfaces the dedicated message below.
  if (anchorErr(errText, "OperationBelowMinimum", 12118)) return null;
  if (anchorErr(errText, "RedeemLimitExceeded", 12103)) return "limit";
  if (anchorErr(errText, "KycRequired", 12104)) return "kyc";
  if (anchorErr(errText, "InsufficientTreasury", 12014)) return "otc";
  // The fee vault could not be paid: the treasury is short of the premium leg, which is practically the
  // same situation as InsufficientTreasury.
  if (anchorErr(errText, "InsufficientFeeVault", 12108)) return "otc";
  if (
    anchorErr(errText, "RedemptionsDisabled", 12060) ||
    anchorErr(errText, "Paused", 12000)
  )
    return "disabled";
  return null;
}

/** . `OperationBelowMinimum` on either side. Both mint and redeem raise it, so this is the
 *  one place that recognises it and the caller decides the wording. */
export function isBelowMinimumError(errText: string): boolean {
  return anchorErr(errText, "OperationBelowMinimum", 12118);
}

/** The program splits `LazerReplayed` (12121) from `LazerCarriedForward` (12082)
 *  precisely because the two have OPPOSITE remediations, and the UI mapped neither: both landed on
 *  the generic "Transaction reverted on-chain".
 *  REPLAYED means another operation consumed the same signed print. Under strict anti-replay one
 *  envelope prices exactly one operation, so this is normal contention and the answer is RETRY with a
 *  fresh price. Telling the user nothing here makes a working protocol look like a broken feed.
 */
export function isLazerReplayedError(errText: string): boolean {
  return anchorErr(errText, "LazerReplayed", 12121);
}

/** CARRIED FORWARD means the publisher repeated a previous price rather than producing a new one, so
 *  the feed itself is not advancing. Retrying immediately is the WRONG move: it burns the Lazer verify
 *  fee against a print that will be refused again. */
export function isLazerCarriedForwardError(errText: string): boolean {
  return anchorErr(errText, "LazerCarriedForward", 12082);
}

/** StaleOracle = 12004, raised on ANY Pyth-priced path when too much wall-clock passes between fetching the
 *  signed price and the tx landing. max_staleness is 15s on devnet, so a slow wallet approval trips it. */
export function isStaleOracleError(errText: string): boolean {
  return anchorErr(errText, "StaleOracle", 12004);
}

/** Canonical StaleOracle copy (single source). Action-first, so it survives the ~120-char toast slice. */
export const STALE_ORACLE_USER_MESSAGE =
  "Please retry and approve the transaction quickly. " +
  "The live oracle price expired before the transaction could confirm.";

/** Flatten an unknown error into one searchable string, INCLUDING program logs: `SendTransactionError` puts
 *  the readable Anchor lines in `.logs`, so a detector reading only `.message` misses the preflight path. */
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
    // confirmTransaction's `value.err` (and our attached `onChainErr`) is the structured
    // `{ InstructionError: [idx, { Custom: <code> }] }` shape.
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














// ---- parsing ----

// Parse a plain non-negative decimal string to atomic units (6 decimals). `<input type="number">` accepts
// scientific notation ("2e3") and these run inside a render-time useMemo, so a `new BN("2e3")` throw would
// crash the page via the error boundary. Anything but a plain decimal returns 0, which callers already guard.
function parseDecimalToAtomic6(input: string): BN {
  // TRIM ONCE, then use the trimmed value. The regex tested `input.trim` while the split used the RAW
  // input, so " ", "\t" and "\n" passed the guard (the regex allows an empty string) and then reached
  // `new BN(" ")`, whose `words` is null: a TypeError from inside a render-time useMemo, which is exactly
  // the error-boundary crash the comment above says this function exists to prevent. Unreachable today
  // because every caller guards with parseFloat first and `<input type=number>` never emits lone
  // whitespace, but the contract said "anything but a plain decimal returns 0" and it did not hold.
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t)) return new BN(0);
  const [whole = "0", frac = ""] = t.split(".");
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
