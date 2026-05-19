use anchor_lang::prelude::*;

// Hard bounds (compile-time policy ceilings). The "parametrable within safe
// bounds" discipline: every business value is admin-settable but clamped here
// so a compromised or fat-finger admin cannot set a catastrophic value.
// CODEX P1-01: per-side premium ceilings aligned to CONFIRMED_SPEC.md §6
// (premium_bps_mint 0..2000, premium_bps_redeem 0..1000). Was a single
// 3000-bps ceiling for both, which diverged from the locked spec.
pub const PREMIUM_BPS_MINT_CEILING: u16 = 2000; // 20% (spec §6)
pub const PREMIUM_BPS_REDEEM_CEILING: u16 = 1000; // 10% (spec §6)
pub const PREMIUM_BPS_COMBINED_FLOOR: u16 = 500; // 5% combined min

// CODEX P1-02 / M-02: the official Pyth Solana pull-oracle receiver program
// (same address mainnet+devnet). Hard-pinned at init AND on every
// set_pyth_feed propose/execute, so the timelocked admin can change only the
// FEED ID, never swap the oracle to a malicious receiver. Single source of
// truth, used by initialize.rs + admin/propose.rs + admin/execute.rs.
pub const PYTH_RECEIVER_OFFICIAL: anchor_lang::prelude::Pubkey =
    anchor_lang::solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const ADMIN_TIMELOCK_MIN_SECONDS: u32 = 3600; // 1 hour (spec §6)
                                                  // CODEX P1-01: spec §6 caps admin timelock at 604_800s (7 days). Was 30 days.
pub const ADMIN_TIMELOCK_MAX_SECONDS: u32 = 604_800; // 7 days (spec §6)
pub const MAX_ACTIVE_PROPOSALS: u8 = 10;
pub const MAX_GUARDIAN_COUNT_DEFAULT: u8 = 3;
pub const PENDING_ADMIN_EXPIRY_SECONDS: i64 = 7 * 86400; // 7 days
pub const GUARDIAN_REMOVE_COOLDOWN_SECONDS: i64 = 3600; // 1 hour

// Option B hard bounds.
pub const MAX_SILV_SUPPLY_CEILING: u64 = 1_000_000_000_000_000; // 1e9 oz (6dec) sanity ceiling
pub const TREASURY_FLOAT_CEILING_USDC: u64 = 100_000_000_000_000; // $100M atomic, fat-finger guard
pub const INSTANT_BUDGET_CEILING_USDC: u64 = 100_000_000_000_000; // $100M atomic, fat-finger guard
pub const INSTANT_WINDOW_MIN_SECONDS: u32 = 60; // 1 min
pub const INSTANT_WINDOW_MAX_SECONDS: u32 = 604_800; // 7 days
pub const REDEEM_QUEUE_DELAY_MAX_SECONDS: u32 = 2_592_000; // 30 days

// Default launch values.
pub const DEFAULT_PREMIUM_MINT_BPS: u16 = 1000; // 10%
pub const DEFAULT_PREMIUM_REDEEM_BPS: u16 = 200; // 2%
// 60s (1 min). Thomas-decided 2026-05-19 (was 15s). Set at `initialize`
// only, so this governs the MAINNET launch value; the already-deployed
// devnet program keeps its baked 15s (NOT redeployed). 60s gives the
// human two-popup mint flow (post Pyth price, sign, then sign mint)
// comfortable headroom: the automated flow needs ~5s, a human clicking
// two wallet prompts routinely exceeded the old 15s and hit StaleOracle.
// Well within the propose-side oracle-guard ceiling of 300s.
pub const DEFAULT_MAX_STALENESS_SECONDS: u32 = 60;
pub const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 100; // 1%
pub const DEFAULT_MIN_PRICE_USD_SCALED: u64 = 5_000_000_000; // $5 * 1e9
pub const DEFAULT_MAX_PRICE_USD_SCALED: u64 = 200_000_000_000; // $200 * 1e9
pub const DEFAULT_MAX_PRICE_DELTA_BPS: u16 = 500; // 5%
pub const DEFAULT_PRICE_DELTA_DECAY_SECONDS: u32 = 3600; // 1 hour
pub const DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC: u64 = 1_000_000_000; // $1000 in USDC 6dec
pub const DEFAULT_ADMIN_TIMELOCK_SECONDS: u32 = 86400; // 24 hours

// Option B launch defaults (all admin-tunable post-deploy from the panel).
pub const DEFAULT_MAX_SILV_SUPPLY: u64 = 712_000_000; // 712 oz at 6 decimals (D2)
pub const DEFAULT_TREASURY_MIN_FLOAT_USDC: u64 = 0; // Mark sets from panel (D7)
pub const DEFAULT_LARGE_REDEEM_THRESHOLD_USDC: u64 = 5_000_000_000; // $5k (D10)
pub const DEFAULT_INSTANT_REDEEM_BUDGET_USDC: u64 = 20_000_000_000; // $20k/window (D10)
pub const DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS: u32 = 86400; // 1 day (D10)
pub const DEFAULT_REDEEM_QUEUE_DELAY_SECONDS: u32 = 259_200; // T+3 days (D8)

// PDA seeds.
pub const CONFIG_SEED: &[u8] = b"config";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const SILV_MINT_AUTHORITY_SEED: &[u8] = b"silv_mint_authority";
pub const SILV_METADATA_AUTHORITY_SEED: &[u8] = b"silv_metadata_authority";
pub const TIMELOCK_SEED: &[u8] = b"timelock";
pub const GUARDIAN_SEED: &[u8] = b"guardian";
pub const REDEEM_REQUEST_SEED: &[u8] = b"redeem_request";

#[account]
pub struct ConfigAccount {
    // Authorities
    pub admin: Pubkey,                 // Ops Squads 3-of-5
    pub pending_admin: Option<Pubkey>, // 2-step transfer
    pub pending_admin_expires_at: i64,
    pub upgrade_authority_info: Pubkey, // info-only: separate Upgrade Squads

    // Compliance (D12: PermanentDelegate kept)
    pub permanent_delegate_expected: Pubkey, // Ops Squads vault PDA, locked at init
    pub compliance_mode: bool,

    // Premium (D3/D4: ordinary USDC; launch discount = lower premium then restore)
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

    // D2: HARD supply cap, atomic SILV (oz * 1e6). Admin-raisable (instant).
    pub max_silv_supply: u64,

    // D7: withdraw float. Blocks ADMIN withdraw only (option a); redemptions can
    // draw the treasury below it, then route OTC. Admin-settable, 24h timelock.
    pub treasury_min_float_usdc: u64,

    // D11: manual redemptions switch (NO auto-expiry, Mark's explicit choice).
    pub redemptions_enabled: bool,

    // D8/D10: redemption routing + Sybil-proof global rolling-window instant budget.
    pub large_redeem_threshold_usdc: u64, // single redeem >= this is forced to T+3 queue
    pub instant_redeem_budget_usdc: u64,  // max instant per window, all users combined
    pub instant_redeem_window_seconds: u32,
    pub redeem_queue_delay_seconds: u32, // T+3 default
    pub instant_window_start: i64,       // current window start (rolling, reset-based)
    pub instant_used_usdc: u64,          // cumulative instant redeemed in current window

    // D5/D9: queued-redemption request PDA uniqueness nonce.
    pub next_redeem_request_nonce: u64,

    // Timelock
    pub admin_timelock_seconds: u32, // bounds [3600, 604800] (1h..7d, CONFIRMED_SPEC §6)

    // Guardians
    pub max_guardian_count: u8,
    pub guardian_count: u8,

    // Mint pause window (D30: front-run defense during a premium proposal)
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
    pub pending_treasury_float_nonce: Option<u64>,
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
    // Anchor 8-byte discriminator + struct size. Loose upper bound; verified
    // at compile time below.
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
        + 1                   // version
        + 64; // reserved

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

// Compile-time sanity check on ConfigAccount size.
const _: () = assert!(
    ConfigAccount::SIZE >= 256,
    "ConfigAccount too small (forgot fields?)"
);
const _: () = assert!(
    ConfigAccount::SIZE <= 4096,
    "ConfigAccount unexpectedly large"
);
