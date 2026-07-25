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
    // able to tell whether a key is independent.
    require!(guardian_pubkey != config.admin, DominionError::Unauthorized);

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
    let config = &ctx.accounts.config;
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
    require!(
        ctx.accounts.guardian_account.pending_removal_at == 0,
        DominionError::GuardianRemovalAlreadyScheduled
    );
    // Early feedback only: the binding floor check is at finalize, because several
    // removals can be scheduled concurrently and the count only changes there.
    require!(
        config.guardian_count > MIN_ACTIVE_GUARDIANS,
        DominionError::GuardianFloorBreached
    );

    let effective_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
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
    // BINDING floor check. It lives here rather than only at schedule time because
    // removals can be scheduled concurrently: with three guardians an admin could
    // schedule all three (each passing the count check at 3) and then finalize them
    // one by one down to zero. Re-checking against the live count stops that.
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

    emit!(GuardianRemoved {
        guardian: guardian_pubkey,
        cooldown_until: guardian.cooldown_until,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(guardian_pubkey: Pubkey)]
pub struct CancelGuardianRemoval<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
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

/// Cancel a scheduled removal. Callable by the ADMIN (changed its mind) or by the
/// TARGETED GUARDIAN ITSELF, which is the point of the whole mechanism: the actor
/// being removed can veto it, so a compromised admin cannot quietly clear the veto.
pub fn cancel_removal_handler(
    ctx: Context<CancelGuardianRemoval>,
    guardian_pubkey: Pubkey,
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let is_admin = signer == ctx.accounts.config.admin;
    // The guardian account is PDA-derived from guardian_pubkey, so a caller cannot
    // spoof being the target: the seeds bind the account to the key.
    let is_target = signer == guardian_pubkey;
    require!(is_admin || is_target, DominionError::Unauthorized);

    let guardian = &mut ctx.accounts.guardian_account;
    require!(
        guardian.pending_removal_at != 0,
        DominionError::GuardianRemovalNotScheduled
    );
    guardian.pending_removal_at = 0;

    emit!(GuardianRemovalCancelled {
        guardian: guardian_pubkey,
        cancelled_by: signer,
    });
    Ok(())
}
