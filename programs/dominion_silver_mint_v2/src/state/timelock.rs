use anchor_lang::prelude::*;

// Action discriminator for the queued admin action.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum TimelockAction {
    SetPremiumMint = 1,
    SetPremiumRedeem = 2,
    WithdrawUsdc = 3,
    // Discriminant 4 was reused with a changed payload, which is safe ONLY because V2
    // is a mandatory fresh deploy under a new program id, so no pre-existing
    // TimelockQueueAccount exists. That requirement is the real safety boundary and it
    // is NOT enforced on chain: no V1 config can deserialize into V2 to be checked.
    SetTreasuryFloat = 4,
    SetOracleGuards = 5,
    UpdateMetadata = 6,
    SetComplianceMode = 7,
    SetPythFeed = 8,
    SetAdminTimelock = 9,
    // The timelocked LOOSEN path for the four redeem throttles; instant tightening is
    // the separate `emergency_tighten_redeem_limits`. Discriminants are APPEND ONLY.
    SetRedeemLimits = 10,
    // Opening the public mint is a LOOSENING: 24h timelock, guardian-cancellable.
    // Closing is instant. Opening also wakes the oracle path, dormant while the mint is
    // closed, so the announced window is when a bad oracle guard should surface.
    SetPublicMint = 11,
    // Changing the pre-mint DESTINATION is a redirect: the admin picks where supply lands,
    // and `admin_premint` can then mint the remaining cap headroom into it in the same block. An
    // instant setter is untenable while a premint capability exists. Discriminants are
    // APPEND ONLY.
    SetInventoryWallet = 12,
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
    // Variable size. No current action serializes more than 256 bytes of args.
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
