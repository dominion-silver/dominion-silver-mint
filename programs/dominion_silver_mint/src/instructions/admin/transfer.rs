use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::*;
use crate::state::*;

#[derive(Accounts)]
pub struct ProposeAdminTransfer<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
}

pub fn propose_handler(ctx: Context<ProposeAdminTransfer>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    // Reject overwriting an active pending transfer to avoid silent races.
    // Cancel must be called explicitly first (or wait for expiry).
    if let Some(_existing) = config.pending_admin {
        require!(
            now > config.pending_admin_expires_at,
            DominionError::ProposalAlreadyActive
        );
    }

    require!(
        new_admin != Pubkey::default(),
        DominionError::InvalidPendingAdmin
    );
    require!(new_admin != config.admin, DominionError::ProposalNoOp);

    config.pending_admin = Some(new_admin);
    config.pending_admin_expires_at = now + PENDING_ADMIN_EXPIRY_SECONDS;
    emit!(AdminTransferProposed {
        current: config.admin,
        proposed: new_admin,
        expires_at: config.pending_admin_expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdminTransfer<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ConfigAccount>,
    pub new_admin: Signer<'info>,
}

pub fn accept_handler(ctx: Context<AcceptAdminTransfer>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    let pending = config
        .pending_admin
        .ok_or(error!(DominionError::InvalidPendingAdmin))?;
    require!(
        pending == ctx.accounts.new_admin.key(),
        DominionError::InvalidPendingAdmin
    );
    require!(
        now <= config.pending_admin_expires_at,
        DominionError::PendingAdminExpired
    );

    let old = config.admin;
    config.admin = pending;
    config.pending_admin = None;
    config.pending_admin_expires_at = 0;

    emit!(AdminTransferAccepted { old, new: pending });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelAdminTransfer<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
}

pub fn cancel_handler(ctx: Context<CancelAdminTransfer>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_admin = None;
    config.pending_admin_expires_at = 0;
    Ok(())
}
