/**
 * Admin anchor client (V2 / Option B).
 * Read-only helpers for the Dominion Silver admin console. Transaction
 * construction for admin actions routes through the Squads multisig proposer
 * (see squads.ts) and is intentionally NOT built here.
 */
import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./idl/dominion_silver_mint.json";
import { PROGRAM_ID, USDC_MINT, SILV_MINT } from "./constants";
import { configPda, treasuryPda } from "./pdas";

/**
 * Mirror programs/dominion_silver_mint_v2/src/state/config.rs ConfigAccount
 * (Option B). snake_case -> camelCase exactly as Anchor decodes from the IDL.
 * Option A fields (mint/redeem/daily/hourly caps, treasury_min_reserve_bps,
 * reserve_check_price_scaled) are GONE in V2 and removed here.
 */
export interface ConfigAccount {
  // Authorities
  admin: PublicKey;
  pendingAdmin: PublicKey | null;
  pendingAdminExpiresAt: BN;
  upgradeAuthorityInfo: PublicKey;
  // Compliance
  permanentDelegateExpected: PublicKey;
  freezeAuthorityExpected: PublicKey;
  complianceMode: boolean;
  // Premium
  premiumBpsMint: number;
  premiumBpsRedeem: number;
  // Oracle (Pyth Lazer). The Core pythFeedId[32] + pythReceiverProgram were
  // removed in the Lazer migration; these are the new fields the account
  // actually carries (Fable audit P2-C).
  pythLazerFeedId: number; // u32, SILV = 3304
  minPublishers: number; // u16, operating publisher floor
  lastUsedFeedUpdateTimestampUs: BN; // u64, non-decreasing high-water mark
  // Pinned token program ids
  usdcMint: PublicKey;
  silvMint: PublicKey;
  usdcTreasury: PublicKey;
  classicTokenProgram: PublicKey;
  token2022Program: PublicKey;
  // Oracle guards
  maxStalenessSeconds: number;
  maxConfidenceBps: number;
  minPriceUsdScaled: BN;
  maxPriceUsdScaled: BN;
  // Price-delta circuit breaker
  lastRecordedPriceScaled: BN; // u128, scale 1e9
  lastPriceUpdateAt: BN;
  maxPriceDeltaBps: number;
  priceDeltaDecaySeconds: number;
  priceUpdateMinAmountUsdc: BN;
  // D2: hard supply cap (atomic SILV, oz * 1e6)
  maxSilvSupply: BN;
  // D7: admin-withdraw float floor (atomic USDC)
  treasuryMinFloatUsdc: BN;
  // D11: manual redemptions switch
  redemptionsEnabled: boolean;
  // routing + fixed-reset-window instant budget
  largeRedeemThresholdUsdc: BN;
  instantRedeemBudgetUsdc: BN;
  instantRedeemWindowSeconds: number;
  redeemQueueDelaySeconds: number;
  instantWindowStart: BN;
  instantUsedUsdc: BN;
  // D5/D9: queued-redemption nonce
  nextRedeemRequestNonce: BN;
  // Timelock + guardians
  adminTimelockSeconds: number;
  maxGuardianCount: number;
  guardianCount: number;
  // Mint pause window
  mintPausedUntil: BN;
  // Global pause
  paused: boolean;
  // Timelock proposal tracking
  nextTimelockNonce: BN;
  activeProposalCount: number;
  // Single-active-per-kind pending nonces
  pendingPremiumMintNonce: BN | null;
  pendingPremiumRedeemNonce: BN | null;
  pendingWithdrawNonce: BN | null;
  pendingTreasuryFloatNonce: BN | null;
  pendingOracleGuardsNonce: BN | null;
  pendingMetadataNonce: BN | null;
  pendingComplianceNonce: BN | null;
  pendingPythFeedNonce: BN | null;
  pendingAdminTimelockNonce: BN | null;
  // Admin-transfer ETA + the redeem-limits / max-supply pending nonces
  pendingAdminEta: BN;
  pendingMaxSupplyNonce: BN | null;
  pendingRedeemLimitsNonce: BN | null;
  // Inventory + public-mint gate
  inventoryWallet: PublicKey;
  publicMintEnabled: boolean;
  // KYC
  kycOperator: PublicKey;
  kycEnforced: boolean;
  pendingKycOperatorNonce: BN | null;
  // Proof-of-reserves feed
  porFeed: PublicKey;
  porMaxStalenessSeconds: number;
  porEnforced: boolean;
  pendingPorFeedNonce: BN | null;
  // Split pause flags (mint vs redeem)
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

export interface DashboardSnapshot {
  cfg: ConfigAccount;
  treasuryUsdc: BN;
  silvSupply: BN;
  // Option B derived:
  supplyUtilizationBps: number | null; // silvSupply / maxSilvSupply, bps
  instantBudgetRemainingUsdc: BN; // window-aware remaining instant budget
  instantWindowExpired: boolean; // true => budget effectively reset
  instantWindowNeverStarted: boolean; // window_start == 0 (no instant redeem ever)
  treasuryFloatOk: boolean; // treasury >= treasury_min_float_usdc
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

/**
 * Snapshot fetch: config + treasury USDC + SILV supply in parallel.
 * Returns null if config not yet initialized.
 */
export async function fetchDashboardSnapshot(
  connection: Connection,
): Promise<DashboardSnapshot | null> {
  const program = getReadOnlyProgram(connection);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await (program.account as any).configAccount.fetchNullable(
    configPda(),
  );
  if (!cfg) return null;

  const treasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
    true,
    TOKEN_PROGRAM_ID,
  );

  const [balanceInfo, supplyInfo] = await Promise.allSettled([
    connection.getTokenAccountBalance(treasuryAta),
    connection.getTokenSupply(SILV_MINT),
  ]);

  const treasuryUsdc =
    balanceInfo.status === "fulfilled"
      ? new BN(balanceInfo.value.value.amount)
      : new BN(0);
  const silvSupply =
    supplyInfo.status === "fulfilled"
      ? new BN(supplyInfo.value.value.amount)
      : new BN(0);

  const c = cfg as ConfigAccount;

  // Supply utilization vs the hard cap (Option B replaces the reserve ratio).
  let supplyUtilizationBps: number | null = null;
  if (!c.maxSilvSupply.isZero()) {
    supplyUtilizationBps = silvSupply
      .mul(new BN(10_000))
      .div(c.maxSilvSupply)
      .toNumber();
  }

  // Window-aware instant budget remaining (mirrors the contract's fixed-reset
  // window: if now >= window_start + window_seconds the used counter is
  // logically zero again). The contract bootstraps instant_window_start = 0
  // and only sets it to `now` on the first instant redeem after expiry, so a
  // never-redeemed config has start == 0 (treated as "no window yet", not a
  // reset of a real window - budget is still logically full).
  const nowSecs = Math.floor(Date.now() / 1000);
  const instantWindowNeverStarted = c.instantWindowStart.isZero();
  const windowEnd = c.instantWindowStart
    .add(new BN(c.instantRedeemWindowSeconds))
    .toNumber();
  const instantWindowExpired =
    !instantWindowNeverStarted && nowSecs >= windowEnd;
  const usedThisWindow =
    instantWindowNeverStarted || instantWindowExpired
      ? new BN(0)
      : c.instantUsedUsdc;
  let instantBudgetRemainingUsdc = c.instantRedeemBudgetUsdc.sub(usedThisWindow);
  if (instantBudgetRemainingUsdc.ltn(0)) {
    instantBudgetRemainingUsdc = new BN(0);
  }

  const treasuryFloatOk = treasuryUsdc.gte(c.treasuryMinFloatUsdc);

  return {
    cfg: c,
    treasuryUsdc,
    silvSupply,
    supplyUtilizationBps,
    instantBudgetRemainingUsdc,
    instantWindowExpired,
    instantWindowNeverStarted,
    treasuryFloatOk,
  };
}

function statusKind(s: unknown): RedemptionStatusKind {
  const k = Object.keys(s as object)[0];
  if (k === "claimed") return "claimed";
  if (k === "settledOffchain") return "settledOffchain";
  return "pending";
}

/**
 * ALL redemption requests across every user (admin OTC-queue view). The owner
 * filter is intentionally absent: the admin needs the full Pending list,
 * especially requests past claimable_at that the on-chain treasury cannot
 * cover (those become OTC IOUs settled via admin_settle_redemption_offchain).
 * Sorted oldest-requested first so the operator works the backlog in order.
 */
/**
 * CODEX P2-01 (+ review-of-fixes): the UI must distinguish "genuinely empty
 * queue" from "the read failed / RPC degraded" - a queued redemption already
 * burned SILV and is a durable on-chain IOU that must NOT be hidden.
 *
 * IMPORTANT: this fetcher THROWS on failure (it does NOT resolve with a
 * degraded-empty object). A resolved value is treated by SWR as success and
 * BYPASSES `keepPreviousData`, which would overwrite the last good queue
 * with empty and HIDE real IOUs (the exact P2-01 bug). By throwing, SWR
 * keeps the last successful `data` and exposes `error`; the Dashboard then
 * shows the last-known queue WITH a degraded banner, instead of an empty
 * one. `RedemptionQueueResult` remains the prop shape the Dashboard builds
 * from (last-good requests + degraded = SWR error state).
 */
export interface RedemptionQueueResult {
  requests: RedemptionRequestView[];
  degraded: boolean; // derived from SWR error; requests may be last-good/stale
  error?: string;
}

export async function fetchAllRedemptionRequests(
  connection: Connection,
): Promise<RedemptionRequestView[]> {
  const program = getReadOnlyProgram(connection);
  try {
    // getProgramAccounts is heavy and the public devnet RPC frequently
    // rate-limits or blocks it. Bound it so a hung/blocked call fails fast
    // (-> SWR error -> keepPreviousData retains the last good queue)
    // instead of hanging the SWR forever.
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("redemptionRequest.all timed out")), 12_000),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (await Promise.race([
      (program.account as any).redemptionRequest.all(),
      timeout,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ])) as any[];
    return all
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => ({
        pubkey: a.publicKey as PublicKey,
        owner: a.account.owner as PublicKey,
        amountSilv: a.account.amountSilv as BN,
        requestedAt: (a.account.requestedAt as BN).toNumber(),
        claimableAt: (a.account.claimableAt as BN).toNumber(),
        nonce: a.account.nonce as BN,
        status: statusKind(a.account.status),
      }))
      .sort(
        (x: RedemptionRequestView, y: RedemptionRequestView) =>
          x.requestedAt - y.requestedAt,
      );
  } catch (e) {
    console.error("fetchAllRedemptionRequests error", e);
    throw e instanceof Error
      ? e
      : new Error(String(e));
  }
}

// ---- formatting ----

/** Raw u64 BN (6 decimals) -> display USD string.
 *
 * AUDIT finding A-29: this used `raw.div(1e6).toNumber()`, an INTEGER division
 * that discarded the fractional part before formatting, so every USD figure in
 * the console silently lost its cents ($1,234.56 rendered as "1,234"). The
 * `maximumFractionDigits: 2` was therefore decorative. Now the atomic amount is
 * split into whole and fractional parts so the cents survive, and the result is
 * still grouped for readability. */
export function formatUsdc(raw: BN): string {
  const MICRO = new BN(1_000_000);
  const neg = raw.isNeg();
  const abs = neg ? raw.neg() : raw;
  const whole = abs.div(MICRO).toString();
  const micros = abs.mod(MICRO).toNumber(); // 0..999_999, safe in a JS number
  const grouped = Number(whole).toLocaleString("en-US");
  // Round micros to cents, carrying into the whole part when it rounds up.
  const cents = Math.round(micros / 10_000);
  if (cents === 100) {
    const carried = (Number(whole) + 1).toLocaleString("en-US");
    return `${neg ? "-" : ""}${carried}.00`;
  }
  return `${neg ? "-" : ""}${grouped}.${String(cents).padStart(2, "0")}`;
}

/** Raw u64 BN (6 decimals) -> display SILV/oz count string. */
export function formatSilv(raw: BN): string {
  // AUDIT follow-up to A-29: `raw.toNumber()` THROWS above 2^53. It is bounded
  // safe today because MAX_SILV_SUPPLY_CEILING (1e15 atomic) sits under 2^53, but
  // it would throw rather than misformat if that ceiling ever moved, and the whole
  // point of the A-29 fix was to stop doing lossy arithmetic on BN before display.
  // Split into whole and fractional parts instead, so no intermediate exceeds 2^53.
  const MICRO = new BN(1_000_000);
  const neg = raw.isNeg();
  const abs = neg ? raw.neg() : raw;
  const whole = Number(abs.div(MICRO).toString()).toLocaleString("en-US");
  const frac = abs.mod(MICRO).toNumber(); // 0..999_999
  if (frac === 0) return `${neg ? "-" : ""}${whole}`;
  // Up to 4 decimals, trailing zeros trimmed, matching the previous display.
  const decimals = String(Math.round(frac / 100))
    .padStart(4, "0")
    .replace(/0+$/, "");
  return decimals.length
    ? `${neg ? "-" : ""}${whole}.${decimals}`
    : `${neg ? "-" : ""}${whole}`;
}

/**
 * Scaled price (1e9 = oracle.rs PRICE_SCALE) -> "$/oz" display.
 * last_recorded_price_scaled is u128 on-chain; BN.toNumber() is safe here
 * (a silver price ~ 3e10 scaled << 2^53).
 */
export function formatPrice(scaled: BN): string {
  if (scaled.isZero()) return "0.0000";
  return (scaled.toNumber() / 1_000_000_000).toFixed(4);
}

export const PROGRAM_ID_STR = PROGRAM_ID.toBase58();
