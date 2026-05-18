use anchor_lang::prelude::*;

#[account]
pub struct GuardianAccount {
    pub guardian: Pubkey,
    pub added_at: i64,
    pub cooldown_until: i64, // 0 if active. Non-zero after removal: re-add requires now > cooldown_until
}

impl GuardianAccount {
    pub const SIZE: usize = 8 + 32 + 8 + 8;
}
