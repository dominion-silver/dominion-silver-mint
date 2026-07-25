use anchor_lang::prelude::*;

#[account]
pub struct GuardianAccount {
    pub guardian: Pubkey,
    pub added_at: i64,
    pub cooldown_until: i64, // 0 if active. Non-zero after removal: re-add requires now > cooldown_until
    // AUDIT action 0.12b (DOM-007 real fix): deferred removal. 0 means no removal
    // is scheduled. Non-zero is the timestamp at which `finalize_guardian_removal`
    // may be applied. Crucially the guardian stays ACTIVE while this is pending,
    // because every authorization site tests `cooldown_until == 0` and this field
    // does not touch that. So a guardian targeted by a compromised admin keeps its
    // pause and cancel powers for the whole window and can veto its own removal.
    pub pending_removal_at: i64,
}

impl GuardianAccount {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8;
}
