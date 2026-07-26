// cancel_timelocked_action: callable by admin OR active guardian.
// Clears state per the cancelled action (e.g. mint_paused_until for premium_mint).

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::AdminActionCancelled;
use crate::state::*;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CancelTimelocked<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ConfigAccount>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()],
        bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    /// CHECK: rent recipient is the original timelock proposer; verified by `address`.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,

    pub signer: Signer<'info>,

    /// Optional guardian PDA tied to `signer` via PDA seeds (no spoofing). Required when signer != admin.
    #[account(
        seeds = [GUARDIAN_SEED, signer.key().as_ref()],
        bump,
    )]
    pub guardian: Option<Account<'info, GuardianAccount>>,
}

pub fn cancel_handler(ctx: Context<CancelTimelocked>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.signer.key();

    let admin_key = config.admin;
    let is_admin = signer == admin_key;
    // AUDIT review of daac4ac: `may_act` also refuses a guardian key that IS the
    // current admin. add_guardian cannot prevent that overlap on its own, because
    // admin-ship can move after the appointment.
    let is_guardian = match &ctx.accounts.guardian {
        Some(g) => g.may_act(&signer, &admin_key),
        None => false,
    };
    require!(is_admin || is_guardian, DominionError::Unauthorized);

    let tl = &mut ctx.accounts.timelock;
    require!(tl.nonce == nonce, DominionError::NonceMismatch);

    // Clear pending_*_nonce for this action kind.
    use crate::state::TimelockAction;
    let action = match tl.action_disc {
        x if x == TimelockAction::SetPremiumMint as u8 => Some(TimelockAction::SetPremiumMint),
        x if x == TimelockAction::SetPremiumRedeem as u8 => Some(TimelockAction::SetPremiumRedeem),
        x if x == TimelockAction::WithdrawUsdc as u8 => Some(TimelockAction::WithdrawUsdc),
        x if x == TimelockAction::SetTreasuryFloat as u8 => Some(TimelockAction::SetTreasuryFloat),
        x if x == TimelockAction::SetOracleGuards as u8 => Some(TimelockAction::SetOracleGuards),
        x if x == TimelockAction::UpdateMetadata as u8 => Some(TimelockAction::UpdateMetadata),
        x if x == TimelockAction::SetComplianceMode as u8 => {
            Some(TimelockAction::SetComplianceMode)
        }
        x if x == TimelockAction::SetPythFeed as u8 => Some(TimelockAction::SetPythFeed),
        x if x == TimelockAction::SetAdminTimelock as u8 => Some(TimelockAction::SetAdminTimelock),
        x if x == TimelockAction::SetRedeemLimits as u8 => Some(TimelockAction::SetRedeemLimits),
        x if x == TimelockAction::SetPublicMint as u8 => Some(TimelockAction::SetPublicMint),
        _ => None,
    };

    if let Some(a) = action {
        match a {
            TimelockAction::SetPremiumMint => {
                config.pending_premium_mint_nonce = None;
                // D30: clear mint_paused_until on cancel.
                config.mint_paused_until = 0;
            }
            TimelockAction::SetPremiumRedeem => config.pending_premium_redeem_nonce = None,
            TimelockAction::WithdrawUsdc => config.pending_withdraw_nonce = None,
            TimelockAction::SetTreasuryFloat => config.pending_treasury_float_nonce = None,
            TimelockAction::SetOracleGuards => config.pending_oracle_guards_nonce = None,
            TimelockAction::UpdateMetadata => config.pending_metadata_nonce = None,
            TimelockAction::SetComplianceMode => config.pending_compliance_nonce = None,
            TimelockAction::SetPythFeed => config.pending_pyth_feed_nonce = None,
            TimelockAction::SetAdminTimelock => config.pending_admin_timelock_nonce = None,
            TimelockAction::SetRedeemLimits => config.pending_redeem_limits_nonce = None,
            TimelockAction::SetPublicMint => config.pending_public_mint_nonce = None,
        }
    }

    tl.cancelled = true;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);

    emit!(AdminActionCancelled {
        nonce,
        cancelled_by: signer,
    });
    Ok(())
}
