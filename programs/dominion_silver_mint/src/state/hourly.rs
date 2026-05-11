use anchor_lang::prelude::*;

#[account]
pub struct HourlyCountersAccount {
    pub hour_epoch: u32, // UTC hour index (clock / 3600)
    pub redeemed_this_hour_usdc: u64,
    pub treasury_at_hour_start_usdc: u64, // bounded snapshot per D16
    pub rent_payer: Pubkey,
}

impl HourlyCountersAccount {
    pub const SIZE: usize = 8 + 4 + 8 + 8 + 32;

    pub fn current_hour_epoch(unix_ts: i64) -> u32 {
        (unix_ts.max(0) as u64 / 3600) as u32
    }
}
