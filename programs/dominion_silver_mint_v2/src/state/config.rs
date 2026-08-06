use anchor_lang::prelude::*;

// Policy ceilings clamp every admin-settable business value. Raising one costs a program upgrade.
pub const PREMIUM_BPS_MINT_CEILING: u16 = 500; // 5%; launch value 1%
pub const PREMIUM_BPS_REDEEM_CEILING: u16 = 500; // 5%; launch value 1.5%

pub const PREMIUM_BPS_COMBINED_FLOOR: u16 = 0; // 0 disables it; the `sum >= FLOOR` checks are no-ops

// Raise-only within these bounds, never cut below 24h: "shorten the timelock, then drain" is unreachable.
pub const ADMIN_TIMELOCK_MIN_SECONDS: u32 = 86400; // 24h, == DEFAULT_ADMIN_TIMELOCK_SECONDS
pub const ADMIN_TIMELOCK_MAX_SECONDS: u32 = 604_800; // 7 days
pub const MAX_ACTIVE_PROPOSALS: u8 = 10;
pub const MAX_GUARDIAN_COUNT_DEFAULT: u8 = 3;
pub const PENDING_ADMIN_EXPIRY_SECONDS: i64 = 7 * 86400; // 7 days
pub const GUARDIAN_REMOVE_COOLDOWN_SECONDS: i64 = 3600; // 1 hour

pub const MAX_SILV_SUPPLY_CEILING: u64 = 1_000_000_000_000_000; // 1e9 oz (6dec) sanity ceiling
pub const TREASURY_FLOAT_CEILING_USDC: u64 = 100_000_000_000_000; // $100M atomic, fat-finger guard
pub const INSTANT_BUDGET_CEILING_USDC: u64 = 100_000_000_000_000; // $100M atomic, fat-finger guard
pub const INSTANT_WINDOW_MIN_SECONDS: u32 = 60; // 1 min
pub const INSTANT_WINDOW_MAX_SECONDS: u32 = 604_800; // 7 days
pub const REDEEM_QUEUE_DELAY_MAX_SECONDS: u32 = 2_592_000; // 30 days

pub const REDEEM_QUEUE_DELAY_MIN_SECONDS: u32 = 3_600; // 1 hour; forbids only the degenerate delay of 0

// Bounds the COUNT only. The real protection is deferral: guardian.rs SCHEDULES, the target can cancel.
pub const MIN_ACTIVE_GUARDIANS: u8 = 1;

// A matured removal dies if not applied inside this window, else it is a stored eviction coupon.
pub const GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS: i64 = 7 * 86400; // 7 days

// These caps are what make a worst-case borsh MetadataArgs (237) fit MAX_ACTION_DATA_BYTES (256).
pub const METADATA_NAME_MAX: usize = 32;
pub const METADATA_SYMBOL_MAX: usize = 10;
pub const METADATA_URI_MAX: usize = 180;

// Structural hard ceilings: propose and execute MUST reject any admin value above these.
pub const MAX_STALENESS_CEILING_SECONDS: u32 = 30;
pub const MAX_CONFIDENCE_BPS_CEILING: u16 = 500;
pub const MAX_PRICE_DELTA_BPS_CEILING: u16 = 1000;
pub const PRICE_FATFINGER_MIN_SCALED: u64 = 5_000_000_000; // $5; absolute rail on the setting, never raise
pub const PRICE_FATFINGER_MAX_SCALED: u64 = 200_000_000_000; // $200; same
pub const LAZER_FUTURE_SKEW_US: u64 = 2_000_000; // allowed forward publisher clock skew, 2s
pub const LAZER_CHANNEL_ID: u8 = 4; // the subscribed channel: fixed_rate@1000ms

pub const DEFAULT_MIN_PUBLISHERS: u16 = 2; // == MIN_PUBLISHERS_FLOOR_HARD: no single publisher can price

pub const DEFAULT_PREMIUM_MINT_BPS: u16 = 100; // 1%; a default only, the live value is an InitializeArgs field
pub const DEFAULT_PREMIUM_REDEEM_BPS: u16 = 150; // 1.5%; same

pub const DEFAULT_MAX_STALENESS_SECONDS: u32 = 15; // single digits break the human approve-and-land flow
pub const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 100; // 1%
pub const DEFAULT_MIN_PRICE_USD_SCALED: u64 = 5_000_000_000; // $5 * 1e9
pub const DEFAULT_MAX_PRICE_USD_SCALED: u64 = 200_000_000_000; // $200 * 1e9
pub const DEFAULT_MAX_PRICE_DELTA_BPS: u16 = 500; // 5%
pub const DEFAULT_PRICE_DELTA_DECAY_SECONDS: u32 = 3600; // 1 hour
pub const DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC: u64 = 1_000_000_000; // $1000 in USDC 6dec
pub const DEFAULT_ADMIN_TIMELOCK_SECONDS: u32 = 86400; // 24 hours

// The ONLY bound on unbacked SILV, NOT an initialize arg (get it right pre-mainnet), ONE-WAY RATCHET.
pub const DEFAULT_MAX_SILV_SUPPLY: u64 = 150_000_000_000; // 150,000 oz at 6 decimals

pub const DEFAULT_PUBLIC_MINT_ENABLED: bool = false; // opening direct mint is 24h-timelocked
pub const DEFAULT_TREASURY_MIN_FLOAT_USDC: u64 = 0; // Mark sets from panel (D7)
pub const DEFAULT_LARGE_REDEEM_THRESHOLD_USDC: u64 = 5_000_000_000; // $5k (D10)
pub const DEFAULT_INSTANT_REDEEM_BUDGET_USDC: u64 = 20_000_000_000; // $20k/window (D10)
pub const DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS: u32 = 86400; // 1 day (D10)
pub const DEFAULT_REDEEM_QUEUE_DELAY_SECONDS: u32 = 259_200; // T+3 days (D8)

pub const CONFIG_SEED: &[u8] = b"config";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const SILV_MINT_AUTHORITY_SEED: &[u8] = b"silv_mint_authority";
pub const SILV_METADATA_AUTHORITY_SEED: &[u8] = b"silv_metadata_authority";
pub const TIMELOCK_SEED: &[u8] = b"timelock";
pub const GUARDIAN_SEED: &[u8] = b"guardian";

pub const MAX_FEE_EXEMPT_TERM_SECONDS: i64 = 2 * 365 * 86400; // rail: a ms-timestamp paste is rejected

// Authority PDA of the fee vault (the vault is its ATA for `config.usdc_mint`, derivable, not stored).
// A PDA-owned ATA cannot be closed; an admin-set wallet's missing ATA would revert every mint and redeem.
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";

pub const FEE_EXEMPT_SEED: &[u8] = b"fee_exempt"; // seeded by the wallet, so it cannot be presented for another

pub const KYC_SEED: &[u8] = b"kyc"; // per-wallet attestation, same shape, dormant at launch (state/kyc.rs)

// DEPRECATED (queued path deleted). Kept declared: scripts import it, and never reuse the namespace.
pub const REDEEM_REQUEST_SEED: &[u8] = b"redeem_request";

#[account]
pub struct ConfigAccount {
    pub admin: Pubkey,                 // Ops Squads 3-of-5
    pub pending_admin: Option<Pubkey>, // 2-step transfer
    pub pending_admin_expires_at: i64,
    pub upgrade_authority_info: Pubkey, // info-only: separate Upgrade Squads

    pub permanent_delegate_expected: Pubkey, // seize/clawback (D12), external multisig
    pub freeze_authority_expected: Pubkey,   // freeze, locked at init, external multisig

    // NOT A GATE: nothing reads it to permit or deny, and flipping it only AUTO-PAUSES. The two
    // authorities above are the enforcement, exercised with direct Token-2022 transactions.
    pub compliance_mode: bool,

    pub premium_bps_mint: u16, // charged in USDC; moves are timelocked and guardian-cancellable
    pub premium_bps_redeem: u16,

    // Only the feed id is configurable. Feed 3154 is PURE SPOT: all margin lives in premium_bps_*.
    pub pyth_lazer_feed_id: u32,
    pub min_publishers: u16, // operating floor (>= MIN_PUBLISHERS_FLOOR_HARD)
    pub last_used_feed_update_timestamp_us: u64, // non-decreasing high-water mark

    pub usdc_mint: Pubkey,
    pub silv_mint: Pubkey,
    pub usdc_treasury: Pubkey,
    pub classic_token_program: Pubkey,
    pub token_2022_program: Pubkey,

    pub max_staleness_seconds: u32,
    pub max_confidence_bps: u16,
    pub min_price_usd_scaled: u64,
    pub max_price_usd_scaled: u64,

    pub last_recorded_price_scaled: u128,
    pub last_price_update_at: i64,
    pub max_price_delta_bps: u16,
    pub price_delta_decay_seconds: u32,
    pub price_update_min_amount_usdc: u64, // the breaker's dust filter (D38)

    // HARD supply cap, atomic SILV (oz * 1e6). TIGHTEN-ONLY: lowering is instant, raising is blocked.
    pub max_silv_supply: u64,

    // Blocks ADMIN withdraw only: redemptions may draw below it and then route OTC. 24h timelock.
    pub treasury_min_float_usdc: u64,

    pub redemptions_enabled: bool, // manual switch, NO auto-expiry (deliberate)

    // GLOBAL rolling-window redeem budget: ONE ceiling per window for every caller, so fresh wallets
    // cannot beat it. The only brake between a bad oracle print and the treasury leaving in one tx.
    pub large_redeem_threshold_usdc: u64, // DEAD, do not read; still DECLARED (offsets)
    pub instant_redeem_budget_usdc: u64,  // LIVE: max redeemed per window, all users

    // THE ONE FIELD WHOSE ZERO IS THE LOOSE DIRECTION: `roll_window` fails OPEN at w <= 0. Unreachable
    // (the min is 60, checked on propose and execute), but it is why fee_routing is negated: zero must be right.
    pub instant_redeem_window_seconds: u32,
    pub redeem_queue_delay_seconds: u32, // DEAD, do not read; still DECLARED (offsets)
    pub instant_window_start: i64,       // LIVE: current window start (rolling)
    pub instant_used_usdc: u64,          // LIVE: cumulative redeemed in current window

    pub next_redeem_request_nonce: u64,

    pub admin_timelock_seconds: u32, // bounds [86400, 604800] (24h..7d)

    pub max_guardian_count: u8,
    pub guardian_count: u8,

    pub mint_paused_until: i64, // front-run defense during a premium proposal

    pub paused: bool,

    pub next_timelock_nonce: u64,
    pub active_proposal_count: u8,

    pub pending_premium_mint_nonce: Option<u64>,
    pub pending_premium_redeem_nonce: Option<u64>,
    pub pending_withdraw_nonce: Option<u64>,
    pub pending_treasury_float_nonce: Option<u64>,
    pub pending_oracle_guards_nonce: Option<u64>,
    pub pending_metadata_nonce: Option<u64>,
    pub pending_compliance_nonce: Option<u64>,
    pub pending_pyth_feed_nonce: Option<u64>,
    pub pending_admin_timelock_nonce: Option<u64>,

    pub pending_admin_eta: i64, // propose sets now + admin_timelock_seconds; accept requires now >= it

    pub pending_max_supply_nonce: Option<u64>, // a future timelocked RAISE; raising is blocked at launch

    // The ONLY way to LOOSEN the redeem throttles; instant tightening is emergency_tighten_redeem_limits.
    pub pending_redeem_limits_nonce: Option<u64>,

    pub inventory_wallet: Pubkey, // the admin pre-mints against the cap into this wallet
    pub public_mint_enabled: bool, // CLOSED at launch, opens with KYC

    pub kyc_operator: Pubkey,
    pub kyc_enforced: bool,
    pub pending_kyc_operator_nonce: Option<u64>,

    pub por_feed: Pubkey,
    pub por_max_staleness_seconds: u32,
    pub por_enforced: bool,
    pub pending_por_feed_nonce: Option<u64>,

    pub mint_paused: bool, // unread: the global `paused` is what is checked until the split ships
    pub redeem_paused: bool,

    // THE RULE for a new field carved out of `reserved`: declare it AFTER `version`, immediately
    // before `reserved`, and shrink `reserved` by the same number of bytes. And: 14 `Option` fields
    // make absolute byte offsets meaningless, so reason in field ORDER only, never in offsets.
    pub pending_removal_count: u8, // scheduled but unfinalized removals; the floor nets these out

    pub version: u8, // schema version

    // Declared after `version` per THE RULE, so an in-place upgrade reads None, which is correct here.
    pub pending_public_mint_nonce: Option<u64>,

    // Bit 0 = mint, bit 1 = redeem, 0 = off (the launch posture, and what an in-place upgrade decodes).
    // `kyc_enforced` is DERIVED: the setter maintains `kyc_enforced == (kyc_scope_flags != 0)`, always.
    pub kyc_scope_flags: u8,

    // The previous bucket's usage (state/redeem_window.rs). Without it the window is fixed, not rolling.
    pub instant_used_prev_usdc: u64,

    // Escape hatch for premium routing. INVERTED NAME: false = routing ON. USDC carries a Circle freeze
    // authority and the premium transfer is unconditional, so a frozen fee-vault ATA would brick mint AND
    // redeem. Negated because a field carved from `reserved` decodes zero, which must mean routing ON.
    pub fee_routing_disabled: bool,

    /// Live count of `KycAccount`s (`attest_kyc` creates, `revoke_kyc` closes). `set_kyc_scope` refuses
    /// to arm at zero. Zero at rest holds only while the gate is dormant: else backfill before upgrading.
    pub kyc_attestation_count: u32,
    pub reserved: [u8; 40],
}

impl ConfigAccount {
    // 8-byte discriminator + struct size, pinned at 800 below: the account must never change size.
    pub const SIZE: usize = 8
        + 32                  // admin
        + 1 + 32              // pending_admin (Option)
        + 8                   // pending_admin_expires_at
        + 32                  // upgrade_authority_info
        + 32                  // permanent_delegate_expected
        + 32                  // freeze_authority_expected
        + 1                   // compliance_mode
        + 2 + 2               // premium_bps_mint + redeem
        + 4 + 2 + 8           // pyth_lazer_feed_id + min_publishers + last_used_feed_update_ts
        + 32 + 32 + 32 + 32 + 32 // mints, treasury, programs
        + 4 + 2 + 8 + 8       // staleness, conf_bps, min/max price
        + 16 + 8 + 2 + 4 + 8  // price-delta breaker
        + 8                   // max_silv_supply
        + 8                   // treasury_min_float_usdc
        + 1                   // redemptions_enabled
        + 8 + 8 + 4 + 4 + 8 + 8 // redemption routing + rolling window
        + 8                   // next_redeem_request_nonce
        + 4                   // admin_timelock
        + 1 + 1               // guardian counts
        + 8                   // mint_paused_until
        + 1                   // paused
        + 8 + 1               // nonce + active count
        + (1 + 8) * 9         // 9 Option<u64> pending nonces
        + 8                   // pending_admin_eta
        + (1 + 8)             // pending_max_supply_nonce
        + (1 + 8)             // pending_redeem_limits_nonce
        + 32 + 1              // inventory_wallet + public_mint_enabled
        + 32 + 1 + (1 + 8)    // kyc_operator + kyc_enforced + pending_kyc_operator_nonce
        + 32 + 4 + 1 + (1 + 8) // por_feed + por_max_staleness + por_enforced + pending_por_feed_nonce
        + 1 + 1               // mint_paused + redeem_paused
        + 1                   // pending_removal_count (carved out of reserved)
        + 1                   // version
        + (1 + 8)             // pending_public_mint_nonce (carved out of reserved)
        + 1                   // kyc_scope_flags (carved out of reserved)
        + 8                   // instant_used_prev_usdc (carved out of reserved)
        + 1                   // fee_routing_disabled (carved out of reserved)
        + 44; // kyc_attestation_count (4, carved out of reserved) + reserved (40)

    // A POST-write invariant, complementary to the pre-write checks at each mutation site.
    pub fn assert_premium_within_bounds(&self) -> Result<()> {
        require!(
            self.premium_bps_mint <= PREMIUM_BPS_MINT_CEILING,
            crate::errors::DominionError::PremiumTooHigh
        );
        require!(
            self.premium_bps_redeem <= PREMIUM_BPS_REDEEM_CEILING,
            crate::errors::DominionError::PremiumTooHigh
        );
        require!(
            (self.premium_bps_mint as u32) + (self.premium_bps_redeem as u32)
                >= PREMIUM_BPS_COMBINED_FLOOR as u32,
            crate::errors::DominionError::PremiumSpreadTooLow
        );
        Ok(())
    }
}

// The EXACT assert is the load-bearing one: the bounds below would pass a 200-byte drift.
const _: () = assert!(
    ConfigAccount::SIZE == 800,
    "ConfigAccount::SIZE must stay 800. New fields come out of `reserved` (declared      AFTER `version`), never appended, or every deployed config needs a realloc."
);
const _: () = assert!(
    ConfigAccount::SIZE >= 256,
    "ConfigAccount too small (forgot fields?)"
);
const _: () = assert!(
    ConfigAccount::SIZE <= 4096,
    "ConfigAccount unexpectedly large"
);
