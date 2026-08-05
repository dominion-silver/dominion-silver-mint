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
  pythLazerFeedId: number; // u32, 3154 = Metal.Index.SILVER/USD (pure spot)
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
  // Fixed-reset-window redemption budget. "Fixed", NOT sliding: the true worst case across a
  // window boundary is TWICE the budget (drain it just before the reset, then again just after).
  /** DEAD ON CHAIN since 2026-08-05: no instruction reads it. It still DECODES and still holds its
   *  $5,000 default, which is exactly how it did damage: the PUBLIC app read it and silently
   *  blocked every redemption at or above $5,000. Never read it, and never display it as live
   *  state. */
  largeRedeemThresholdUsdc: BN;
  instantRedeemBudgetUsdc: BN;
  instantRedeemWindowSeconds: number;
  /** DEAD ON CHAIN since 2026-08-05 (there is no queue). Do not read. */
  redeemQueueDelaySeconds: number;
  instantWindowStart: BN;
  instantUsedUsdc: BN;
  /** DEAD ON CHAIN since 2026-08-05 (there is no queue). Do not read. */
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
  // KYC gate (2026-08-05). Dormant at launch: kycScopeFlags == 0.
  kycOperator: PublicKey;
  /** DERIVED, never set independently: the program maintains
   *  `kycEnforced == (kycScopeFlags != 0)`, so the two can never disagree. */
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
  // Guardians currently under notice of removal (audit review of daac4ac): the
  // removal floor is evaluated against guardianCount - pendingRemovalCount.
  pendingRemovalCount: number;
  version: number;
  /** Single-active guard for the timelocked public-mint OPEN. */
  pendingPublicMintNonce: BN | null;
  /** The fee-vault escape hatch. True at init: the premium routes to the vault. False means it
   *  stays in the treasury, which is the pre-2026-08-05 behaviour and the remedy if the vault ever
   *  becomes unusable (e.g. frozen by the USDC issuer). */
  feeRoutingEnabled?: boolean;
  /** KYC scope bitfield: bit 0 = mint, bit 1 = redeem, 0 = off (the launch posture).
   *
   *  Declared explicitly because the panel reads it through an `any`-typed `current?: (c: any)`
   *  callback, where a typo would silently render "scope 0 (dormant)" for an ARMED gate and still
   *  typecheck. Optional because a config written before this upgrade decodes it as 0. */
  kycScopeFlags?: number;
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



// The queued-redemption READ path (fetchAllRedemptionRequests, RedemptionQueueResult,
// RedemptionRequestView, RedemptionStatusKind, statusKind) was REMOVED on 2026-08-05 with the
// queue itself. The `RedemptionRequest` account type no longer exists in the program or the IDL,
// so the old `program.account.redemptionRequest.all()` call would throw at runtime.

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
  // AUDIT review of daac4ac (P1, found independently by all three reviewers): this
  // rounded to 4 decimals with `Math.round(frac / 100)`, which can return 10000.
  // padStart(4) leaves "10000" untouched and the trailing-zero strip collapses it to
  // "1", so 1.999999 rendered as "1.1" and 0.999999 as "0.1": roughly 0.9 oz low,
  // silently, on the supply and cap figures an operator reads before setting a
  // TIGHTEN-ONLY cap that cannot be undone.
  //
  // Fixed by not rounding at all. All six decimals are exact (the mint has 6), and
  // trailing zeros are trimmed, so there is no carry to get wrong and no rounding
  // for the operator to reason about. Displaying more precision than before is the
  // right trade in a console where the number drives an irreversible action.
  const decimals = String(frac).padStart(6, "0").replace(/0+$/, "");
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

/**
 * One guardian's on-chain state, as the console needs to display it.
 *
 * AUDIT review of daac4ac (P1, integration reviewer): `pending_removal_at` is
 * written on-chain and was read NOWHERE in either app. DOM-007's whole security
 * property is "the targeted guardian has admin_timelock_seconds to react", and the
 * console gave that guardian no way to see that a removal had been scheduled, who is
 * targeted, or when it fires. A veto nobody can see is not a veto.
 */
/** Mirrors GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS in state/config.rs. */
export const GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS = 7 * 86400;

export type GuardianView = {
  guardian: PublicKey;
  addedAt: BN;
  cooldownUntil: BN;
  pendingRemovalAt: BN;
  selfCancelUsed: boolean;
  /**
   * Derived: whether the PROGRAM will accept this guardian's powers, which is
   * `cooldown_until == 0 && guardian != config.admin`, i.e. exactly
   * GuardianAccount::may_act.
   *
   * Review-of-fixes: this used to be `cooldown_until == 0` alone, so a guardian key
   * that IS the admin rendered as a healthy active guardian even though every
   * authorization site refuses it. That is the one state where guardian_count
   * overstates the real veto, so it is the one the roster most needs to show.
   */
  active: boolean;
  /** True when this guardian is registered but is the admin, so its powers are refused. */
  inertBecauseAdmin: boolean;
  /** True when a scheduled removal has aged out and can no longer be finalized. */
  removalExpired: boolean;
};

/**
 * Every guardian account owned by the program, newest-added first.
 *
 * Uses getProgramAccounts filtered by the GuardianAccount discriminator rather than
 * a list of known pubkeys, because nothing on-chain enumerates guardians: the config
 * holds only a COUNT, and the accounts are PDAs of keys the console does not know.
 */
export async function fetchGuardians(
  connection: Connection,
  admin?: PublicKey,
): Promise<GuardianView[]> {
  const program = getReadOnlyProgram(connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (program.account as any).guardianAccount.all();
  const nowSecs = Math.floor(Date.now() / 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows
    .map((r: any) => {
      const a = r.account;
      const g = a.guardian as PublicKey;
      const cooldownUntil = a.cooldownUntil as BN;
      const pendingRemovalAt = a.pendingRemovalAt as BN;
      const inertBecauseAdmin = admin ? g.equals(admin) : false;
      const removalExpired =
        !pendingRemovalAt.isZero() &&
        nowSecs >
          pendingRemovalAt.toNumber() + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS;
      return {
        guardian: g,
        addedAt: a.addedAt as BN,
        cooldownUntil,
        pendingRemovalAt,
        selfCancelUsed: Boolean(a.selfCancelUsed),
        active: cooldownUntil.isZero() && !inertBecauseAdmin,
        inertBecauseAdmin,
        removalExpired,
      } as GuardianView;
    })
    .sort((a: GuardianView, b: GuardianView) => b.addedAt.cmp(a.addedAt));
}

/**
 * Seconds until `ts`, or null when nothing is scheduled. Negative once elapsed.
 *
 * Review-of-fixes F14: this called `ts.toNumber()`, which THROWS above 2^53 ("Number
 * can only safely store up to 53 bits"). It is called twice per row inside the
 * guardian roster's render, so a single out-of-range i64 would unmount the entire
 * Dashboard rather than degrade one cell. The guardian tests assert i64::MAX is
 * reachable in that field, so this is not hypothetical. Clamped instead: any absurd
 * timestamp reads as "very far away", which is the correct display semantics and
 * cannot throw.
 */
const MAX_SAFE_TS = Number.MAX_SAFE_INTEGER;
export function secondsUntil(ts: BN, nowSeconds?: number): number | null {
  if (ts.isZero()) return null;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const MAX = new BN(MAX_SAFE_TS.toString());
  if (ts.gt(MAX)) return MAX_SAFE_TS - now;
  if (ts.neg().gt(MAX)) return -MAX_SAFE_TS;
  return ts.toNumber() - now;
}

/** "in 23h 59m" / "elapsed 2h ago", for a countdown an operator can act on. */
export function formatCountdown(seconds: number): string {
  // Review-of-fixes F14: returned "in Infinityd NaNh" for non-finite input.
  if (!Number.isFinite(seconds)) return "unknown";
  const abs = Math.abs(seconds);
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const parts = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return seconds >= 0 ? `in ${parts}` : `elapsed ${parts} ago`;
}
