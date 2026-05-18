// Rent-reclaim instructions for stale per-period accounts.
// Each account stores `rent_payer` (set on creation) which receives reclaimed lamports.
// Admin-gated to prevent griefing.

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::*;

const DAILY_RETENTION_DAYS: u32 = 30;
const HOURLY_RETENTION_HOURS: u32 = 48;

// === close_daily_counter ===

#[derive(Accounts)]
#[instruction(day_epoch: u32)]
pub struct CloseDailyCounter<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [DAILY_SEED, &day_epoch.to_le_bytes()],
        bump,
    )]
    pub daily: Account<'info, DailyCountersAccount>,

    /// CHECK: rent recipient is the original payer stored on the account.
    #[account(mut, address = daily.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn close_daily_counter_handler(ctx: Context<CloseDailyCounter>, day_epoch: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let current_day = DailyCountersAccount::current_day_epoch(now);
    require!(
        day_epoch + DAILY_RETENTION_DAYS <= current_day,
        DominionError::TimelockNotElapsed
    );
    require!(
        ctx.accounts.daily.day_epoch == day_epoch,
        DominionError::DayEpochMismatch
    );
    Ok(())
}

// === close_hourly_counter ===

#[derive(Accounts)]
#[instruction(hour_epoch: u32)]
pub struct CloseHourlyCounter<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [HOURLY_SEED, &hour_epoch.to_le_bytes()],
        bump,
    )]
    pub hourly: Account<'info, HourlyCountersAccount>,

    /// CHECK: rent recipient.
    #[account(mut, address = hourly.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn close_hourly_counter_handler(
    ctx: Context<CloseHourlyCounter>,
    hour_epoch: u32,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let current_hour = HourlyCountersAccount::current_hour_epoch(now);
    require!(
        hour_epoch + HOURLY_RETENTION_HOURS <= current_hour,
        DominionError::TimelockNotElapsed
    );
    require!(
        ctx.accounts.hourly.hour_epoch == hour_epoch,
        DominionError::HourEpochMismatch
    );
    Ok(())
}

// === close_timelock_account ===
// Cleanup for cancelled/executed timelock accounts whose rent was already returned at
// cancel/execute time would not need this. Kept as a safety sweeper for any orphans.

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
    Ok(())
}
