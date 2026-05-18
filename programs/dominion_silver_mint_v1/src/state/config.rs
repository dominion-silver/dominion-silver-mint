use anchor_lang::prelude::*;

// Hard bounds (compile-time policy ceilings).
pub const PREMIUM_BPS_HARD_CEILING: u16 = 3000; // 30% per side
pub const PREMIUM_BPS_COMBINED_FLOOR: u16 = 500; // 5% combined min
pub const ADMIN_TIMELOCK_MIN_SECONDS: u32 = 3600; // 1 hour
pub const ADMIN_TIMELOCK_MAX_SECONDS: u32 = 2_592_000; // 30 days
pub const MAX_ACTIVE_PROPOSALS: u8 = 10;
pub const MAX_GUARDIAN_COUNT_DEFAULT: u8 = 3;
pub const PENDING_ADMIN_EXPIRY_SECONDS: i64 = 7 * 86400; // 7 days
pub const GUARDIAN_REMOVE_COOLDOWN_SECONDS: i64 = 3600; // 1 hour

// Default launch values.
pub const DEFAULT_PREMIUM_MINT_BPS: u16 = 1000; // 10%
pub const DEFAULT_PREMIUM_REDEEM_BPS: u16 = 200; // 2%
pub const DEFAULT_MAX_STALENESS_SECONDS: u32 = 15;
pub const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 100; // 1%
pub const DEFAULT_MIN_PRICE_USD_SCALED: u64 = 5_000_000_000; // $5 * 1e9
pub const DEFAULT_MAX_PRICE_USD_SCALED: u64 = 200_000_000_000; // $200 * 1e9
pub const DEFAULT_MAX_PRICE_DELTA_BPS: u16 = 500; // 5%
pub const DEFAULT_PRICE_DELTA_DECAY_SECONDS: u32 = 3600; // 1 hour
pub const DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC: u64 = 1_000_000_000; // $1000 in USDC 6dec
pub const DEFAULT_RESERVE_PRICE_RAMP_BPS: u16 = 1000; // 10%/hour upward
pub const DEFAULT_TREASURY_MIN_RESERVE_BPS: u16 = 2000; // 20% at launch
pub const DEFAULT_HOURLY_REDEEM_CAP_BPS: u16 = 1000; // 10% of snapshot
pub const DEFAULT_ADMIN_TIMELOCK_SECONDS: u32 = 86400; // 24 hours

// PDA seeds.
pub const CONFIG_SEED: &[u8] = b"config";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const SILV_MINT_AUTHORITY_SEED: &[u8] = b"silv_mint_authority";
pub const SILV_METADATA_AUTHORITY_SEED: &[u8] = b"silv_metadata_authority";
pub const DAILY_SEED: &[u8] = b"daily";
pub const HOURLY_SEED: &[u8] = b"hourly";
pub const TIMELOCK_SEED: &[u8] = b"timelock";
pub const GUARDIAN_SEED: &[u8] = b"guardian";

#[account]
pub struct ConfigAccount {
    // Authorities
    pub admin: Pubkey,                 // Ops Squads 3-of-5
    pub pending_admin: Option<Pubkey>, // 2-step transfer
    pub pending_admin_expires_at: i64,
    pub upgrade_authority_info: Pubkey, // info-only: separate Upgrade Squads

    // Compliance
    pub permanent_delegate_expected: Pubkey, // Ops Squads vault PDA, locked at init
    pub compliance_mode: bool,

    // Premium
    pub premium_bps_mint: u16,
    pub premium_bps_redeem: u16,

    // Oracle
    pub pyth_feed_id: [u8; 32],
    pub pyth_receiver_program: Pubkey,

    // Token program ids (pinned)
    pub usdc_mint: Pubkey,
    pub silv_mint: Pubkey,
    pub usdc_treasury: Pubkey,
    pub classic_token_program: Pubkey,
    pub token_2022_program: Pubkey,

    // Oracle guards
    pub max_staleness_seconds: u32,
    pub max_confidence_bps: u16,
    pub min_price_usd_scaled: u64,
    pub max_price_usd_scaled: u64,

    // Price-delta circuit breaker (D11 + D38 dust filter)
    pub last_recorded_price_scaled: u128,
    pub last_price_update_at: i64,
    pub max_price_delta_bps: u16,
    pub price_delta_decay_seconds: u32,
    pub price_update_min_amount_usdc: u64,

    // Slow-tracking reserve check price (D41).
    // Tracked separately from `last_price_update_at` to avoid rubber-band: dust-filtered txs
    // keep `last_price_update_at` stale, which would otherwise inflate the upward ramp.
    pub reserve_check_price_scaled: u128,
    pub reserve_check_price_max_increase_per_hour_bps: u16,
    pub reserve_check_price_last_update_at: i64,

    // Per-tx and daily caps (D43: USDC equivalent terms)
    pub min_mint_amount_usdc: u64,
    pub max_mint_amount_per_tx_usdc: u64,
    pub min_redeem_amount_usdc: u64,
    pub max_redeem_amount_per_tx_usdc: u64,
    pub daily_mint_cap_usdc: u64,
    pub daily_redeem_cap_usdc: u64,

    // Hourly redeem cap (D16 snapshot bound)
    pub hourly_redeem_cap_bps_of_snapshot: u16,

    // Treasury invariant
    pub treasury_min_reserve_bps: u16, // D17 launch 20%, ramp later

    // Timelock
    pub admin_timelock_seconds: u32, // bounds [3600, 30d]

    // Guardians
    pub max_guardian_count: u8,
    pub guardian_count: u8,

    // Mint pause window (D30)
    pub mint_paused_until: i64,

    // Global pause
    pub paused: bool,

    // Timelock proposal tracking
    pub next_timelock_nonce: u64,
    pub active_proposal_count: u8,

    // Single-active per kind (D35)
    pub pending_premium_mint_nonce: Option<u64>,
    pub pending_premium_redeem_nonce: Option<u64>,
    pub pending_withdraw_nonce: Option<u64>,
    pub pending_min_reserve_nonce: Option<u64>,
    pub pending_oracle_guards_nonce: Option<u64>,
    pub pending_metadata_nonce: Option<u64>,
    pub pending_compliance_nonce: Option<u64>,
    pub pending_pyth_feed_nonce: Option<u64>,
    pub pending_admin_timelock_nonce: Option<u64>,

    // Schema
    pub version: u8,
    pub reserved: [u8; 64],
}

impl ConfigAccount {
    // Anchor 8-byte discriminator + struct size.
    // Loose upper bound; verified at compile time below.
    pub const SIZE: usize = 8
        + 32                  // admin
        + 1 + 32              // pending_admin (Option)
        + 8                   // pending_admin_expires_at
        + 32                  // upgrade_authority_info
        + 32                  // permanent_delegate_expected
        + 1                   // compliance_mode
        + 2 + 2               // premium_bps_mint + redeem
        + 32                  // pyth_feed_id
        + 32                  // pyth_receiver_program
        + 32 + 32 + 32 + 32 + 32 // mints, treasury, programs
        + 4 + 2 + 8 + 8       // staleness, conf_bps, min/max price
        + 16 + 8 + 2 + 4 + 8  // price-delta breaker
        + 16 + 2 + 8          // reserve_check_price + last_update_at
        + 8 * 6               // caps in USDC
        + 2                   // hourly cap bps
        + 2                   // min_reserve bps
        + 4                   // admin_timelock
        + 1 + 1               // guardian counts
        + 8                   // mint_paused_until
        + 1                   // paused
        + 8 + 1               // nonce + active count
        + (1 + 8) * 9         // 9 Option<u64> pending nonces
        + 1                   // version
        + 64; // reserved

    pub fn assert_premium_within_bounds(&self) -> Result<()> {
        require!(
            self.premium_bps_mint <= PREMIUM_BPS_HARD_CEILING,
            crate::errors::DominionError::PremiumTooHigh
        );
        require!(
            self.premium_bps_redeem <= PREMIUM_BPS_HARD_CEILING,
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

// Compile-time sanity check on ConfigAccount size.
// Solana account hard cap is 10MiB; Anchor `init` rent-exempts based on declared space.
// We assert size is in a sensible range to catch accidental size explosion.
const _: () = assert!(
    ConfigAccount::SIZE >= 256,
    "ConfigAccount too small (forgot fields?)"
);
const _: () = assert!(
    ConfigAccount::SIZE <= 4096,
    "ConfigAccount unexpectedly large"
);
