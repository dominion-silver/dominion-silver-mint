use anchor_lang::prelude::*;

// Hard bounds (compile-time policy ceilings). The "parametrable within safe
// bounds" discipline: every business value is admin-settable but clamped here
// so a compromised or fat-finger admin cannot set a catastrophic value.
// CODEX P1-01: per-side premium ceilings aligned to CONFIRMED_SPEC.md §6
// (premium_bps_mint 0..2000, premium_bps_redeem 0..1000). Was a single
// 3000-bps ceiling for both, which diverged from the locked spec.
pub const PREMIUM_BPS_MINT_CEILING: u16 = 300; // 3% (launch spec 2026-07: mint 1.5%, hard cap 3%)
pub const PREMIUM_BPS_REDEEM_CEILING: u16 = 500; // 5% (launch spec 2026-07: redeem 2%, hard cap 5%)
// Combined premium floor REMOVED (launch spec 2026-07): mint 1.5% + redeem 2% =
// 3.5% sits below the old 5% floor, so the floor conflicts with the target fees.
// Set to 0 so the existing `sum >= FLOOR` checks (config.rs, initialize, propose,
// execute, dev) become harmless no-ops. A later cleanup can delete those sites +
// the unused PremiumSpreadTooLow error.
pub const PREMIUM_BPS_COMBINED_FLOOR: u16 = 0;

// Pyth Lazer migration: the Core receiver-program pin (PYTH_RECEIVER_OFFICIAL)
// was removed. Lazer's program / storage / treasury are hard-pinned constants
// in lazer_cpi.rs, validated on every verify CPI.
// Launch spec 2026-07 (FIX C): raised from 3600 (1h) to 86400 (24h). The admin
// timelock can now only be RAISED (24h..7d), never reduced below 24h, so the
// "reduce to 1h then push a drain in a weekend" attack the head-dev flagged is
// closed. DEFAULT_ADMIN_TIMELOCK_SECONDS == this floor, so the timelock starts at
// the floor.
pub const ADMIN_TIMELOCK_MIN_SECONDS: u32 = 86400; // 24 hours (launch spec 2026-07)
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
// AUDIT WAVE 0, finding DOM-006 (P1): the queue delay had NO lower bound while
// its sibling `instant_redeem_window_seconds` had both (see
// validate_redeem_limits_ceilings). That asymmetry let the 24h-timelocked loosen
// path set the delay to 0, which makes a queued request claimable in the SAME
// slot it is created. That matters because the queued path performs NO volume
// accounting at all: it never reads instant_redeem_budget_usdc,
// instant_used_usdc or large_redeem_threshold_usdc (those live only in
// redeem_silv.rs), so the delay is currently the ONLY throttle on it.
//
// This is a HARD floor in the same "hard floor vs operating value" tiering the
// codebase already uses for min_publishers: the code-enforced minimum simply
// forbids the degenerate same-transaction case, while the OPERATING value is set
// far higher (DEFAULT_REDEEM_QUEUE_DELAY_SECONDS = T+3 days).
//
// Honest scope note: 1 hour alone is NOT adequate protection for a reopened
// redeem path. It bounds the degenerate case only. Before Phase 1 reopens
// redemptions, the queued path must also debit a volume budget (audit action
// 2.4), otherwise the treasury is protected by nothing but its own balance.
pub const REDEEM_QUEUE_DELAY_MIN_SECONDS: u32 = 3_600; // 1 hour, hard floor only

// AUDIT WAVE 0, finding DOM-007 (P1): `remove_guardian` was instant and
// admin-only with no floor, so ONE admin signature could strip the ENTIRE
// guardian veto and then proceed with whatever the veto existed to stop. The
// guardian exists specifically as an independent control against a compromised
// admin, and FIX A (loosen-slow) plus FIX B (admin-transfer delay) both rely on
// guardian cancellation, so that circularity voided the protection.
//
// Decision (Thomas, 2026-07-25): the hybrid model. Instant removal stays
// available for its legitimate purpose (ejecting a misbehaving guardian fast),
// but it may never take the active set below this floor. Removal below the floor
// is REFUSED outright rather than timelocked, so rotation needs no new
// machinery: add the replacement first, then remove the old one ("always swap,
// never leave zero").
//
// !! READ THIS BEFORE TRUSTING THE GUARDIAN VETO !!
//
// THIS FLOOR IS NOT SUFFICIENT, and an earlier version of this comment wrongly
// claimed it was. The triple-review of 2026-07-25 demonstrated the bypass: since
// `add_guardian` is ALSO instant and admin-only and does not vet the key, a
// compromised admin can walk the set down while keeping the count at the floor:
//
//     remove_guardian(G1)          // 3 -> 2, passes the floor
//     add_guardian(attacker_key)   // 2 -> 3
//     remove_guardian(G2)          // 3 -> 2
//     remove_guardian(G3)          // 2 -> 1, passes the floor
//     // the only "active guardian" left is a key the attacker controls
//
// So what this constant guarantees is exactly `guardian_count >= 1`, NOT that an
// independent party holds a veto. The circularity that FIX A (loosen-slow) and
// FIX B (admin-transfer delay) depend on is therefore only PARTIALLY closed.
// `remove_handler` additionally refuses to remove `config.admin` itself, which
// blocks the literal exploit above, but an admin holding any second key defeats
// that too.
//
// REQUIRED FOLLOW-UP before guardians become load-bearing, i.e. before Phase 1
// reopens redemptions: make removal DEFERRED instead of instant. Add
// `pending_removal_at: i64` to GuardianAccount; `remove_guardian` sets it to
// now + admin_timelock_seconds and changes nothing else, so the target KEEPS its
// pause and cancel powers during the window and can veto its own removal; a
// separate `finalize_guardian_removal` applies it after the delay, and the
// guardian or the admin may cancel it. That fixes the property by giving the
// victim time to react, instead of trying to guess whether a key is independent.
// It is deliberately not in this batch: it adds two instructions plus an account
// field and needs its own review pass. Tracked as audit action 0.12b.
//
// Operationally, until then: run 2 or 3 guardians so a lost key does not sit on
// the floor, and treat the guardian veto as a monitoring aid rather than a
// guarantee against a compromised admin.
pub const MIN_ACTIVE_GUARDIANS: u8 = 1;

// P2-05: per-field SILV metadata bounds (Token-2022 TokenMetadata extension).
// Caps follow the Metaplex name/symbol convention (32/10). The URI cap is
// chosen so the WORST-CASE borsh serialization of MetadataArgs (3x
// Option<String>) fits TimelockQueueAccount::MAX_ACTION_DATA_BYTES (256):
//   3 Option tags (1) + 3 length prefixes (4) + 32 + 10 + 180 = 237 <= 256
// (19-byte margin). 180 chars is far beyond any real Arweave/IPFS/HTTPS
// metadata-JSON URI (~60-90 chars). Empty (blank) values are rejected
// outright - a None field is the way to "leave this field unchanged".
pub const METADATA_NAME_MAX: usize = 32;
pub const METADATA_SYMBOL_MAX: usize = 10;
pub const METADATA_URI_MAX: usize = 180;

// Pyth Lazer Tier A structural hard ceilings (plan 5.5). propose + execute MUST
// reject any admin value above these. They REPLACE the Core-era ranges
// (staleness was 5..300; far too loose for a 1-of-2-signer feed). The Tier B
// OPERATING values (set from live data before unpause) sit at or below these.
pub const MAX_STALENESS_CEILING_SECONDS: u32 = 30;
pub const MAX_CONFIDENCE_BPS_CEILING: u16 = 500;
pub const MAX_PRICE_DELTA_BPS_CEILING: u16 = 1000;
// Absolute fat-finger rails on the min/max-price SETTINGS (9-dec scaled). NO
// LOOSER than the prior Core values ($5 / $200); never raise them.
pub const PRICE_FATFINGER_MIN_SCALED: u64 = 5_000_000_000; // $5
pub const PRICE_FATFINGER_MAX_SCALED: u64 = 200_000_000_000; // $200
                                                             // Allowed forward clock skew of the Lazer publisher vs the Solana clock (5.4).
pub const LAZER_FUTURE_SKEW_US: u64 = 2_000_000; // 2s
                                                 // The subscribed Lazer channel: fixed_rate@1000ms (ChannelId 4).
pub const LAZER_CHANNEL_ID: u8 = 4;
// Default operating publisher floor at init = the bare hard floor (1). This is
// DECORATIVE on its own: a 1-of-N feed passes it. It is NOT meant to operate at
// this value. The contract initializes PAUSED precisely so the operator MUST
// raise `min_publishers` to the live-data-approved Tier B value (>= 2 for a
// redeemable asset, per the GO gate in PYTH_PRO_MIGRATION_PLAN.md Section 12.2)
// via the timelocked set_oracle_guards BEFORE unpausing. Reviewer-flagged
// (2026-06-09): the floor is process-gated (paused launch + GO gate), not
// code-gated at this default. Do NOT unpause without raising it.
// Launch spec 2026-07 (FIX D): raised 1 -> 2. Combined with the hard floor
// (MIN_PUBLISHERS_FLOOR_HARD = 2 in lazer_price.rs), a single compromised or
// colluding publisher can no longer price the protocol. The SILV feed has 3
// publishers, so a floor of 2 tolerates one publisher down. Operating value stays
// 2 for now (Thomas to confirm 2 vs 3 with Mark).
pub const DEFAULT_MIN_PUBLISHERS: u16 = 2;

// Default launch values.
pub const DEFAULT_PREMIUM_MINT_BPS: u16 = 150; // 1.5% (launch spec 2026-07)
pub const DEFAULT_PREMIUM_REDEEM_BPS: u16 = 200; // 2%
                                                 // Lazer migration (5.4): operating target ~15s, hard-capped at
                                                 // MAX_STALENESS_CEILING_SECONDS (30). The "single-digit" idea was
                                                 // retracted: this is a human-approved flow (proxy fetch -> build tx
                                                 // -> wallet approval -> land) that routinely takes low-tens of
                                                 // seconds. Carried-forward is rejected separately, so staleness only
                                                 // bounds how old the FRESH print may be when it lands; the residual
                                                 // same-print replay is economically bounded for a low-vol metal.
pub const DEFAULT_MAX_STALENESS_SECONDS: u32 = 15;
pub const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 100; // 1%
pub const DEFAULT_MIN_PRICE_USD_SCALED: u64 = 5_000_000_000; // $5 * 1e9
pub const DEFAULT_MAX_PRICE_USD_SCALED: u64 = 200_000_000_000; // $200 * 1e9
pub const DEFAULT_MAX_PRICE_DELTA_BPS: u16 = 500; // 5%
pub const DEFAULT_PRICE_DELTA_DECAY_SECONDS: u32 = 3600; // 1 hour
pub const DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC: u64 = 1_000_000_000; // $1000 in USDC 6dec
pub const DEFAULT_ADMIN_TIMELOCK_SECONDS: u32 = 86400; // 24 hours

// Option B launch defaults (all admin-tunable post-deploy from the panel).
// Launch spec 2026-07: hard cap of 100,000 oz = the institutional allocation.
// Stands in for the live PoR at launch (a manually-set backing bound). The
// cap-RAISE is timelocked in this batch (FIX A) so it can't be lifted instantly.
pub const DEFAULT_MAX_SILV_SUPPLY: u64 = 100_000_000_000; // 100,000 oz at 6 decimals
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

    // Compliance (D12 PermanentDelegate = seize/clawback; launch spec 2026-07:
    // freeze authority added for the freeze lever). Both are set at mint creation.
    pub permanent_delegate_expected: Pubkey, // seize/clawback authority (Ops/compliance multisig)
    pub freeze_authority_expected: Pubkey, // freeze authority (Ops/compliance multisig), locked at init
    pub compliance_mode: bool,

    // Premium (D3/D4: ordinary USDC; launch discount = lower premium then restore)
    pub premium_bps_mint: u16,
    pub premium_bps_redeem: u16,

    // Oracle (Pyth Lazer / Pyth Pro). The Lazer program / storage / treasury are
    // compile-time CONSTANTS (lazer_cpi.rs), not stored. Section 5.7.
    pub pyth_lazer_feed_id: u32,                 // SILV = 3304
    pub min_publishers: u16,                     // operating floor (>= MIN_PUBLISHERS_FLOOR_HARD)
    pub last_used_feed_update_timestamp_us: u64, // 5.4 non-decreasing high-water mark

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

    // D2: HARD supply cap, atomic SILV (oz * 1e6). Launch spec 2026-07: TIGHTEN-ONLY
    // (lowering is instant; raising is blocked, see caps.rs set_max_silv_supply).
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
    pub admin_timelock_seconds: u32, // bounds [86400, 604800] (24h..7d, launch spec 2026-07)

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

    // === Launch spec 2026-07 additions ===

    // FIX B: admin-transfer accept delay. propose sets this to now +
    // admin_timelock_seconds; accept requires now >= it; cleared on accept + cancel.
    pub pending_admin_eta: i64,

    // Reserved (Phase 1): single-active nonce for a future timelocked max-supply
    // RAISE. At launch `set_max_silv_supply` is tighten-only (lowering is instant,
    // raising is rejected: SupplyCapRaiseBlocked), so the cap is fixed at the 100k
    // allocation and cannot be raised instantly. The raise path (timelocked, or
    // PoR-driven in Phase 2) will use this nonce.
    pub pending_max_supply_nonce: Option<u64>,

    // FIX A (full loosen-slow / tighten-fast on the redeem throttles). ACTIVE at
    // launch. Single-active nonce for the timelocked `SetRedeemLimits` action
    // (the ONLY way to LOOSEN instant_redeem_budget / instant_redeem_window /
    // large_redeem_threshold / redeem_queue_delay). Instant TIGHTENING of those
    // four goes through `emergency_tighten_redeem_limits` (no timelock).
    // max_silv_supply (raise-blocked) and redemptions_enabled (enable-blocked at
    // launch) are NOT part of this action - they keep their stricter dedicated
    // setters. See instructions/admin/caps.rs + propose.rs/execute.rs.
    pub pending_redeem_limits_nonce: Option<u64>,

    // Launch supply model (Mark's Telegram, 2026-06-30): the admin pre-mints SILV
    // against the cap into the inventory wallet; public direct mint is CLOSED at
    // launch (public_mint_enabled = false) and opens with KYC in Phase 1. Public
    // redeem is closed via redemptions_enabled = false.
    pub inventory_wallet: Pubkey,
    pub public_mint_enabled: bool,

    // --- Phase 1 KYC hooks (reserved now, unused until the KYC module ships; sized
    // in so that upgrade is pure logic with no account realloc). ---
    pub kyc_operator: Pubkey,
    pub kyc_enforced: bool,
    pub pending_kyc_operator_nonce: Option<u64>,

    // --- Phase 2 PoR hooks (reserved now; at launch, backing is the manual
    // max_silv_supply cap and por_enforced = false). ---
    pub por_feed: Pubkey,
    pub por_max_staleness_seconds: u32,
    pub por_enforced: bool,
    pub pending_por_feed_nonce: Option<u64>,

    // --- Phase 1 granular pauses (reserved now; the global `paused` is used at
    // launch until the mint/redeem pause split ships). ---
    pub mint_paused: bool,
    pub redeem_paused: bool,

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
        // --- launch spec 2026-07 additions ---
        + 8                   // pending_admin_eta
        + (1 + 8)             // pending_max_supply_nonce
        + (1 + 8)             // pending_redeem_limits_nonce (FIX A, active at launch)
        + 32 + 1              // inventory_wallet + public_mint_enabled
        + 32 + 1 + (1 + 8)    // kyc_operator + kyc_enforced + pending_kyc_operator_nonce
        + 32 + 4 + 1 + (1 + 8) // por_feed + por_max_staleness + por_enforced + pending_por_feed_nonce
        + 1 + 1               // mint_paused + redeem_paused
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
