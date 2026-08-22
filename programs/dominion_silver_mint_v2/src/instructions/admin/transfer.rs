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
    // FIX B (launch spec 2026-07): accept is gated behind the admin timelock so a
    // compromised admin can't propose + accept in the same block. eta = now +
    // admin_timelock_seconds, and the accept window is [eta, eta +
    // PENDING_ADMIN_EXPIRY_SECONDS] so it is always a full expiry-window wide
    // regardless of the timelock value (the old `expires_at = now +
    // expiry` collapsed the window to zero when the timelock equalled the 7-day
    // expiry).
    let eta = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_admin_eta = eta;
    config.pending_admin_expires_at = eta
        .checked_add(PENDING_ADMIN_EXPIRY_SECONDS)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    emit!(AdminTransferProposed {
        current: config.admin,
        proposed: new_admin,
        eta,
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
    // FIX B: enforce the timelock delay (can't accept before the eta set at propose).
    require!(
        now >= config.pending_admin_eta,
        DominionError::TimelockNotElapsed
    );

    let old = config.admin;
    config.admin = pending;
    config.pending_admin = None;
    config.pending_admin_expires_at = 0;
    config.pending_admin_eta = 0;

    emit!(AdminTransferAccepted { old, new: pending });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelAdminTransfer<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ConfigAccount>,

    pub signer: Signer<'info>,

    /// Optional guardian PDA tied to `signer` via PDA seeds (no spoofing).
    /// Required when signer != admin. FIX B: a guardian can kill a malicious
    /// admin-transfer proposal during the 24h delay window.
    #[account(
        seeds = [GUARDIAN_SEED, signer.key().as_ref()],
        bump,
    )]
    pub guardian: Option<Account<'info, GuardianAccount>>,
}

pub fn cancel_handler(ctx: Context<CancelAdminTransfer>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let admin_key = ctx.accounts.config.admin;
    let is_admin = signer == admin_key;
    // review of daac4ac: `may_act` also refuses a guardian key that IS the
    // current admin. add_guardian cannot prevent that overlap on its own, because
    // admin-ship can move after the appointment.
    let is_guardian = match &ctx.accounts.guardian {
        Some(g) => g.may_act(&signer, &admin_key),
        None => false,
    };
    require!(is_admin || is_guardian, DominionError::Unauthorized);

    let config = &mut ctx.accounts.config;
    let cancelled_pending_admin = config.pending_admin;
    config.pending_admin = None;
    config.pending_admin_expires_at = 0;
    config.pending_admin_eta = 0;
    // the most important of the five: propose AND accept both
    // emit, but cancelling a governance handover did not, so the one transition an
    // operator most needs in their logs was the invisible one.
    emit!(AdminTransferCancelled {
        cancelled_pending_admin,
        by: signer,
    });
    Ok(())
}
