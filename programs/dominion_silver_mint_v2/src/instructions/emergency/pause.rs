use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{Paused, Unpaused};
use crate::state::*;

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ConfigAccount>,

    pub signer: Signer<'info>,

    /// Optional guardian PDA tied to `signer` via PDA seeds. Required when signer != admin.
    /// The seeds constraint forces the PDA to belong to the signer (no spoofing).
    #[account(
        seeds = [GUARDIAN_SEED, signer.key().as_ref()],
        bump,
    )]
    pub guardian: Option<Account<'info, GuardianAccount>>,
}

pub fn pause_handler(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();

    let admin_key = config.admin;
    let is_admin = signer == admin_key;
    // review of daac4ac: `may_act` also refuses a guardian key that IS the
    // current admin. add_guardian cannot prevent that overlap on its own, because
    // admin-ship can move after the appointment.
    let is_guardian = match &ctx.accounts.guardian {
        Some(g) => g.may_act(&signer, &admin_key),
        None => false,
    };
    require!(is_admin || is_guardian, DominionError::Unauthorized);

    config.paused = true;
    emit!(Paused {
        by: signer,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    /// the conditional P2 that comes with the open launch posture. `unpause` used to check
    /// the admin signature and nothing else, while `initialize` leaves `guardian_count = 0`. With
    /// mint and redeem now OPEN in the initial state, that sequence lets a ceremony slip or a
    /// compromised admin switch every flow on before any independent party can pause or cancel. The
    /// timelocks and the emergency response both assume that party exists.
    #[account(
        seeds = [GUARDIAN_SEED, guardian.guardian.as_ref()], bump,
        constraint = guardian.cooldown_until == 0 @ DominionError::GuardianInCooldown,
    )]
    pub guardian: Account<'info, GuardianAccount>,
}

pub fn unpause_handler(ctx: Context<Unpause>, expected_readiness_digest: [u8; 32]) -> Result<()> {
    // Counting is not enough, and neither is passing any registered account: the brake has to be held
    // by someone who is not the hand being braked. A guardian slot occupied by the current admin is a
    // brake wired to the same lever.
    require!(
        ctx.accounts.config.guardian_count > 0,
        DominionError::NoActiveGuardian
    );
    require!(
        ctx.accounts.guardian.guardian != ctx.accounts.config.admin,
        DominionError::GuardianNotIndependent
    );

    // -03. THE GAP BETWEEN BUILDING AN UNPAUSE AND EXECUTING IT.
    // `scripts/_launch-readiness.ts` decides go/no-go from the config, the feed, the publisher floor
    // and the supply, and it runs when the ceremony BUILDS this instruction. The instruction is a
    // Squads proposal, so it executes later. In between, a matured timelocked action can execute
    // against a paused config: auto-pause is idempotent there, so nothing invalidates the approved
    // unpause and it lands on a state the decision never saw.
    // The first attempt refused while any slot was armed. That reads the CURRENT counter, and the
    // action that executes in the gap DISARMS itself, bringing the counter back to zero before the
    // unpause lands. was right: a counter is not historical.
    // The caller now carries the digest of the state it approved. If any load-bearing field moved,
    // this refuses, and the operator re-reads and rebuilds. Nothing about the ARMED state is checked
    // any more, which also gives back the ability to resume from an incident pause with queued
    // actions still in the file: that cost was a side effect of the wrong mechanism, not a goal.
    require!(
        ctx.accounts.config.readiness_digest() == expected_readiness_digest,
        DominionError::StaleReadinessDigest
    );

    let config = &mut ctx.accounts.config;
    config.paused = false;
    emit!(Unpaused {
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
