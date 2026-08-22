// cancel_timelocked_action: callable by the admin OR an active guardian. Clears the
// state the cancelled action had armed (e.g. mint_paused_until for premium_mint).

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
    // `may_act` also refuses a guardian key that IS the current admin.
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
        x if x == TimelockAction::SetInventoryWallet as u8 => {
            Some(TimelockAction::SetInventoryWallet)
        }
        // HAZARD, found by a test rather than by reading. This `_ => None` silently swallows
        // any discriminant not listed above, so a NEW action added to the enum cancels its account and
        // leaves its `pending_*_nonce` slot armed forever: no further proposal of that kind can ever
        // be made, and the guardian's veto looks like it worked. The disarm `match` below is
        // exhaustive and forced the second half of this change; this half has a catch-all and did not.
        // WHOEVER ADDS AN ACTION: add it HERE too, and write the cancel test. `cancelling_a_change_
        // releases_the_slot_and_leaves_the_wallet_alone` in tools/state-harness is the one that
        // caught it, by asserting the slot is None afterwards rather than that the call succeeded.
        _ => None,
    };

    // INVARIANT: clear the single-active slot ONLY IF IT STILL POINTS AT THIS NONCE.
    // `execute_*` reads the slot, so an unconditional clear keyed on the action kind
    // alone lets cancelling an ORPHANED proposal silently wipe a LIVE one, costing the
    // operator another full timelock window with only a NonceMismatch to go on.
    // `scripts/cancel-all.ts` walks every surviving account, so this is reachable.
    macro_rules! disarm_if_mine {
        ($field:ident) => {
            if should_disarm(config.$field, nonce) {
                config.$field = None;
            }
        };
    }
    if let Some(a) = action {
        match a {
            TimelockAction::SetPremiumMint => {
                // Conditional matters MORE here: clearing `mint_paused_until` while a
                // DIFFERENT premium-mint proposal is still executable would reopen the
                // front-run window that field exists to close.
                if should_disarm(config.pending_premium_mint_nonce, nonce) {
                    config.pending_premium_mint_nonce = None;
                    config.mint_paused_until = 0;
                }
            }
            TimelockAction::SetPremiumRedeem => disarm_if_mine!(pending_premium_redeem_nonce),
            TimelockAction::WithdrawUsdc => disarm_if_mine!(pending_withdraw_nonce),
            TimelockAction::SetTreasuryFloat => disarm_if_mine!(pending_treasury_float_nonce),
            TimelockAction::SetOracleGuards => disarm_if_mine!(pending_oracle_guards_nonce),
            TimelockAction::UpdateMetadata => disarm_if_mine!(pending_metadata_nonce),
            TimelockAction::SetComplianceMode => disarm_if_mine!(pending_compliance_nonce),
            TimelockAction::SetPythFeed => disarm_if_mine!(pending_pyth_feed_nonce),
            TimelockAction::SetAdminTimelock => disarm_if_mine!(pending_admin_timelock_nonce),
            TimelockAction::SetRedeemLimits => disarm_if_mine!(pending_redeem_limits_nonce),
            TimelockAction::SetPublicMint => disarm_if_mine!(pending_public_mint_nonce),
            TimelockAction::SetInventoryWallet => disarm_if_mine!(pending_inventory_wallet_nonce),
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

/// Whether cancelling proposal `nonce` should clear a single-active slot holding `slot`.
/// The rule is "only disarm what is mine". Pure and separate so it is testable.
pub fn should_disarm(slot: Option<u64>, nonce: u64) -> bool {
    slot == Some(nonce)
}

#[cfg(test)]
mod disarm_tests {
    use super::should_disarm;

    #[test]
    fn cancelling_my_own_proposal_disarms_the_slot() {
        assert!(should_disarm(Some(5), 5));
    }

    #[test]
    fn cancelling_an_orphan_does_NOT_touch_a_live_proposal() {
        // Propose 5, an instant close orphans it, re-propose gives 6, then the operator
        // tidies up by cancelling 5. Wiping 6 there costs another full window.
        assert!(
            !should_disarm(Some(6), 5),
            "cancelling orphan 5 must not clear a slot pointing at live proposal 6"
        );
    }

    #[test]
    fn cancelling_when_the_slot_is_already_empty_is_a_no_op() {
        // The orphan case with nothing re-proposed yet.
        assert!(!should_disarm(None, 5));
    }

    #[test]
    fn nonce_zero_is_not_special() {
        // Nonces start at 0, so `Some(0)` must not be confused with "empty".
        assert!(should_disarm(Some(0), 0));
        assert!(!should_disarm(None, 0));
        assert!(!should_disarm(Some(1), 0));
    }
}
