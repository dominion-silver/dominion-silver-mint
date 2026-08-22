use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{
    GuardianAdded, GuardianRemovalCancelled, GuardianRemovalScheduled, GuardianRemoved,
};
use crate::state::*;

#[derive(Accounts)]
#[instruction(guardian_pubkey: Pubkey)]
pub struct AddGuardian<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    // THE APPOINTEE'S CO-SIGNATURE WAS REMOVED, and this note is the record of why.
    // It was added so the guardian set could not grow without the consent of the key being added.
    // The property is real but small: nothing stops a compromised Ops from generating the key AND
    // signing for it, so it never proved independence, only participation. Its COST turned out to be
    // large: `config.admin` is the Ops Squads vault, so `add_guardian` became a two-signer
    // transaction, and the Squads execution path has no moment at which an external key can sign.
    // The instruction was correct on chain and unexecutable through the documented ceremony.
    // Owner decision, 2026-08-09: remove it rather than build a co-signing flow for something that
    // runs two to four times in the protocol's life and buys participation rather than independence.
    // What still holds, and is where the real protection lives: the FIRST guardian is an argument of
    // `initialize`, so the launch brake is fixed in the -authenticated transaction and lands
    // in the reviewed ceremony artifact instead of a later invisible call. `add_guardian` still
    // refuses the current admin and the incoming admin, `unpause` still demands an ACTIVE guardian
    // distinct from the admin, and removal is still deferred by the full timelock so a guardian
    // cannot be dropped the moment it becomes inconvenient.
    #[account(
        init_if_needed,
        payer = payer,
        space = GuardianAccount::SIZE,
        seeds = [GUARDIAN_SEED, guardian_pubkey.as_ref()],
        bump,
    )]
    pub guardian_account: Account<'info, GuardianAccount>,

    pub system_program: Program<'info, System>,
}

pub fn add_handler(ctx: Context<AddGuardian>, guardian_pubkey: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let guardian = &mut ctx.accounts.guardian_account;
    let now = Clock::get()?.unix_timestamp;

    // The admin may not appoint ITSELF, or one signature could walk the set down to a
    // single admin-controlled "guardian" without ever breaching MIN_ACTIVE_GUARDIANS.
    // A barrier, not a fix: any second key defeats it. The fix is the deferred removal.
    require!(guardian_pubkey != config.admin, DominionError::Unauthorized);
    // Refuse the INCOMING admin too, or the barrier is sidestepped by appointing K then
    // completing a pending transfer to K. `may_act` backstops a later transfer.
    if let Some(pending) = config.pending_admin {
        require!(guardian_pubkey != pending, DominionError::Unauthorized);
    }

    // cooldown_until is set by finalize_removal, so a re-add waits it out.
    if guardian.cooldown_until != 0 {
        require!(
            now >= guardian.cooldown_until,
            DominionError::GuardianInCooldown
        );
    }

    // Reject an already-active guardian. added_at == 0 means first-time creation.
    if guardian.added_at != 0 && guardian.cooldown_until == 0 {
        return Err(error!(DominionError::ProposalAlreadyActive));
    }

    require!(
        config.guardian_count < config.max_guardian_count,
        DominionError::GuardianCountExceeded
    );

    // INVARIANT: every write to pending_removal_at is paired with an update of
    // config.pending_removal_count. Clearing it here would not be, so assert instead.
    require!(
        guardian.pending_removal_at == 0,
        DominionError::GuardianRemovalAlreadyScheduled
    );

    guardian.guardian = guardian_pubkey;
    guardian.added_at = now;
    guardian.cooldown_until = 0;
    // A re-appointment is a fresh mandate, so the budget resets. This is the only site
    // that clears the flag, and it is admin-only behind the cooldown.
    guardian.self_cancel_used = false;
    guardian.version = GUARDIAN_ACCOUNT_VERSION;

    config.guardian_count = config.guardian_count.saturating_add(1);

    emit!(GuardianAdded {
        guardian: guardian_pubkey
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(guardian_pubkey: Pubkey)]
pub struct RemoveGuardian<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GUARDIAN_SEED, guardian_pubkey.as_ref()],
        bump,
        constraint = guardian_account.guardian == guardian_pubkey @ DominionError::Unauthorized,
        constraint = guardian_account.cooldown_until == 0 @ DominionError::GuardianInCooldown,
    )]
    pub guardian_account: Account<'info, GuardianAccount>,
}

pub fn remove_handler(ctx: Context<RemoveGuardian>, guardian_pubkey: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Removal is SCHEDULED, not applied. Instant removal made the veto circular, and no
    // numeric floor fixes that because no on-chain check can tell whether a key is
    // independent. Deferring gives the VICTIM time: the guardian keeps
    // `cooldown_until == 0` for the whole window, so it retains every power.
    let existing = ctx.accounts.guardian_account.pending_removal_at;
    // An EXPIRED schedule unarms itself and may be replaced by a fresh full window, or
    // a dead schedule would block removal forever and leave the counter inflated.
    require!(
        existing == 0 || removal_schedule_expired(existing, now),
        DominionError::GuardianRemovalAlreadyScheduled
    );

    let effective_at = now
        .checked_add(ctx.accounts.config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    if existing == 0 {
        // A genuinely NEW notice, so the floor applies. Re-arming an expired notice
        // does not change the count and deliberately skips both check and increment.
        let config = &mut ctx.accounts.config;
        require!(
            may_schedule_removal(config.guardian_count, config.pending_removal_count),
            DominionError::GuardianFloorBreached
        );
        config.pending_removal_count = config
            .pending_removal_count
            .checked_add(1)
            .ok_or(error!(DominionError::ArithmeticOverflow))?;
    }

    ctx.accounts.guardian_account.pending_removal_at = effective_at;

    emit!(GuardianRemovalScheduled {
        guardian: guardian_pubkey,
        effective_at,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(guardian_pubkey: Pubkey)]
pub struct FinalizeGuardianRemoval<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ConfigAccount>,

    #[account(
        mut,
        seeds = [GUARDIAN_SEED, guardian_pubkey.as_ref()],
        bump,
        constraint = guardian_account.guardian == guardian_pubkey @ DominionError::Unauthorized,
        constraint = guardian_account.cooldown_until == 0 @ DominionError::GuardianInCooldown,
    )]
    pub guardian_account: Account<'info, GuardianAccount>,
}

/// Apply a removal scheduled by `remove_guardian`, once its window has elapsed.
/// PERMISSIONLESS on purpose: the decision is already public and already delayed, so
/// a stalling admin cannot leave a removal hanging over a guardian indefinitely.
pub fn finalize_removal_handler(
    ctx: Context<FinalizeGuardianRemoval>,
    guardian_pubkey: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let scheduled = ctx.accounts.guardian_account.pending_removal_at;

    require!(scheduled != 0, DominionError::GuardianRemovalNotScheduled);
    require!(now >= scheduled, DominionError::TimelockNotElapsed);
    // See the note on removal_schedule_expired in state/guardian.rs.
    require!(
        !removal_schedule_expired(scheduled, now),
        DominionError::GuardianRemovalExpired
    );
    // BINDING floor check against the LIVE count, not the count at schedule time, so
    // the floor holds even if the set shrank for another reason in between.
    require!(
        ctx.accounts.config.guardian_count > MIN_ACTIVE_GUARDIANS,
        DominionError::GuardianFloorBreached
    );

    let guardian = &mut ctx.accounts.guardian_account;
    guardian.cooldown_until = now + GUARDIAN_REMOVE_COOLDOWN_SECONDS;
    guardian.pending_removal_at = 0;

    let config = &mut ctx.accounts.config;
    // Neither subtraction can underflow (count >= 2 by the floor guard, pending >= 1 by
    // `scheduled != 0`). checked_sub anyway: saturating would mask a counter desync.
    config.guardian_count = config
        .guardian_count
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_removal_count = config
        .pending_removal_count
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    emit!(GuardianRemoved {
        guardian: guardian_pubkey,
        cooldown_until: guardian.cooldown_until,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(guardian_pubkey: Pubkey)]
pub struct CancelGuardianRemoval<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ConfigAccount>,

    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [GUARDIAN_SEED, guardian_pubkey.as_ref()],
        bump,
        constraint = guardian_account.guardian == guardian_pubkey @ DominionError::Unauthorized,
    )]
    pub guardian_account: Account<'info, GuardianAccount>,
}

/// Cancel a scheduled removal. Three callers, in precedence order:
///  1. ANYONE, once the notice expired: housekeeping, and it keeps
///     `pending_removal_count` from staying inflated and blocking future removals.
///  2. The ADMIN, free, and it never consumes the target's self-defence budget.
///  3. The TARGETED GUARDIAN ITSELF, ONCE.
// Capping (3) bounds eviction to two windows (48h at launch). Unlimited self-cancels
// made a rogue guardian permanently unremovable, and `pause` (guardian) against
// `unpause` (admin-only) gave it an indefinite halt. Rate-limiting `pause` instead was
// rejected: re-pausing against a compromised admin is why that power exists.
pub fn cancel_removal_handler(
    ctx: Context<CancelGuardianRemoval>,
    guardian_pubkey: Pubkey,
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let now = Clock::get()?.unix_timestamp;
    let is_admin = signer == ctx.accounts.config.admin;
    // The seeds bind the account to guardian_pubkey, so the target cannot be spoofed.
    let is_target = signer == guardian_pubkey;

    let scheduled = ctx.accounts.guardian_account.pending_removal_at;
    require!(scheduled != 0, DominionError::GuardianRemovalNotScheduled);
    let expired = removal_schedule_expired(scheduled, now);

    if expired {
        // Housekeeping, open to anyone.
    } else if is_admin {
        // Checked BEFORE the target branch so a key holding both roles does not burn
        // the guardian's one veto.
    } else if is_target {
        require!(
            !ctx.accounts.guardian_account.self_cancel_used,
            DominionError::GuardianSelfCancelExhausted
        );
        ctx.accounts.guardian_account.self_cancel_used = true;
    } else {
        return Err(error!(DominionError::Unauthorized));
    }

    ctx.accounts.guardian_account.pending_removal_at = 0;
    let config = &mut ctx.accounts.config;
    // `scheduled != 0` proves this guardian was counted as pending.
    config.pending_removal_count = config
        .pending_removal_count
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    emit!(GuardianRemovalCancelled {
        guardian: guardian_pubkey,
        cancelled_by: signer,
    });
    Ok(())
}
