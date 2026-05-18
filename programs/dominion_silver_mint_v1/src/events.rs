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

#[event]
pub struct MetadataUpdated {
    pub new_name: String,
    pub new_symbol: String,
    pub new_uri: String,
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
