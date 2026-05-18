use anchor_lang::prelude::*;

// Action discriminator for the queued admin action.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum TimelockAction {
    SetPremiumMint = 1,
    SetPremiumRedeem = 2,
    WithdrawUsdc = 3,
    SetTreasuryMinReserve = 4,
    SetOracleGuards = 5,
    UpdateMetadata = 6,
    SetComplianceMode = 7,
    SetPythFeed = 8,
    SetAdminTimelock = 9,
}

#[account]
pub struct TimelockQueueAccount {
    pub nonce: u64,
    pub action_disc: u8,      // TimelockAction repr
    pub action_data: Vec<u8>, // serialized args
    pub scheduled_at: i64,
    pub executable_at: i64,
    pub executed_at: Option<i64>,
    pub cancelled: bool,
    pub proposer: Pubkey,
    pub rent_payer: Pubkey,
}

impl TimelockQueueAccount {
    // Variable size; max action_data ≈ 256 bytes for any current action.
    pub const MAX_ACTION_DATA_BYTES: usize = 256;
    pub const SIZE: usize = 8
        + 8                                 // nonce
        + 1                                 // action_disc
        + 4 + Self::MAX_ACTION_DATA_BYTES   // Vec<u8>: 4-byte length + bytes
        + 8                                 // scheduled_at
        + 8                                 // executable_at
        + 1 + 8                             // Option<i64> executed_at
        + 1                                 // cancelled
        + 32                                // proposer
        + 32; // rent_payer
}
