use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{GuardianAdded, GuardianRemoved};
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
    // This blocks that literal path. It does NOT stop an admin that holds any
    // second key, so it is a barrier, not a fix. See MIN_ACTIVE_GUARDIANS for the
    // full analysis and the required deferred-removal follow-up (action 0.12b).
    require!(
        guardian_pubkey != config.admin,
        DominionError::Unauthorized
    );

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
    let config = &mut ctx.accounts.config;
    let guardian = &mut ctx.accounts.guardian_account;
    let now = Clock::get()?.unix_timestamp;

    // DOM-007 (P1): never let a single admin signature strip the whole veto.
    // Removal is refused when it would take the active set below
    // MIN_ACTIVE_GUARDIANS. Strict inequality because the count is decremented
    // right below: with the floor at 1, a count of 2 may drop to 1, but a count
    // of 1 cannot drop to 0. Rotation is unaffected (add the replacement first,
    // then remove the old guardian). See MIN_ACTIVE_GUARDIANS for the rationale
    // and the accepted residual.
    require!(
        config.guardian_count > MIN_ACTIVE_GUARDIANS,
        DominionError::GuardianFloorBreached
    );

    guardian.cooldown_until = now + GUARDIAN_REMOVE_COOLDOWN_SECONDS;
    // The guard above proves count >= 2 here, so this cannot underflow. Use
    // checked_sub anyway (audit M-04: saturating_sub can mask a desync).
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
