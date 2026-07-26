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

    // DOM-007, partial barrier added after the triple-review DEMONSTRATED the
    // bypass of the removal floor: the admin may not appoint ITSELF as a
    // guardian. Without this, one admin signature does
    //     add_guardian(config.admin); remove_guardian(G1); ... remove_guardian(Gn)
    // walking the set down to a single admin-controlled "guardian" while never
    // breaching MIN_ACTIVE_GUARDIANS, so the veto survives only on paper.
    // This blocks the literal self-appointment path. It is a barrier, not the fix:
    // an admin holding any second key defeats it. The actual fix is the deferred
    // removal implemented in remove_handler below, which does not depend on being
    // able to tell whether a key is independent. See the MIN_ACTIVE_GUARDIANS
    // comment in state/config.rs for the honest statement of what is and is not
    // closed here.
    require!(guardian_pubkey != config.admin, DominionError::Unauthorized);
    // AUDIT review of daac4ac: also refuse the INCOMING admin. Without this the
    // barrier above is trivially sidestepped by appointing K as guardian while A is
    // admin and then completing an already-pending transfer of admin-ship to K.
    // `GuardianAccount::may_act` is the backstop for the case where admin-ship moves
    // after the appointment, which this check cannot see.
    if let Some(pending) = config.pending_admin {
        require!(guardian_pubkey != pending, DominionError::Unauthorized);
    }

    // Cooldown enforcement (D32). cooldown_until is set on remove.
    if guardian.cooldown_until != 0 {
        require!(
            now >= guardian.cooldown_until,
            DominionError::GuardianInCooldown
        );
    }

    // Re-add guardrail: if guardian is already active (added_at != 0 AND cooldown == 0), revert.
    // First-time creation: added_at == 0.
    if guardian.added_at != 0 && guardian.cooldown_until == 0 {
        return Err(error!(DominionError::ProposalAlreadyActive));
    }

    // Max guardian count cap (D40).
    require!(
        config.guardian_count < config.max_guardian_count,
        DominionError::GuardianCountExceeded
    );

    // Persist the guardian pubkey on first add (or re-add post-cooldown).
    guardian.guardian = guardian_pubkey;
    guardian.added_at = now;
    guardian.cooldown_until = 0;
    guardian.pending_removal_at = 0;
    // A re-appointment is a fresh mandate, so the self-defence budget resets. Only
    // this instruction clears the flag, and it is admin-only and requires the removal
    // cooldown to have elapsed, so a guardian can never restore its own budget.
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

    // AUDIT action 0.12b, the real DOM-007 fix. Removal is now SCHEDULED, not
    // applied. Rationale: the previous instant removal made the guardian veto
    // circular, because the very actor the veto exists to stop could delete it in
    // one signature. A numeric floor did not fix that (the triple-review showed an
    // admin can add a puppet and walk the set down to the floor), because no
    // on-chain check can tell whether a key is genuinely independent.
    //
    // Deferring instead gives the VICTIM time to act. The guardian keeps
    // `cooldown_until == 0` for the whole window, and every authorization site
    // (pause, cancel_timelocked_action, cancel_admin_transfer) tests exactly that,
    // so a targeted guardian retains full powers and can pause the protocol, cancel
    // the pending action the removal was meant to clear the way for, or cancel its
    // own removal.
    let existing = ctx.accounts.guardian_account.pending_removal_at;
    // An EXPIRED schedule unarms itself and may be replaced by a fresh one, which
    // starts a fresh full window. Without this branch an expired schedule would block
    // the guardian's removal forever, and `pending_removal_count` could never be
    // brought back down (see cancel_removal_handler, which anyone may call once a
    // schedule is dead).
    require!(
        existing == 0 || removal_schedule_expired(existing, now),
        DominionError::GuardianRemovalAlreadyScheduled
    );

    let effective_at = now
        .checked_add(ctx.accounts.config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    if existing == 0 {
        // A genuinely NEW notice. The floor is evaluated against guardians not
        // already under notice, so the admin cannot schedule the whole set inside one
        // window: at least MIN_ACTIVE_GUARDIANS guardians always remain free to
        // react, cancel, and pause. Re-arming an expired notice does not change the
        // count, so it deliberately skips both the check and the increment.
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
/// PERMISSIONLESS on purpose: anyone may apply an already-public, already-delayed
/// decision, so a stalling admin cannot keep a removal hanging over a guardian
/// indefinitely, and the admin does not need to come back to finish the job.
pub fn finalize_removal_handler(
    ctx: Context<FinalizeGuardianRemoval>,
    guardian_pubkey: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let scheduled = ctx.accounts.guardian_account.pending_removal_at;

    require!(scheduled != 0, DominionError::GuardianRemovalNotScheduled);
    require!(now >= scheduled, DominionError::TimelockNotElapsed);
    // The notice must be acted on inside its window. A matured schedule left armed
    // forever is a stored instant-removal coupon: the admin pre-arms during quiet
    // operation and evicts later with no reaction window at all.
    require!(
        !removal_schedule_expired(scheduled, now),
        DominionError::GuardianRemovalExpired
    );
    // BINDING floor check against the LIVE count, not the count at schedule time.
    // `may_schedule_removal` already stops the whole set being put under notice at
    // once; this is the second line, and it is what makes the floor hold even if the
    // set shrank for another reason between schedule and finalize.
    require!(
        ctx.accounts.config.guardian_count > MIN_ACTIVE_GUARDIANS,
        DominionError::GuardianFloorBreached
    );

    let guardian = &mut ctx.accounts.guardian_account;
    guardian.cooldown_until = now + GUARDIAN_REMOVE_COOLDOWN_SECONDS;
    guardian.pending_removal_at = 0;

    let config = &mut ctx.accounts.config;
    // The floor guard proves count >= 2 here, so this cannot underflow. checked_sub
    // regardless (audit M-04: saturating arithmetic can mask a desync).
    config.guardian_count = config
        .guardian_count
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    // `scheduled != 0` above proves this guardian was counted as pending, so this
    // cannot underflow either.
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

/// Cancel a scheduled removal.
///
/// Three callers, in precedence order:
///
///  1. ANYONE, once the notice has expired. A dead schedule can no longer be
///     finalized, so clearing it is pure housekeeping, and leaving it to the admin
///     alone would let `pending_removal_count` stay permanently inflated (which would
///     block future removals through the floor check).
///  2. The ADMIN, which changed its mind. Free, and never consumes the target's
///     self-defence budget.
///  3. The TARGETED GUARDIAN ITSELF, ONCE. This is the point of the mechanism: the
///     actor being removed can veto it, so a compromised admin cannot quietly clear
///     the veto.
///
/// AUDIT review of daac4ac (P0, found independently by the correctness and the
/// security reviewer): (3) was originally unlimited. That made a ROGUE guardian
/// permanently unremovable, because the admin's only path is schedule-then-wait and
/// the guardian could cancel inside every window forever, while `pause` (guardian) vs
/// `unpause` (admin-only) gave it an indefinite protocol halt. The exit was a program
/// upgrade. Capping the self-veto at one use bounds eviction to two windows (48h at
/// launch) while keeping the property the deferral exists for: a single opportunistic
/// removal cannot succeed without the admin publicly re-committing to it.
///
/// Alternative considered and rejected: rate-limiting the guardian `pause` power.
/// That would have inverted the threat model, because an honest guardian re-pausing
/// against a compromised admin is the primary reason the pause power exists.
pub fn cancel_removal_handler(
    ctx: Context<CancelGuardianRemoval>,
    guardian_pubkey: Pubkey,
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let now = Clock::get()?.unix_timestamp;
    let is_admin = signer == ctx.accounts.config.admin;
    // The guardian account is PDA-derived from guardian_pubkey, so a caller cannot
    // spoof being the target: the seeds bind the account to the key.
    let is_target = signer == guardian_pubkey;

    let scheduled = ctx.accounts.guardian_account.pending_removal_at;
    require!(scheduled != 0, DominionError::GuardianRemovalNotScheduled);
    let expired = removal_schedule_expired(scheduled, now);

    if expired {
        // Housekeeping, open to anyone.
    } else if is_admin {
        // Admin withdrawal. Deliberately checked BEFORE the target branch so that a
        // key holding both roles does not burn the guardian's one veto.
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
