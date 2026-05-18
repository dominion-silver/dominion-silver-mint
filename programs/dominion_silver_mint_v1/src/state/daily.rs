use anchor_lang::prelude::*;

#[account]
pub struct DailyCountersAccount {
    pub day_epoch: u32, // UTC day index (clock / 86400)
    pub minted_today_usdc: u64,
    pub redeemed_today_usdc: u64,
    pub rent_payer: Pubkey, // who funded the account, gets rent on close
}

impl DailyCountersAccount {
    pub const SIZE: usize = 8 + 4 + 8 + 8 + 32;

    pub fn current_day_epoch(unix_ts: i64) -> u32 {
        (unix_ts.max(0) as u64 / 86400) as u32
    }
}
