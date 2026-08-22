use anchor_lang::prelude::*;

#[event]
pub struct MintEvent {
    pub user: Pubkey,
    /// TOTAL USDC the user authorised, i.e. gross. The treasury received
    /// `amount_usdc - fee_usdc`; the fee vault received `fee_usdc`.
    pub amount_usdc: u64,
    pub amount_silv: u64,
    /// The oracle price, now PURE SPOT. Before 2026-08-05 the premium was folded into a
    /// marked-up price and this field carried the raw oracle read anyway, so its meaning is
    /// unchanged; what changed is that `amount_silv` is computed directly from it.
    pub price_used_scaled: u128,
    /// The premium ACTUALLY applied. 0 when the caller holds a mint-side fee exemption, so
    /// this is the field to read when auditing whitelist usage rather than
    /// `config.premium_bps_mint`.
    pub premium_bps_used: u16,
    /// Premium routed to the fee vault (2026-08-05).
    /// CORRECTION. An earlier version of this comment said "appended, so older decoders that
    /// stop after `timestamp` still parse the prefix". THAT WAS FALSE and it is worth spelling
    /// out, because the comment actively authorised a mistake:
    /// This field is at index 4 of 6, BEFORE `timestamp`, not appended. Borsh is positional, so
    /// a decoder built against the pre-upgrade IDL reads these 8 bytes AS `timestamp`. A $100
    /// mint would decode as `timestamp = 1000000`, i.e. January 1970. It does not error, it
    /// silently produces a plausible wrong number, which is the worst failure shape available.
    /// There is no in-repo decoder, so nothing is broken today. But ANY off-chain indexer,
    /// dashboard or analytics job must be rebuilt against the new IDL before it reads
    /// MintEvent or RedeemEvent again. Do not assume a prefix-compatible read.
    /// Left in place rather than moved to the end: moving it would change the IDL again for no
    /// benefit now that the hazard is documented, and every reader has to be rebuilt either way.
    pub fee_usdc: u64,
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
    /// SOLIDPROOF T-006. The signer that minted. `inventory` is the DESTINATION, bound at
    /// `initialize` and changeable only through the 24h timelocked pair, so without this field the
    /// event records where supply went but not who sent it.
    /// LAST, after `timestamp`, and that placement is the whole point. The first version of this
    /// change put `by` between `supply_post` and `timestamp` while its comment claimed an append
    /// kept the offsets stable. That was false in exactly the way `MintEvent::fee_usdc` above
    /// documents: a positional decoder would have read the first 8 bytes of this pubkey as the
    /// timestamp and produced a plausible wrong number rather than an error. Appending for real
    /// costs nothing here, because the field has never shipped.
    pub by: Pubkey,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub amount_silv: u64,
    /// USDC the user RECEIVED, i.e. net.
    /// The treasury's TOTAL outflow is `amount_usdc + fee_usdc` **only while fee routing is on**.
    /// this said the treasury always paid `amount_usdc + fee_usdc`, "because the premium
    /// leg also comes from the treasury". That is false whenever `config.fee_routing_disabled` is
    /// true: the premium is then RETAINED, so `redeem_silv.rs` debits the budget by the user's leg
    /// alone and the treasury pays exactly `amount_usdc`. An alerting rule built on the old sentence
    /// would over-count outflow by the premium during precisely the incident that turns routing off.
    /// To reconstruct the real outflow from this event alone you cannot: you need the config flag as
    /// of that slot. `FeeRoutingChanged` is the event that tells you when it moved.
    pub amount_usdc: u64,
    pub price_used_scaled: u128,
    /// The premium ACTUALLY applied. 0 when the caller holds a redeem-side exemption.
    pub premium_bps_used: u16,
    /// Premium routed to the fee vault (2026-08-05). NOT appended: it sits before `timestamp`,
    /// so a decoder on the pre-upgrade IDL reads it AS the timestamp. See the long note on
    /// `MintEvent::fee_usdc`. Rebuild every off-chain reader against the new IDL.
    pub fee_usdc: u64,
    pub timestamp: i64,
}

// --- Premium routing, fee-exemption whitelist and dormant KYC (2026-08-05) ---

/// Emitted on both grant and update. `flags` is a `Side` bitfield (state/side.rs).
#[event]
pub struct FeeExemptSet {
    pub wallet: Pubkey,
    pub flags: u8,
    /// Always a future timestamp: made the term mandatory, so zero cannot occur. Emitted so a
    /// monitor can alert on an unusually long term, which is the shape a compromised admin would use.
    pub expires_at: i64,
    pub by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeeExemptRemoved {
    pub wallet: Pubkey,
    /// The flags in force at revocation, so a log reader can see what was withdrawn
    /// without correlating against the earlier grant.
    pub previous_flags: u8,
    pub by: Pubkey,
    pub timestamp: i64,
}

/// Premium routing turned on or off. The highest-signal fee event: with routing OFF the premium
/// stays in the treasury, so revenue analytics that read `fee_usdc` will correctly see zeros, and
/// anyone reconciling the fee vault needs to know when the switch moved.
#[event]
pub struct FeeRoutingChanged {
    pub enabled: bool,
    pub by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeesWithdrawn {
    pub destination: Pubkey,
    pub amount: u64,
    /// Vault balance AFTER the sweep. Makes "was this the whole balance or a partial
    /// sweep?" answerable from the event alone.
    pub remaining: u64,
    pub by: Pubkey,
    pub timestamp: i64,
}

/// The KYC gate being armed or disarmed. This is the highest-signal admin event in the
/// program for a holder: arming it can lock people out of redeeming.
#[event]
pub struct KycScopeChanged {
    pub old_flags: u8,
    pub new_flags: u8,
    pub by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct KycAttested {
    pub wallet: Pubkey,
    pub attestor: Pubkey,
    /// Hash of the provider's record id. NEVER PII: see state/kyc.rs.
    pub reference: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct KycRevoked {
    pub wallet: Pubkey,
    pub by: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct KycOperatorChanged {
    pub old_operator: Pubkey,
    pub new_operator: Pubkey,
    pub by: Pubkey,
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

// each field is Option<String> - `None` means that field was left
// unchanged by this update (only the Some(...) fields were rewritten).
#[event]
pub struct MetadataUpdated {
    pub new_name: Option<String>,
    pub new_symbol: Option<String>,
    pub new_uri: Option<String>,
}

// `RedeemQueued` was declared here and emitted NOWHERE. The queued redemption lifecycle
// was deleted on 2026-08-05; the event definition outlived it and stayed in the IDL, where it reads as
// a documented part of the protocol. An integrator building an indexer would have subscribed to a
// stream that can never produce a message, and concluded their integration was broken.
// Removing an event is safe in a way that removing a field is not: events carry no account layout and
// no instruction encoding, so nothing on chain shifts. Verified that no client or script referenced it.

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

// owner closed a SettledOffchain request and reclaimed the PDA rent.
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

// action 0.12b (): deferred guardian removal.
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
// (2026-07-24), LOW #3: "State-changing admin setters
// emit no events". Five privileged instructions mutated security-relevant state
// silently, so an off-chain indexer could not observe them without diffing full
// account snapshots: the supply-cap setter, the redemptions switch, the
// emergency tighten-redeem-limits fast lane, the inventory-wallet setter, and the
// admin-transfer cancellation. The last one is the worst of the five, because
// propose and accept both emit while the CANCEL of a governance handover did not.
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

/// asked for this back when the destination could be changed with no delay.
/// it cannot any more. The only writer after `initialize` is
/// `execute_set_inventory_wallet`, after 24h and cancellable by a guardian. The event stays because
/// a timelocked redirect still has to be observable when it lands.
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

/// The mint floor is the availability control on the strict-anti-replay slot, so a
/// monitor needs the transition: raising it prices small users out, lowering it re-cheapens print
/// capture. Same old/new/by shape as the other instant setters, for the same LOW #3 reason.
#[event]
pub struct MinOperationChanged {
    pub old_min_usdc: u64,
    pub new_min_usdc: u64,
    pub by: Pubkey,
}
