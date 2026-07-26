use anchor_lang::prelude::*;

#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub amount_usdc: u64,
    pub amount_silv: u64,
    pub price_used_scaled: u128,
    pub premium_bps_used: u16,
    pub timestamp: i64,
}

// Launch spec 2026-07: admin pre-mint against the hard cap into the inventory
// wallet (no USDC, no oracle).
#[event]
pub struct PremintEvent {
    pub inventory: Pubkey,
    pub amount: u64,
    pub supply_post: u64,
    pub timestamp: i64,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub amount_silv: u64,
    pub amount_usdc: u64,
    pub price_used_scaled: u128,
    pub premium_bps_used: u16,
    pub timestamp: i64,
}

#[event]
pub struct OracleRejected {
    pub reason_code: u32,
    pub timestamp: i64,
}

#[event]
pub struct PriceDeltaRejected {
    pub last_price_scaled: u128,
    pub new_price_scaled: u128,
    pub bps_delta: u32,
    pub timestamp: i64,
}

#[event]
pub struct AdminActionProposed {
    pub nonce: u64,
    pub action_disc: u8,
    pub executable_at: i64,
    pub proposer: Pubkey,
}

#[event]
pub struct AdminActionExecuted {
    pub nonce: u64,
    pub action_disc: u8,
    pub executor: Pubkey,
}

#[event]
pub struct AdminActionCancelled {
    pub nonce: u64,
    pub cancelled_by: Pubkey,
}

#[event]
pub struct Paused {
    pub by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct Unpaused {
    pub timestamp: i64,
}

#[event]
pub struct TreasuryWithdraw {
    pub amount: u64,
    pub recipient: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct TreasuryDeposit {
    pub amount: u64,
    pub from: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AdminTransferProposed {
    pub current: Pubkey,
    pub proposed: Pubkey,
    pub eta: i64,
    pub expires_at: i64,
}

#[event]
pub struct AdminTransferAccepted {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct GuardianAdded {
    pub guardian: Pubkey,
}

#[event]
pub struct GuardianRemoved {
    pub guardian: Pubkey,
    pub cooldown_until: i64,
}

#[event]
pub struct ComplianceModeChanged {
    pub new_value: bool,
}

// P2-05: each field is Option<String> - `None` means that field was left
// unchanged by this update (only the Some(...) fields were rewritten).
#[event]
pub struct MetadataUpdated {
    pub new_name: Option<String>,
    pub new_symbol: Option<String>,
    pub new_uri: Option<String>,
}

// Option B queued-redemption lifecycle (CONFIRMED_SPEC.md §4.3/§4.4).
#[event]
pub struct RedeemQueued {
    pub owner: Pubkey,
    pub amount_silv: u64,
    pub nonce: u64,
    pub claimable_at: i64,
    pub timestamp: i64,
}

#[event]
pub struct RedemptionClaimed {
    pub owner: Pubkey,
    pub amount_silv: u64,
    pub amount_usdc: u64,
    pub price_used_scaled: u128,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct RedemptionSettledOffchain {
    pub owner: Pubkey,
    pub amount_silv: u64,
    pub nonce: u64,
    pub by: Pubkey,
    pub timestamp: i64,
}

// P2-03: owner closed a SettledOffchain request and reclaimed the PDA rent.
#[event]
pub struct RedemptionClosed {
    pub owner: Pubkey,
    pub amount_silv: u64,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct AccountThawed {
    pub silv_account: Pubkey,
}

#[event]
pub struct MintPausedUntilSet {
    pub until: i64,
}

/// SC-M7: dev-only handler audit trail. Emitted on dev_set_max_staleness
/// and dev_set_premiums calls so devnet operators have a log of what
/// changed and when. param: 1 = max_staleness_seconds, 2 = premiums.
/// value_a/value_b are the new values (interpretation depends on param).
#[event]
pub struct DevParamSet {
    pub admin: Pubkey,
    pub param: u8,
    pub value_a: u64,
    pub value_b: u64,
    pub timestamp: i64,
}

// AUDIT action 0.12b (DOM-007): deferred guardian removal.
#[event]
pub struct GuardianRemovalScheduled {
    pub guardian: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct GuardianRemovalCancelled {
    pub guardian: Pubkey,
    pub cancelled_by: Pubkey,
}

// ---------------------------------------------------------------------------
// SolidProof TrustNet audit (2026-07-24), LOW #3: "State-changing admin setters
// emit no events". Five privileged instructions mutated security-relevant state
// silently, so an off-chain indexer could not observe them without diffing full
// account snapshots: the supply-cap setter, the redemptions switch, the
// emergency tighten-redeem-limits fast lane, the inventory-wallet setter, and the
// admin-transfer cancellation. The last one is the worst of the five, because
// propose and accept both emit while the CANCEL of a governance handover did not.
//
// Each event carries the OLD and the NEW value plus the signer, so a monitor can
// alert on the transition itself rather than on a poll.
// ---------------------------------------------------------------------------

#[event]
pub struct MaxSupplyChanged {
    pub old_max: u64,
    pub new_max: u64,
    /// Live mint supply at the moment of the change, so the "how much headroom
    /// was just removed" question is answerable from the log alone.
    pub live_supply: u64,
    pub by: Pubkey,
}

#[event]
pub struct RedemptionsEnabledChanged {
    pub old_enabled: bool,
    pub new_enabled: bool,
    pub by: Pubkey,
}

/// The instant tighten fast lane. Every field is Option in the args, so the event
/// reports the resulting values rather than only what was supplied.
#[event]
pub struct RedeemLimitsTightened {
    pub instant_redeem_budget_usdc: u64,
    pub instant_redeem_window_seconds: u32,
    pub large_redeem_threshold_usdc: u64,
    pub redeem_queue_delay_seconds: u32,
    pub by: Pubkey,
}

/// SolidProof MEDIUM #3 asked specifically for this one: the pre-mint destination
/// can be redirected instantly, so the redirect must at least be observable.
#[event]
pub struct InventoryWalletChanged {
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct AdminTransferCancelled {
    /// The admin-elect whose handover was just cancelled. None is impossible in
    /// practice (the handler requires a pending transfer) but the field is an
    /// Option so the event cannot lie if that ever changes.
    pub cancelled_pending_admin: Option<Pubkey>,
    pub by: Pubkey,
}

/// "Mint at launch" phase. Emitted by BOTH the timelocked open and the instant close,
/// so a monitor sees every transition of the single most consequential public-facing
/// flag in the program.
#[event]
pub struct PublicMintEnabledChanged {
    pub old_enabled: bool,
    pub new_enabled: bool,
    pub by: Pubkey,
}
