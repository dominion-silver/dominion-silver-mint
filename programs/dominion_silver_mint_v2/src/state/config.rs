use anchor_lang::prelude::*;

// Hard bounds (compile-time policy ceilings). The "parametrable within safe
// bounds" discipline: every business value is admin-settable but clamped here
// so a compromised or fat-finger admin cannot set a catastrophic value.
// CODEX P1-01: per-side premium ceilings aligned to CONFIRMED_SPEC.md §6
// (premium_bps_mint 0..2000, premium_bps_redeem 0..1000). Was a single
// 3000-bps ceiling for both, which diverged from the locked spec.
// Both raised to 5% (Thomas, 2026-08-05). The mint ceiling was 3%.
//
// What these ceilings ARE: a promise written into the bytecode that bounds what a
// compromised or coerced admin can charge users. Changing one costs a program upgrade,
// which is slow and publicly visible, so the number is a genuine commitment rather than
// a setting.
//
// What raising the mint ceiling COSTS, stated plainly because it is a reduction in user
// protection and an auditor will ask: the worst case a compromised admin can impose on a
// minter goes from 3% to 5%. It buys no operational capability that will realistically be
// used, since minting at spot +5% is worse than any DEX price, so nobody would mint there.
//
// Why it is nonetheless acceptable: the meaningful control on a premium change is not the
// ceiling, it is that BOTH premium setters are 24h-timelocked and guardian-cancellable
// (propose_set_premium_mint / execute_set_premium_mint). A move toward the ceiling is
// announced a day in advance and can be vetoed. The ceiling only bounds where that
// announced move can land. Symmetry between the two sides is also easier to reason about
// and to explain than 3%/5%.
//
// Launch values are 1% mint / 1.5% redeem (Mark, 2026-07-30), i.e. both sit at a fifth
// and a third of their ceiling respectively. There is deliberate headroom.
pub const PREMIUM_BPS_MINT_CEILING: u16 = 500; // 5% (Thomas 2026-08-05; launch value 1%)
pub const PREMIUM_BPS_REDEEM_CEILING: u16 = 500; // 5% (launch value 1.5%)
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
// Decision (Thomas, 2026-07-25): the hybrid model. The floor is one half of the
// mechanism; the other half is DEFERRED REMOVAL (see instructions/admin/guardian.rs).
//
// History, kept because it is instructive. The first attempt was this floor ALONE.
// The triple-review demonstrated that a floor cannot work by itself: since
// `add_guardian` is also admin-controlled, a compromised admin can add a puppet and
// walk the set down while never breaching the count, so the "surviving guardian"
// can be its own key. No on-chain check can tell whether a key is independent.
//
// The working mechanism therefore does not try to. `remove_guardian` now only
// SCHEDULES a removal at now + admin_timelock_seconds, and the target keeps
// `cooldown_until == 0` (which is what every authorization site tests) for the whole
// window, so it retains pause and cancel powers and can cancel its own removal.
// `finalize_guardian_removal` applies it afterwards and re-checks this floor against
// the live count, which is what stops an admin scheduling every removal at once and
// then finalizing down to zero.
//
// What this constant contributes: the set can never reach zero, so there is always
// somebody able to cancel. What deferral contributes: that somebody cannot be
// silently replaced first.
//
// CORRECTED after the review of daac4ac. An earlier version of this comment implied
// the floor guarantees a surviving INDEPENDENT guardian. It does not, and the
// overclaim is worth stating plainly because an auditor will rely on it:
//
//   1. The floor counts REGISTRATIONS, and `add_guardian` accepts any 32 bytes. An
//      admin can lift the count with a key it holds, or with an unsignable junk
//      pubkey, purely to satisfy this check. Refusing `config.admin` in
//      `add_guardian` blocks only the literal self-appointment.
//   2. Therefore the floor bounds the COUNT, never the independence of the set. The
//      only real protection is the deferral: every removal costs a full
//      `admin_timelock_seconds` of public, cancellable notice.
//   3. What the floor now does contribute, since the review: it is evaluated against
//      guardians NOT already under notice (see `may_schedule_removal`), so an admin
//      can no longer schedule the entire set inside one window and pay a single
//      delay for the whole purge.
//
// Residual, accepted and NOT fixed here: guardian appointment is admin-unilateral,
// so a determined compromised admin can still walk the set down over successive
// windows. Making the guardian set independent of the admin is a governance change
// (Phase 1), not something an on-chain count check can express. Run 2 or 3
// guardians, hold them on separate keys, and monitor GuardianRemovalScheduled.
pub const MIN_ACTIVE_GUARDIANS: u8 = 1;

// AUDIT review of daac4ac (P1): a scheduled guardian removal used to stay armed
// forever once its ETA passed, so an old schedule became a stored instant-removal
// coupon (pre-arm quietly, evict later with no reaction window). A removal must be
// applied inside this window after its ETA or it dies, exactly as a pending admin
// transfer dies after PENDING_ADMIN_EXPIRY_SECONDS. Same value, same reasoning.
pub const GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS: i64 = 7 * 86400; // 7 days

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
// Launch fees confirmed by Mark 2026-07-30: 1% mint, 1.5% redeem.
//
// These are DEFAULTS, not the source of truth: `premium_bps_mint` and
// `premium_bps_redeem` are both `InitializeArgs` fields, so the value that actually ships
// is whatever the deploy ceremony passes (see config/mainnet-authorities.json). They are
// kept in sync here anyway, because several scripts and the unit tests read them, and a
// stale default is how a devnet run ends up silently priced differently from mainnet.
//
// Both are 24h-timelock changeable after launch, so nothing here is locked in.
//
// Read fee_from_amount in math.rs for what "1%" means mechanically: 1% of the amount
// flowing through, taken off the top, on BOTH sides. It is no longer folded into a
// marked-up or marked-down price.
pub const DEFAULT_PREMIUM_MINT_BPS: u16 = 100; // 1% (Mark, 2026-07-30)
pub const DEFAULT_PREMIUM_REDEEM_BPS: u16 = 150; // 1.5% (Mark, 2026-07-30)
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
// Hard cap = the institutional allocation. Stands in for the live PoR at launch (a
// manually-set backing bound), because `por_enforced` is reserved and unwired, so this
// cap is the ONLY on-chain bound on unbacked SILV: admin_premint checks exactly
// `supply_post <= config.max_silv_supply` and nothing else.
//
// 150,000 oz confirmed by Thomas 2026-07-29 (was 100,000). It is NOT an initialize
// argument, so changing it means editing this constant and rebuilding, which is why it
// has to be right BEFORE the mainnet build.
//
// TIGHTEN-ONLY, and it is a ONE-WAY RATCHET: `set_max_silv_supply` compares against the
// CURRENT value, so lowering it makes the lower number the new permanent ceiling. Going
// 150k -> 100k is instant from the panel; going back to 150k afterwards is refused
// (SupplyCapRaiseBlocked) and costs a program upgrade plus a re-audit. Do not lower this
// casually.
//
// Launch plan against this cap (Thomas 2026-07-29): pre-mint $6.75M worth of SILV,
// which is ~115,665 oz at $58.36 spot, i.e. ~77% of the cap. The remainder is the
// headroom PUBLIC MINTS draw from, since mint_silv checks the same cap. Compute the
// exact ounce figure at ceremony time with scripts/premint-sizing.ts: the budget is in
// dollars but the cap is in ounces, so a fall in the silver price increases the ounces
// required for the same budget.
pub const DEFAULT_MAX_SILV_SUPPLY: u64 = 150_000_000_000; // 150,000 oz at 6 decimals
                                                          // The launch posture for the public mint path. FALSE at launch: users buy pre-minted
                                                          // SILV on the DEX, and opening the direct mint is a deliberate 24h-timelocked,
                                                          // guardian-cancellable act (propose_set_public_mint). Pinned as a named constant so the
                                                          // default lives in one place and a unit test can guard it: an accidental `true` here
                                                          // would ship an open mint with a live oracle path on day one.
pub const DEFAULT_PUBLIC_MINT_ENABLED: bool = false;
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

// Premium revenue destination (Thomas, 2026-08-05). Authority PDA of the fee vault.
//
// The vault itself is the ASSOCIATED TOKEN ACCOUNT of this PDA for `config.usdc_mint`,
// and it is deliberately NOT stored in ConfigAccount, unlike `usdc_treasury`. Two
// reasons: it is fully derivable, so a stored pointer could only ever be wrong or stale;
// and `reserved` is down to its last few dozen bytes, which Phase 2 still needs.
//
// The property that makes this shape safe, and the reason it was chosen over transferring
// premiums straight to an admin-configured wallet: a PDA-owned ATA cannot be closed.
// Closing a token account requires the owner's signature, and this program never signs a
// CloseAccount for this PDA. A plain destination wallet could have its USDC ATA missing
// or closed, and since the fee transfer happens inside mint and redeem, that would make
// EVERY mint and EVERY redeem revert. One wrong address in the admin panel would brick
// the product. Here that is structurally impossible.
//
// The configurable destination Thomas asked for is the `withdraw_fees` argument instead,
// chosen per sweep. A wrong address there costs one misdirected sweep, not the product.
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";

// Per-wallet fee exemption (Mark, 2026-07-30: "whitelist specific wallets to bypass the
// fee"). One PDA per wallet, seeded by the wallet, so the account cannot be presented on
// behalf of somebody else. See state/fee_exempt.rs.
pub const FEE_EXEMPT_SEED: &[u8] = b"fee_exempt";

// Per-wallet KYC attestation, dormant at launch. One PDA per wallet, same shape as the
// fee exemption. See state/kyc.rs.
pub const KYC_SEED: &[u8] = b"kyc";

// DEPRECATED (2026-08-05): the queued redemption path was deleted along with
// `RedemptionRequest`. Kept declared because removing a `pub const` is a source-breaking
// change for the scripts, and because leaving the seed visible documents that the seed
// namespace `redeem_request` was once in use and must not be reused for anything else.
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
    // SolidProof TrustNet audit (2026-07-24), INFORMATIONAL #2: "Compliance mode flag
    // is never read as a gate". Correct, and the name is misleading, so it is
    // documented here rather than wired up.
    //
    // What this flag DOES: nothing on its own. No instruction reads it to permit or
    // deny anything. Its only on-chain effect is that flipping it (via the
    // 24h-timelocked SetComplianceMode action) AUTO-PAUSES the protocol.
    //
    // What it is FOR: it is an operator signal, not an enforcement mechanism. The
    // real compliance enforcement is the freeze authority and the Token-2022
    // permanent delegate, both held by an EXTERNAL multisig and exercised with direct
    // SPL Token-2022 transactions that never touch this program.
    //
    // Why it is not wired: an integrator could reasonably but wrongly assume this
    // flag gates transfers or redemptions on-chain. It does not, and it must not be
    // presented as if it did. Left inert and documented, per the auditor's first
    // suggested resolution.
    pub compliance_mode: bool,

    // Premium (D3/D4: ordinary USDC; launch discount = lower premium then restore)
    pub premium_bps_mint: u16,
    pub premium_bps_redeem: u16,

    // Oracle (Pyth Lazer / Pyth Pro). The Lazer program / storage / treasury are
    // compile-time CONSTANTS (lazer_cpi.rs), not stored. Section 5.7.
    // SILV oracle: Metal.Index.SILVER/USD, Lazer feed 3154. CONFIRMED by Thomas
    // 2026-07-26. PURE SPOT, no premium embedded in the feed. The retired 3304
    // (Crypto.Index.SILV/USD, "DOMINION SILVER / US DOLLAR") was measured to be
    // exactly 3154 x 1.05, i.e. it carried a hidden 5% premium. All of the protocol's
    // margin now lives in premium_bps_mint / premium_bps_redeem, where it is visible
    // on-chain instead of hidden inside a bespoke feed.
    pub pyth_lazer_feed_id: u32,
    pub min_publishers: u16, // operating floor (>= MIN_PUBLISHERS_FLOOR_HARD)
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

    // D10: Sybil-proof global rolling-window redeem budget. STILL LIVE.
    //
    // 2026-08-05: redemption became a SINGLE INSTANT ROUTE (Thomas: "on va rester tres
    // simple"). Two of the six fields below are now DEAD, but every one of them stays
    // DECLARED. Deleting a field shifts the byte offset of every field after it and would
    // force a realloc of every deployed config, which is the same trap the
    // `pending_removal_count` comment below documents. Dead does not mean removable.
    //
    // DEAD, never read: `large_redeem_threshold_usdc` was the per-size tier that forced
    // large redemptions into the queue. Removed deliberately: it discriminated on amount,
    // which is exactly what the simple design rejects, and it was also a structuring
    // incentive (split one $10k redeem into three $4k ones).
    //
    // DEAD, never read: `redeem_queue_delay_seconds` gated the queue, and there is no
    // queue.
    //
    // STILL LIVE and load-bearing: `instant_redeem_budget_usdc`,
    // `instant_redeem_window_seconds`, `instant_window_start`, `instant_used_usdc`. This
    // is ONE global ceiling per rolling window, applied identically to every caller
    // whatever their size, so it is not amount discrimination. It is the only brake
    // between a bad oracle print and the entire treasury leaving in a single transaction:
    // the oracle guards (staleness, publisher floor, price-delta breaker) are filters, not
    // limiters, and `pause` requires a human to notice inside one block. Exceeding the
    // budget now REVERTS (RedeemLimitExceeded) where it used to route to the queue.
    //
    // Kept GLOBAL rather than per-wallet so it is Sybil-proof: splitting across a hundred
    // fresh wallets cannot exceed one shared counter.
    pub large_redeem_threshold_usdc: u64, // DEAD since 2026-08-05, do not read
    pub instant_redeem_budget_usdc: u64,  // LIVE: max redeemed per window, all users
    pub instant_redeem_window_seconds: u32, // LIVE
    pub redeem_queue_delay_seconds: u32,  // DEAD since 2026-08-05, do not read
    pub instant_window_start: i64,        // LIVE: current window start (rolling)
    pub instant_used_usdc: u64,           // LIVE: cumulative redeemed in current window

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

    // Guardians currently scheduled for removal but not yet finalized. The removal
    // floor is evaluated against `guardian_count - pending_removal_count`.
    //
    // ###################################################################
    // CORRECTION, and a rule for whoever carves the NEXT byte out of `reserved`.
    //
    // The comment that shipped here claimed that carving this field out of
    // `reserved` left "the byte offsets of every existing field unchanged". THAT WAS
    // FALSE, and the review-of-fixes caught it with a byte-level simulation. Borsh is
    // a sequential format: this field was inserted BEFORE `version`, so it shifted
    // `version` and `reserved` by one byte. Only `SIZE` was unchanged (still 800).
    //
    // Why that matters, concretely. If this layout were ever applied by an IN-PLACE
    // upgrade over a config written by the previous layout, the new
    // `pending_removal_count` would decode the OLD `version` byte, which is always 2
    // for every v2 config. The floor check then demands
    // `guardian_count - 2 > MIN_ACTIVE_GUARDIANS`, i.e. at least 4 guardians, while
    // MAX_GUARDIAN_COUNT_DEFAULT is 3 and no instruction can raise it. Neither
    // decrement path can run either, because both require a guardian with a pending
    // notice and none has one. Guardian removal would be PERMANENTLY bricked, exit
    // via another program upgrade: precisely the failure this field exists to prevent.
    //
    // Not live: this layout only ever met a FRESH `initialize` (program 6bgSnX), so
    // the field genuinely started at 0. The danger was never the deployed state, it
    // was this comment becoming the in-tree pattern for using `reserved` while the
    // KYC and PoR hooks below exist specifically so Phase 1 and Phase 2 are "pure
    // logic with no account realloc".
    //
    // THE RULE: a new field carved out of `reserved` must be declared AFTER
    // `version`, immediately before `reserved`, and `reserved` shrunk by the same
    // number of bytes. Only then are all preceding offsets genuinely untouched, and
    // only `reserved` (opaque zeros) shifts. Never insert before `version` again.
    //
    // Also worth knowing before reasoning about offsets in this struct at all: they
    // are not fixed by the declaration alone. There are 14 `Option` fields, so the
    // absolute byte offset of `version` depends on how many are `Some`. Field ORDER
    // is the only stable thing. Do not reason in absolute offsets.
    // ###################################################################
    pub pending_removal_count: u8,

    // Schema
    pub version: u8,

    // Public-mint gate, phase "mint at launch" (Thomas, 2026-07-26). Single-active
    // guard for the timelocked ENABLE path, mirroring every other pending_*_nonce.
    //
    // Declared AFTER `version` and immediately before `reserved`, which is the rule
    // the pending_removal_count comment above establishes the hard way: carving a byte
    // out BEFORE `version` shifts `version` and `reserved`, and doing that on an
    // in-place upgrade would decode garbage into the new field. Placed here, only
    // `reserved` (opaque zeros) moves, so an in-place upgrade over an existing config
    // reads None, which is the correct value for "no proposal pending".
    pub pending_public_mint_nonce: Option<u64>,

    // KYC scope, dormant at launch (Thomas, 2026-08-05). Bit 0 = required on mint,
    // bit 1 = required on redeem. 0 = KYC off everywhere, which is the launch posture and
    // also what an in-place upgrade over an existing config decodes, since `reserved` is
    // zeros. Safe in both directions: the fail-closed default here is "no gate", and that
    // is correct because the gate does not exist yet off-chain.
    //
    // Declared AFTER `version`, immediately before `reserved`, per THE RULE above.
    //
    // Why two bits rather than one bool: Mark's likely first step is KYC on REDEEM only,
    // since redeem is the leg that pays out treasury cash, while public mint stays open to
    // preserve DEX arbitrage. A single switch would force both at once.
    //
    // Relationship to `kyc_enforced`, which already existed as a Phase 1 hook: that field
    // is kept as the human-readable master signal and is DERIVED, never set independently.
    // The setter maintains `kyc_enforced == (kyc_scope_flags != 0)` as an invariant, so a
    // panel or an external reader can trust either one and they can never disagree.
    pub kyc_scope_flags: u8,
    pub reserved: [u8; 53],
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
        + 1                   // pending_removal_count (carved out of reserved)
        + 1                   // version
        + (1 + 8)             // pending_public_mint_nonce (carved out of reserved)
        + 1                   // kyc_scope_flags (carved out of reserved)
        + 53; // reserved

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
// The in-place-upgrade model for the KYC/PoR/pause hooks depends on this account
// never changing size, and until the review-of-fixes nothing asserted it: the only
// bounds were >= 256 and <= 4096, which a 200-byte drift would pass. GuardianAccount
// got an exact size test in the same batch; this one, which matters more, did not.
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
