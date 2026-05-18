use anchor_lang::prelude::*;

// D8/D9: a queued redemption. Created when a redeem is routed to the T+3 queue
// (amount >= large_redeem_threshold OR the rolling-window instant budget is
// exhausted). SILV is burned at REQUEST time (no double-spend); the USDC is
// priced at CLAIM time (D9). If the treasury cannot cover it at claim, it
// reverts to OTC and the request stays Pending as an on-chain IOU until the
// admin marks it SettledOffchain.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RedemptionStatus {
    Pending,
    Claimed,
    SettledOffchain,
}

#[account]
pub struct RedemptionRequest {
    pub owner: Pubkey,
    pub amount_silv: u64, // burned at request time
    pub requested_at: i64,
    pub claimable_at: i64, // requested_at + redeem_queue_delay_seconds
    pub nonce: u64,        // matches the PDA seed nonce
    pub status: RedemptionStatus,
    pub bump: u8,
    pub reserved: [u8; 32],
}

impl RedemptionRequest {
    pub const SIZE: usize = 8 // disc
        + 32 // owner
        + 8  // amount_silv
        + 8  // requested_at
        + 8  // claimable_at
        + 8  // nonce
        + 1  // status (enum, 1-byte tag)
        + 1  // bump
        + 32; // reserved
}
