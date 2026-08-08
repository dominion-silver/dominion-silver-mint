// Rent-reclaim instructions for stale accounts.
// Option B: close_daily_counter / close_hourly_counter removed (the daily/
// hourly counter accounts no longer exist - Option A teardown). Only the
// timelock-account safety sweeper remains.

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::TimelockAccountClosed;
use crate::state::*;

// === close_timelock_account ===
// Safety sweeper for cancelled/executed timelock accounts that, for any
// reason, did not get closed at cancel/execute time. Admin-gated.

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CloseTimelockAccount<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()],
        bump,
        constraint = timelock.cancelled || timelock.executed_at.is_some()
            @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn close_timelock_account_handler(
    ctx: Context<CloseTimelockAccount>,
    nonce: u64,
) -> Result<()> {
    require!(
        ctx.accounts.timelock.nonce == nonce,
        DominionError::NonceMismatch
    );

    // SOLIDPROOF T-006. Read BEFORE the account is closed. Anchor's `close = rent_recipient` runs
    // after the handler returns, so these fields are still valid here and unreachable afterwards.
    let tl = &ctx.accounts.timelock;
    emit!(TimelockAccountClosed {
        nonce,
        action_disc: tl.action_disc,
        was_cancelled: tl.cancelled,
        rent_recipient: ctx.accounts.rent_recipient.key(),
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}
