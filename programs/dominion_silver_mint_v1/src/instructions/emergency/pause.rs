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

    let is_admin = signer == config.admin;
    let is_guardian = match &ctx.accounts.guardian {
        Some(g) => g.guardian == signer && g.cooldown_until == 0,
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
}

pub fn unpause_handler(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = false;
    emit!(Unpaused {
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
