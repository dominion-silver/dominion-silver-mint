// Timelock execute instructions.
// Common rules:
//   - Reverts if now < executable_at (TimelockNotElapsed).
//   - Reverts if cancelled or already executed.
//   - Re-validates args at execute (state may have shifted during the window).
//   - Clears pending_*_nonce, decrements active_proposal_count.
//   - For premium_mint: clears mint_paused_until.
//   - For withdraw: also reverts if paused at execute (D31). Bounded by the
//     treasury minimum FLOAT (Option B D7 option a) - NOT the old reserve
//     invariant (removed in the Option A teardown).
//   - For pyth_feed: atomically sets paused=true (admin must verify + unpause manually).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{Mint as InterfaceMint, Token2022};

use crate::cpi::usdc_transfer_treasury_to_user;
use crate::errors::DominionError;
use crate::events::*;
use crate::state::*;
// Option B: withdraw no longer reads the oracle or a reserve invariant. The
// float check (D7 option a) is a price-independent USDC floor, so the Pyth
// account + reserve math are removed from the withdraw path entirely (this
// also removes the CODEX M-01 reserve-price-manipulation attack surface).

// === Execute SetPremium (mint or redeem) ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecutePremium<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()],
        bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    /// CHECK: rent recipient is timelock.rent_payer; verified by `address` constraint.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_premium_mint_handler(ctx: Context<ExecutePremium>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetPremiumMint as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let new_bps = decode_u16(&tl.action_data)?;
    require!(
        new_bps <= PREMIUM_BPS_MINT_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (new_bps as u32) + (config.premium_bps_redeem as u32) >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );

    config.premium_bps_mint = new_bps;
    config.pending_premium_mint_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    config.mint_paused_until = 0;
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

pub fn execute_set_premium_redeem_handler(ctx: Context<ExecutePremium>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetPremiumRedeem as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let new_bps = decode_u16(&tl.action_data)?;
    require!(
        new_bps <= PREMIUM_BPS_REDEEM_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (config.premium_bps_mint as u32) + (new_bps as u32) >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );

    config.premium_bps_redeem = new_bps;
    config.pending_premium_redeem_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === Execute Withdraw (Option B: float check, D7 option a) ===
// BPF 4 KB stack frame: Box every sizable account (ConfigAccount ~669 B +
// TimelockQueueAccount + 3 token accounts overflowed try_accounts by 144 B
// un-boxed). Same pattern as mint_silv/redeem_silv.

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteWithdraw<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()],
        bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Box<Account<'info, TimelockQueueAccount>>,

    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,

    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    #[account(mut, address = config.usdc_treasury)]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    /// Recipient USDC ATA. Owner is asserted manually in handler against action_data.recipient.
    /// Anchor `token::authority` constraint cannot reference action_data, so we deserialize
    /// and check manually with a dedicated error.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::token_program = classic_token_program,
    )]
    pub recipient_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: treasury PDA signs.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,
}

pub fn execute_withdraw_usdc_handler(ctx: Context<ExecuteWithdraw>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::WithdrawUsdc as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    // D31: reject if paused.
    require!(!config.paused, DominionError::WithdrawBlockedWhilePaused);

    // Decode (amount, recipient).
    require!(
        tl.action_data.len() >= 8 + 32,
        DominionError::MalformedActionData
    );
    let amount = u64::from_le_bytes(tl.action_data[..8].try_into().unwrap());
    let recipient = Pubkey::try_from(&tl.action_data[8..40])
        .map_err(|_| error!(DominionError::ArithmeticOverflow))?;
    require!(amount > 0, DominionError::ZeroAmount);
    // M9: dedicated error for recipient mismatch (vs reusing WrongTreasury).
    require!(
        ctx.accounts.recipient_ata.owner == recipient,
        DominionError::WithdrawRecipientMismatch
    );

    // Option B (D7 option a): the admin withdraw is bounded by the treasury
    // minimum FLOAT, not a reserve invariant. The float is a price-independent
    // USDC amount, so NO oracle read / reserve math is needed (this also kills
    // the CODEX M-01 reserve-price-manipulation surface entirely). The float
    // blocks ADMIN withdraw only; redemptions can still draw the treasury
    // below it (then route OTC) - they do NOT subtract the float.
    let treasury_pre = ctx.accounts.usdc_treasury.amount;
    require!(treasury_pre >= amount, DominionError::InsufficientTreasury);
    let treasury_post = treasury_pre
        .checked_sub(amount)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        treasury_post >= config.treasury_min_float_usdc,
        DominionError::FloorBreached
    );

    // Transfer.
    let bump = ctx.bumps.treasury_pda;
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    usdc_transfer_treasury_to_user(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.recipient_ata.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.treasury_pda.to_account_info(),
        signer_seeds,
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    config.pending_withdraw_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    emit!(TreasuryWithdraw {
        amount,
        recipient,
        timestamp: now,
    });
    Ok(())
}

// === Execute SetComplianceMode ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteCompliance<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()],
        bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_compliance_mode_handler(
    ctx: Context<ExecuteCompliance>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetComplianceMode as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let new_value = tl.action_data.first().copied().unwrap_or(0) != 0;
    require!(
        new_value != config.compliance_mode,
        DominionError::ComplianceModeUnchanged
    );
    config.compliance_mode = new_value;
    config.pending_compliance_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    // M4: Auto-pause on compliance flip (analogous to execute_set_pyth_feed).
    // Admin must verify off-chain governance is ready (Squads vault holds delegate authority,
    // freeze procedures documented) and explicitly unpause.
    if !config.paused {
        config.paused = true;
        emit!(crate::events::Paused {
            by: ctx.accounts.admin.key(),
            timestamp: now,
        });
    }

    emit!(ComplianceModeChanged { new_value });
    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === Execute SetOracleGuards (D37 Option<T> per field) ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteOracleGuards<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_oracle_guards_handler(
    ctx: Context<ExecuteOracleGuards>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetOracleGuards as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let g = OracleGuardsArgs::try_from_slice(&tl.action_data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;

    // Defense-in-depth bounds at execute time (re-validates propose), so a
    // 24h-window attacker cannot disable the oracle guards. Lazer migration 5.5
    // Tier A: these are the TIGHTENED structural ceilings (staleness <=30,
    // conf_bps <=500, max_delta_bps <=1000, price band within the fat-finger
    // rails), replacing the Core-era ranges (was 5..300 / 1..1000 / 1..5000).
    // The min on conf_bps / max_delta_bps prevents a 0 from bricking the oracle
    // (conf_bps=0 => only exactly-zero confidence passes; max_delta_bps=0 =>
    // any price move reverts). Keep in lockstep with propose_set_oracle_guards.
    if let Some(v) = g.staleness {
        // Lazer 5.5 Tier A: hard-capped well below the Core-era 60/300.
        require!(
            v >= 5 && v <= MAX_STALENESS_CEILING_SECONDS,
            DominionError::AboveMaximum
        );
        config.max_staleness_seconds = v;
    }
    if let Some(v) = g.conf_bps {
        require!(
            v >= 1 && v <= MAX_CONFIDENCE_BPS_CEILING,
            DominionError::AboveMaximum
        );
        config.max_confidence_bps = v;
    }
    if let Some(v) = g.min_price_scaled {
        // 0 = lower-bound off-switch; otherwise within the fat-finger band.
        require!(
            v == 0 || (v >= PRICE_FATFINGER_MIN_SCALED && v <= PRICE_FATFINGER_MAX_SCALED),
            DominionError::PriceOutOfBounds
        );
        config.min_price_usd_scaled = v;
    }
    if let Some(v) = g.max_price_scaled {
        config.max_price_usd_scaled = v;
    }
    // A zero UPPER price bound bricks every oracle read (lazer_price's policy
    // requires `normalized <= max_price_usd_scaled`; any positive price then
    // reverts). It is NOT a valid "off" sentinel - unlike `min_price == 0`,
    // which legitimately disables the lower bound since `normalized` is
    // u128 >= 0. Forbid max == 0 outright.
    // Lazer 5.5 Tier A fat-finger rail: 0 < max <= ceiling (no looser than the
    // prior Core $200). A zero upper bound bricks every read.
    require!(
        config.max_price_usd_scaled != 0
            && config.max_price_usd_scaled <= PRICE_FATFINGER_MAX_SCALED,
        DominionError::PriceOutOfBounds
    );
    // Cross-field: min must be 0 (lower bound off) or strictly below max.
    require!(
        config.min_price_usd_scaled == 0
            || config.min_price_usd_scaled < config.max_price_usd_scaled,
        DominionError::PriceOutOfBounds
    );
    if let Some(v) = g.max_delta_bps {
        require!(
            v >= 1 && v <= MAX_PRICE_DELTA_BPS_CEILING,
            DominionError::AboveMaximum
        );
        config.max_price_delta_bps = v;
    }
    if let Some(v) = g.decay_seconds {
        // Spec-silent; defensive (D14). Min 60s so decay=0 cannot disable the
        // breaker (elapsed > 0 would always "decay"); max 7 days so it re-arms.
        require!(v >= 60 && v <= 7 * 86400, DominionError::AboveMaximum);
        config.price_delta_decay_seconds = v;
    }
    if let Some(v) = g.dust_filter_min_usdc {
        // Spec-silent; defensive (D14). Cap at $1M so the dust filter cannot be
        // set so high that last_recorded_price never updates (breaker stale).
        require!(v <= 1_000_000_000_000, DominionError::AboveMaximum);
        config.price_update_min_amount_usdc = v;
    }
    if let Some(v) = g.min_publishers {
        // Lazer 5.5: the operating publisher floor; cannot be set below the
        // Tier A hard floor.
        require!(
            v >= crate::lazer_price::MIN_PUBLISHERS_FLOOR_HARD,
            DominionError::LazerTooFewPublishers
        );
        config.min_publishers = v;
    }
    // Option B: reserve_price_ramp_bps removed (no reserve-check price).

    // Atomic auto-pause on ANY oracle-guard change (Fable audit P2-A). Mirrors
    // execute_set_pyth_feed + execute_set_compliance_mode: an oracle-config
    // change (incl. WEAKENING staleness/conf/delta/price-band or LOWERING
    // min_publishers) must never go live silently after the 24h window. The
    // admin re-validates against live data, then unpauses. Idempotent if the
    // contract is already paused (e.g. the pre-unpause launch sequence).
    if !config.paused {
        config.paused = true;
        emit!(crate::events::Paused {
            by: ctx.accounts.admin.key(),
            timestamp: now,
        });
    }

    config.pending_oracle_guards_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OracleGuardsArgs {
    pub staleness: Option<u32>,
    pub conf_bps: Option<u16>,
    pub min_price_scaled: Option<u64>,
    pub max_price_scaled: Option<u64>,
    pub max_delta_bps: Option<u16>,
    pub decay_seconds: Option<u32>,
    pub dust_filter_min_usdc: Option<u64>,
    // Lazer 5.5: operating publisher floor (timelocked-settable, >= hard floor).
    pub min_publishers: Option<u16>,
}

// === FIX A (launch spec 2026-07): loosen-slow / tighten-fast redeem throttles ===
// The head-dev threat-model fix for the "one-block drain": a compromised admin
// could strip every redemption rate-limit in a single instant tx, then redeem
// pre-held SILV at the honest price and empty the treasury before a guardian
// reacts. The fix (CORRECTION-2 clean shape):
//   - TIGHTENING (making a throttle safer) stays INSTANT, via ONE entrypoint
//     `emergency_tighten_redeem_limits` (caps.rs). One place for all direction
//     logic, so the counter-intuitive window direction can't be gotten wrong in
//     scattered setters.
//   - LOOSENING (any direction, in practice raising the drain capacity) goes
//     through this 24h-timelocked `SetRedeemLimits` action (guardian-cancellable).
// The four throttles here are the ONLY ones in scope. max_silv_supply
// (raise-blocked) and redemptions_enabled (enable-blocked at launch) keep their
// stricter dedicated instant setters and are intentionally NOT loosenable here.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct RedeemLimitsArgs {
    pub instant_redeem_budget_usdc: Option<u64>,
    pub instant_redeem_window_seconds: Option<u32>,
    /// DEAD since 2026-08-05 (the per-size tier was removed with the queue). Still accepted
    /// and still applied to the now-unread config field, because removing it would change
    /// this struct's borsh layout. See the note on `redemptions_enabled` below.
    pub large_redeem_threshold_usdc: Option<u64>,
    /// DEAD since 2026-08-05 (there is no queue). Same reasoning.
    pub redeem_queue_delay_seconds: Option<u32>,
    /// THE REDEEM SWITCH (Thomas, 2026-08-05). Appended, deliberately, to this action rather
    /// than given its own timelocked instruction and its own `pending_*_nonce`.
    ///
    /// Why it belongs here: enabling redemptions IS loosening a redeem throttle, which is
    /// precisely what this action exists for. It gets the 24h delay, the guardian-cancel
    /// window, the single-active-nonce guard and the ceiling re-validation for free, and it
    /// adds no bytes to ConfigAccount, whose `reserved` is down to 53.
    ///
    /// `Some(false)` counts as a TIGHTEN, so it is also available on the instant
    /// `emergency_tighten_redeem_limits` path, alongside the dedicated
    /// `set_redemptions_enabled(false)`. `Some(true)` is a LOOSEN and is refused there.
    ///
    /// BORSH CAVEAT, worth knowing before appending anything else here: this struct is
    /// serialized into `TimelockQueueAccount.action_data`, so appending a field makes any
    /// proposal that was queued under the OLD layout fail to deserialize at execute
    /// (`SerializationFailure`), because the stored bytes are one short. Cancelling such a
    /// proposal still works, since `cancel_timelocked_action` never decodes `action_data`.
    /// Before deploying this upgrade, check for a live SetRedeemLimits proposal and cancel it
    /// rather than leaving it stuck.
    pub redemptions_enabled: Option<bool>,
}

/// True if at least one field is provided (else the call is a pure no-op).
pub fn redeem_limits_any_set(args: &RedeemLimitsArgs) -> bool {
    args.instant_redeem_budget_usdc.is_some()
        || args.instant_redeem_window_seconds.is_some()
        || args.large_redeem_threshold_usdc.is_some()
        || args.redeem_queue_delay_seconds.is_some()
        || args.redemptions_enabled.is_some()
}

/// The SECOND no-op gate: does any PROVIDED field actually differ from the current config?
///
/// `redeem_limits_any_set` above answers a different question ("did the caller provide anything
/// at all"), and the two are independent. That independence caused a P0: `redemptions_enabled`
/// was added to `any_set` and NOT to this comparison, so a switch-only proposal passed the first
/// gate and died on `ProposalNoOp` in the second, leaving no path in the deployed program to open
/// redemptions at all.
///
/// Extracted out of `propose_set_redeem_limits`, where it lived inline, for two reasons: it is now
/// unit-testable (the version that shipped was covered by a test asserting the WRONG function
/// while claiming to protect this one), and both gates now sit in the same file so the next person
/// adding a field cannot see one without the other.
///
/// IF YOU ADD A FIELD TO `RedeemLimitsArgs`, IT MUST BE ADDED HERE AND TO `redeem_limits_any_set`.
pub fn redeem_limits_effective_change(
    args: &RedeemLimitsArgs,
    cur_budget: u64,
    cur_window: u32,
    cur_threshold: u64,
    cur_queue_delay: u32,
    cur_enabled: bool,
) -> bool {
    if args
        .instant_redeem_budget_usdc
        .is_some_and(|v| v != cur_budget)
    {
        return true;
    }
    if args
        .instant_redeem_window_seconds
        .is_some_and(|v| v != cur_window)
    {
        return true;
    }
    if args
        .large_redeem_threshold_usdc
        .is_some_and(|v| v != cur_threshold)
    {
        return true;
    }
    if args
        .redeem_queue_delay_seconds
        .is_some_and(|v| v != cur_queue_delay)
    {
        return true;
    }
    if args.redemptions_enabled.is_some_and(|v| v != cur_enabled) {
        return true;
    }
    false
}

/// Pure directional check for the INSTANT tighten path. Every PROVIDED field must
/// move its throttle in the SAFE (tighten) direction vs the current config. The
/// safety metric is max sustained drain: budget / window. Tighten = shrink it.
///   - budget:      new <= cur   (smaller instant budget = less drainable)
///   - window:      new >= cur   (LONGER window lowers budget/window drain rate;
///                                shortening it can also early-reset a near-
///                                exhausted budget, so shrink = LOOSEN)
///   - threshold:   new <= cur   (lower = MORE redemptions forced to the T+3 queue)
///   - queue_delay: new >= cur   (longer T+N wait before a queued claim pays out)
/// A field left None is unchanged (trivially safe). Unit-tested below.
pub fn redeem_limits_all_tighten(
    args: &RedeemLimitsArgs,
    cur_budget: u64,
    cur_window: u32,
    cur_threshold: u64,
    cur_queue_delay: u32,
) -> bool {
    if let Some(v) = args.instant_redeem_budget_usdc {
        if v > cur_budget {
            return false;
        }
    }
    if let Some(v) = args.instant_redeem_window_seconds {
        if v < cur_window {
            return false;
        }
    }
    if let Some(v) = args.large_redeem_threshold_usdc {
        if v > cur_threshold {
            return false;
        }
    }
    if let Some(v) = args.redeem_queue_delay_seconds {
        if v < cur_queue_delay {
            return false;
        }
    }
    // The redeem switch. Turning redemptions OFF is the safe direction and stays available
    // instantly; turning them ON is the single largest loosening this program has, because it
    // opens the only user-facing path that pays out treasury cash. It must cost the 24h delay
    // and the guardian-cancel window.
    //
    // Note the asymmetry with the current value: this is a PURE directional check and does
    // not compare against `config.redemptions_enabled`. Proposing Some(false) while already
    // disabled is a harmless no-op tighten, which is the same tolerance the numeric fields
    // above have.
    if args.redemptions_enabled == Some(true) {
        return false;
    }
    true
}

/// Fat-finger CEILINGS for the redeem throttles, mirroring the bounds the
/// (removed) individual instant setters enforced. Applied on the instant tighten
/// path AND on both sides of the timelocked path (propose pre-validates, execute
/// binds). `large_redeem_threshold_usdc` has no ceiling (0 = force ALL to the
/// queue; the rolling-window budget is the real protection regardless).
pub fn validate_redeem_limits_ceilings(args: &RedeemLimitsArgs) -> Result<()> {
    if let Some(v) = args.instant_redeem_budget_usdc {
        require!(
            v <= INSTANT_BUDGET_CEILING_USDC,
            DominionError::AboveMaximum
        );
    }
    if let Some(v) = args.instant_redeem_window_seconds {
        require!(
            v >= INSTANT_WINDOW_MIN_SECONDS && v <= INSTANT_WINDOW_MAX_SECONDS,
            DominionError::AboveMaximum
        );
    }
    if let Some(v) = args.redeem_queue_delay_seconds {
        // DOM-006 (P1): both bounds, mirroring instant_redeem_window_seconds
        // above. The missing floor let the timelocked loosen path set 0, making a
        // queued request claimable in the same slot, and the queued path has no
        // volume accounting to fall back on. See REDEEM_QUEUE_DELAY_MIN_SECONDS.
        require!(
            v >= REDEEM_QUEUE_DELAY_MIN_SECONDS,
            DominionError::QueueDelayTooShort
        );
        require!(
            v <= REDEEM_QUEUE_DELAY_MAX_SECONDS,
            DominionError::AboveMaximum
        );
    }
    Ok(())
}

// === Execute SetRedeemLimits (FIX A loosen path) ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteRedeemLimits<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_redeem_limits_handler(
    ctx: Context<ExecuteRedeemLimits>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetRedeemLimits as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let args = RedeemLimitsArgs::try_from_slice(&tl.action_data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;

    // Binding re-validation of the fat-finger CEILINGS at execute (defense in
    // depth vs propose). Direction is intentionally NOT re-checked here: a value
    // that was a loosen at propose may be a no-op or even a tighten by execute if
    // an instant `emergency_tighten_redeem_limits` ran during the 24h window;
    // re-checking direction would then spuriously fail a legitimately queued
    // loosen. The whole point of this path is that a loosen is allowed - after
    // the 24h delay + guardian-cancel window. (CORRECTION-2.)
    validate_redeem_limits_ceilings(&args)?;

    if let Some(v) = args.instant_redeem_budget_usdc {
        config.instant_redeem_budget_usdc = v;
    }
    if let Some(v) = args.instant_redeem_window_seconds {
        config.instant_redeem_window_seconds = v;
    }
    if let Some(v) = args.large_redeem_threshold_usdc {
        config.large_redeem_threshold_usdc = v;
    }
    if let Some(v) = args.redeem_queue_delay_seconds {
        config.redeem_queue_delay_seconds = v;
    }
    if let Some(v) = args.redemptions_enabled {
        let old_enabled = config.redemptions_enabled;
        config.redemptions_enabled = v;
        // Same event the instant FALSE-only setter emits (SolidProof LOW #3), so a monitor
        // watching for the redeem switch changing state sees BOTH paths and does not have to
        // know which instruction moved it.
        emit!(crate::events::RedemptionsEnabledChanged {
            old_enabled,
            new_enabled: v,
            by: ctx.accounts.admin.key(),
        });
    }

    // NO auto-pause (unlike oracle-guards / pyth-feed / compliance). Those affect
    // the PRICE and must never go live silently after the window; the redeem
    // throttles are rate-limits, and a deliberate loosen already paid the 24h
    // delay + guardian-cancel cost. (Head-dev FIX A: "recommend NO here".)

    config.pending_redeem_limits_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === P2-05: per-field metadata args (Option<String> + bounds) ===
// `None` for a field means "leave it unchanged" (the execute path skips the
// CPI for that field, so it cannot be blanked). A provided field must be
// non-empty (blanking is rejected outright) and within its size cap. Shared
// by propose (pre-validate, fail fast) and execute (binding re-validate,
// defense in depth - mirrors every other timelocked action).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct MetadataArgs {
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub uri: Option<String>,
}

pub fn validate_metadata_args(args: &MetadataArgs) -> Result<()> {
    require!(
        args.name.is_some() || args.symbol.is_some() || args.uri.is_some(),
        DominionError::MetadataNoFields
    );
    if let Some(v) = &args.name {
        require!(!v.is_empty(), DominionError::MetadataFieldEmpty);
        require!(
            v.len() <= METADATA_NAME_MAX,
            DominionError::MetadataFieldTooLong
        );
    }
    if let Some(v) = &args.symbol {
        require!(!v.is_empty(), DominionError::MetadataFieldEmpty);
        require!(
            v.len() <= METADATA_SYMBOL_MAX,
            DominionError::MetadataFieldTooLong
        );
    }
    if let Some(v) = &args.uri {
        require!(!v.is_empty(), DominionError::MetadataFieldEmpty);
        require!(
            v.len() <= METADATA_URI_MAX,
            DominionError::MetadataFieldTooLong
        );
    }
    Ok(())
}

// === Execute SetTreasuryFloat (Option B D7: replaces SetTreasuryMinReserve) ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteTreasuryFloat<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_treasury_min_float_handler(
    ctx: Context<ExecuteTreasuryFloat>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetTreasuryFloat as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let new_float_usdc = decode_u64(&tl.action_data)?;
    // Defense in depth: re-validate the fat-finger ceiling at execute too
    // (covers stale proposals + any future propose-side relaxation). No lower
    // bound: 0 is valid per D7 (Mark sets the float from the panel).
    require!(
        new_float_usdc <= TREASURY_FLOAT_CEILING_USDC,
        DominionError::AboveMaximum
    );
    config.treasury_min_float_usdc = new_float_usdc;
    config.pending_treasury_float_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === Execute SetAdminTimelock ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteAdminTimelock<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_admin_timelock_handler(
    ctx: Context<ExecuteAdminTimelock>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetAdminTimelock as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    // SolidProof INFORMATIONAL #9: this sliced action_data[..4] with no prior length
    // check, unlike every sibling execute handler. Not reachable today (the propose
    // path always writes exactly 4 bytes, the account is program-owned and its type
    // is bound by the discriminant plus the nonce check), but an unchecked slice
    // PANICS rather than returning the mapped error below, so the map_err was
    // unreachable defence. Made uniform with the other handlers.
    require!(
        tl.action_data.len() >= 4,
        DominionError::MalformedActionData
    );
    let new_seconds = u32::from_le_bytes(
        tl.action_data[..4]
            .try_into()
            .map_err(|_| error!(DominionError::MalformedActionData))?,
    );
    require!(
        new_seconds >= ADMIN_TIMELOCK_MIN_SECONDS,
        DominionError::TimelockTooShort
    );
    require!(
        new_seconds <= ADMIN_TIMELOCK_MAX_SECONDS,
        DominionError::TimelockTooLong
    );

    config.admin_timelock_seconds = new_seconds;
    config.pending_admin_timelock_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === Execute SetPublicMint ===
// Applies the timelocked OPENING of the public mint path ("mint at launch").

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecutePublicMint<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_public_mint_handler(ctx: Context<ExecutePublicMint>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetPublicMint as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    require!(
        !tl.action_data.is_empty(),
        DominionError::MalformedActionData
    );
    let new_value = tl.action_data[0] != 0;
    // Re-validated at execute, not only at propose (defence in depth, and the same
    // shape as every other execute handler here): only OPENING is reachable through
    // the timelock, and it must still be a real change.
    require!(new_value, DominionError::PublicMintOpenRequiresTimelock);
    require!(
        new_value != config.public_mint_enabled,
        DominionError::PublicMintUnchanged
    );

    config.public_mint_enabled = new_value;

    config.pending_public_mint_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(PublicMintEnabledChanged {
        old_enabled: !new_value,
        new_enabled: new_value,
        by: ctx.accounts.admin.key(),
    });
    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === Execute SetPythFeed (auto-pause on execute) ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecutePythFeed<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn execute_set_pyth_feed_handler(ctx: Context<ExecutePythFeed>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetPythFeed as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    require!(
        tl.action_data.len() >= 4,
        DominionError::MalformedActionData
    );
    let new_feed_id = u32::from_le_bytes(
        tl.action_data[..4]
            .try_into()
            .map_err(|_| error!(DominionError::MalformedActionData))?,
    );
    // Binding re-validation at execute (defense in depth vs propose). The Lazer
    // program is a compile-time constant, so only the numeric feed id moves.
    require!(new_feed_id != 0, DominionError::InvalidFeedId);

    config.pyth_lazer_feed_id = new_feed_id;

    // Atomic auto-pause (idempotent if already paused).
    if !config.paused {
        config.paused = true;
        emit!(Paused {
            by: ctx.accounts.admin.key(),
            timestamp: now,
        });
    }

    config.pending_pyth_feed_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === Execute UpdateMetadata ===
// Updates the on-chain TokenMetadata extension on the SILV mint via Token-2022 metadata-interface CPI.
// The program PDA `silv_metadata_authority` signs.

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteUpdateMetadata<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
    #[account(
        mut, close = rent_recipient,
        seeds = [TIMELOCK_SEED, &nonce.to_le_bytes()], bump,
        constraint = !timelock.cancelled @ DominionError::TimelockActionCancelled,
        constraint = timelock.executed_at.is_none() @ DominionError::TimelockActionAlreadyExecuted,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    /// CHECK: rent recipient.
    #[account(mut, address = timelock.rent_payer)]
    pub rent_recipient: AccountInfo<'info>,

    #[account(mut, address = config.silv_mint)]
    pub silv_mint: InterfaceAccount<'info, InterfaceMint>,

    /// CHECK: PDA-derived metadata authority.
    #[account(seeds = [SILV_METADATA_AUTHORITY_SEED], bump)]
    pub metadata_authority: AccountInfo<'info>,

    #[account(address = config.token_2022_program)]
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn execute_update_metadata_handler(
    ctx: Context<ExecuteUpdateMetadata>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::UpdateMetadata as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    // P2-05: decode the per-field args. `None` = leave unchanged (no CPI for
    // that field, so it CANNOT be blanked). Re-validate the bounds at execute
    // (binding; mirrors every other timelocked action - a stale over-long or
    // now-empty proposal must still be rejected here, not just at propose).
    let args = MetadataArgs::try_from_slice(&tl.action_data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;
    validate_metadata_args(&args)?;

    // Token-2022 metadata interface CPI: spl_token_metadata_interface::update_field.
    let bump = ctx.bumps.metadata_authority;
    let seeds: &[&[u8]] = &[SILV_METADATA_AUTHORITY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let cpi_accounts = [
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.metadata_authority.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
    ];

    if let Some(name) = &args.name {
        update_metadata_field(
            ctx.accounts.token_2022_program.key(),
            ctx.accounts.silv_mint.key(),
            ctx.accounts.metadata_authority.key(),
            spl_token_metadata_interface::state::Field::Name,
            name.clone(),
            &cpi_accounts,
            signer_seeds,
        )?;
    }
    if let Some(symbol) = &args.symbol {
        update_metadata_field(
            ctx.accounts.token_2022_program.key(),
            ctx.accounts.silv_mint.key(),
            ctx.accounts.metadata_authority.key(),
            spl_token_metadata_interface::state::Field::Symbol,
            symbol.clone(),
            &cpi_accounts,
            signer_seeds,
        )?;
    }
    if let Some(uri) = &args.uri {
        update_metadata_field(
            ctx.accounts.token_2022_program.key(),
            ctx.accounts.silv_mint.key(),
            ctx.accounts.metadata_authority.key(),
            spl_token_metadata_interface::state::Field::Uri,
            uri.clone(),
            &cpi_accounts,
            signer_seeds,
        )?;
    }

    config.pending_metadata_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(MetadataUpdated {
        new_name: args.name,
        new_symbol: args.symbol,
        new_uri: args.uri,
    });
    emit!(AdminActionExecuted {
        nonce,
        action_disc: tl.action_disc,
        executor: ctx.accounts.admin.key(),
    });
    Ok(())
}

fn update_metadata_field(
    program_id: Pubkey,
    metadata: Pubkey,
    update_authority: Pubkey,
    field: spl_token_metadata_interface::state::Field,
    value: String,
    accounts: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = spl_token_metadata_interface::instruction::update_field(
        &program_id,
        &metadata,
        &update_authority,
        field,
        value,
    );
    anchor_lang::solana_program::program::invoke_signed(&ix, accounts, signer_seeds)
        .map_err(Into::into)
}

fn decode_u16(data: &[u8]) -> Result<u16> {
    require!(data.len() >= 2, DominionError::MalformedActionData);
    Ok(u16::from_le_bytes([data[0], data[1]]))
}

fn decode_u64(data: &[u8]) -> Result<u64> {
    require!(data.len() >= 8, DominionError::MalformedActionData);
    Ok(u64::from_le_bytes(
        data[..8]
            .try_into()
            .map_err(|_| error!(DominionError::MalformedActionData))?,
    ))
}

#[cfg(test)]
mod fix_a_tests {
    // Pure directional logic for the instant tighten path (FIX A). The
    // integration behavior (propose->wait->execute, guardian-cancel, single-active
    // nonce) is covered by the litesvm + TS e2e in the off-chain batch; these host
    // tests pin the direction rules, which are the error-prone core (esp. the
    // counter-intuitive window direction).
    use super::{
        redeem_limits_all_tighten, redeem_limits_any_set, redeem_limits_effective_change,
        validate_redeem_limits_ceilings, RedeemLimitsArgs,
    };
    use crate::state::{
        DEFAULT_REDEEM_QUEUE_DELAY_SECONDS, REDEEM_QUEUE_DELAY_MAX_SECONDS,
        REDEEM_QUEUE_DELAY_MIN_SECONDS,
    };

    // Baseline current config for the checks below.
    const CUR_BUDGET: u64 = 20_000_000_000; // $20k
    const CUR_WINDOW: u32 = 86_400; // 24h
    const CUR_THRESHOLD: u64 = 5_000_000_000; // $5k
    const CUR_DELAY: u32 = 259_200; // T+3d

    fn tighten(args: &RedeemLimitsArgs) -> bool {
        redeem_limits_all_tighten(args, CUR_BUDGET, CUR_WINDOW, CUR_THRESHOLD, CUR_DELAY)
    }

    #[test]
    fn none_fields_is_no_op_and_trivially_tighten() {
        let a = RedeemLimitsArgs::default();
        assert!(!redeem_limits_any_set(&a));
        assert!(tighten(&a)); // vacuously safe
    }

    #[test]
    fn lowering_budget_is_tighten_raising_is_loosen() {
        let lower = RedeemLimitsArgs {
            instant_redeem_budget_usdc: Some(CUR_BUDGET - 1),
            ..Default::default()
        };
        let equal = RedeemLimitsArgs {
            instant_redeem_budget_usdc: Some(CUR_BUDGET),
            ..Default::default()
        };
        let higher = RedeemLimitsArgs {
            instant_redeem_budget_usdc: Some(CUR_BUDGET + 1),
            ..Default::default()
        };
        assert!(tighten(&lower));
        assert!(tighten(&equal)); // equal = no change = safe
        assert!(!tighten(&higher)); // raising drain capacity = loosen
    }

    #[test]
    fn window_direction_is_inverted_lengthen_is_tighten() {
        // The footgun: LONGER window = safer (lower drain rate). Shortening is the
        // loosen that must route through the timelock.
        let longer = RedeemLimitsArgs {
            instant_redeem_window_seconds: Some(CUR_WINDOW + 1),
            ..Default::default()
        };
        let shorter = RedeemLimitsArgs {
            instant_redeem_window_seconds: Some(CUR_WINDOW - 1),
            ..Default::default()
        };
        assert!(tighten(&longer));
        assert!(!tighten(&shorter));
    }

    #[test]
    fn lowering_threshold_is_tighten_raising_is_loosen() {
        // Lower threshold => MORE redemptions forced to the slow T+3 queue = safer.
        let lower = RedeemLimitsArgs {
            large_redeem_threshold_usdc: Some(CUR_THRESHOLD - 1),
            ..Default::default()
        };
        let higher = RedeemLimitsArgs {
            large_redeem_threshold_usdc: Some(CUR_THRESHOLD + 1),
            ..Default::default()
        };
        assert!(tighten(&lower));
        assert!(!tighten(&higher));
    }

    #[test]
    fn lengthening_queue_delay_is_tighten_shortening_is_loosen() {
        let longer = RedeemLimitsArgs {
            redeem_queue_delay_seconds: Some(CUR_DELAY + 1),
            ..Default::default()
        };
        let shorter = RedeemLimitsArgs {
            redeem_queue_delay_seconds: Some(CUR_DELAY - 1),
            ..Default::default()
        };
        assert!(tighten(&longer));
        assert!(!tighten(&shorter));
    }

    #[test]
    fn any_single_loosen_field_fails_the_whole_batch() {
        // budget tighten + window loosen (shorten) => the whole call is a loosen.
        let mixed = RedeemLimitsArgs {
            instant_redeem_budget_usdc: Some(CUR_BUDGET - 1),
            instant_redeem_window_seconds: Some(CUR_WINDOW - 1),
            ..Default::default()
        };
        assert!(redeem_limits_any_set(&mixed));
        assert!(!tighten(&mixed));
    }

    // --- DOM-006 (audit wave 0): the queue-delay floor. ---

    fn delay(v: u32) -> RedeemLimitsArgs {
        RedeemLimitsArgs {
            redeem_queue_delay_seconds: Some(v),
            ..Default::default()
        }
    }

    #[test]
    fn queue_delay_zero_is_rejected() {
        // The exact case the audit found: delay 0 makes a queued request
        // claimable in the same slot, and the queued path has no volume budget.
        assert!(validate_redeem_limits_ceilings(&delay(0)).is_err());
    }

    #[test]
    fn queue_delay_below_the_hard_floor_is_rejected() {
        assert!(
            validate_redeem_limits_ceilings(&delay(REDEEM_QUEUE_DELAY_MIN_SECONDS - 1)).is_err()
        );
        assert!(validate_redeem_limits_ceilings(&delay(1)).is_err());
    }

    #[test]
    fn queue_delay_at_and_above_the_floor_is_accepted() {
        assert!(validate_redeem_limits_ceilings(&delay(REDEEM_QUEUE_DELAY_MIN_SECONDS)).is_ok());
        assert!(validate_redeem_limits_ceilings(&delay(REDEEM_QUEUE_DELAY_MAX_SECONDS)).is_ok());
    }

    #[test]
    fn queue_delay_above_the_ceiling_is_still_rejected() {
        // Regression guard: adding the floor must not have dropped the ceiling.
        assert!(
            validate_redeem_limits_ceilings(&delay(REDEEM_QUEUE_DELAY_MAX_SECONDS + 1)).is_err()
        );
    }

    #[test]
    fn the_shipped_default_delay_satisfies_the_new_floor() {
        // Proves the new floor cannot brick a fresh deploy or an existing config.
        assert!(DEFAULT_REDEEM_QUEUE_DELAY_SECONDS >= REDEEM_QUEUE_DELAY_MIN_SECONDS);
        assert!(
            validate_redeem_limits_ceilings(&delay(DEFAULT_REDEEM_QUEUE_DELAY_SECONDS)).is_ok()
        );
    }

    #[test]
    fn all_fields_tightening_together_passes() {
        let all = RedeemLimitsArgs {
            instant_redeem_budget_usdc: Some(CUR_BUDGET - 1),
            instant_redeem_window_seconds: Some(CUR_WINDOW + 1),
            large_redeem_threshold_usdc: Some(CUR_THRESHOLD - 1),
            redeem_queue_delay_seconds: Some(CUR_DELAY + 1),
            // Disabling redemptions is the SAFE direction, so it belongs on the instant path.
            redemptions_enabled: Some(false),
        };
        assert!(tighten(&all));
    }

    // -----------------------------------------------------------------
    // The redeem switch (Thomas, 2026-08-05). Enabling redemptions rides this action so it
    // inherits the 24h delay, the guardian-cancel window and the single-active-nonce guard.
    // -----------------------------------------------------------------

    #[test]
    fn enabling_redemptions_is_a_loosening_and_is_refused_instantly() {
        // THE test for this feature. If it ever passes, `emergency_tighten_redeem_limits`
        // becomes a one-transaction way to open the only path that pays out treasury cash,
        // defeating the entire reason the switch was blocked in the bytecode until now.
        let open = RedeemLimitsArgs {
            redemptions_enabled: Some(true),
            ..Default::default()
        };
        assert!(!tighten(&open));
    }

    #[test]
    fn disabling_redemptions_stays_available_on_the_instant_path() {
        let close = RedeemLimitsArgs {
            redemptions_enabled: Some(false),
            ..Default::default()
        };
        assert!(tighten(&close));
    }

    #[test]
    fn enabling_redemptions_poisons_an_otherwise_all_tighten_batch() {
        // A caller must not be able to smuggle the loosening through by bundling it with
        // genuine tightenings.
        let mixed = RedeemLimitsArgs {
            instant_redeem_budget_usdc: Some(CUR_BUDGET - 1),
            instant_redeem_window_seconds: Some(CUR_WINDOW + 1),
            redemptions_enabled: Some(true),
            ..Default::default()
        };
        assert!(!tighten(&mixed));
    }

    #[test]
    fn any_set_counts_the_redeem_switch_as_a_provided_field() {
        // RENAMED. The version that shipped was called
        // `the_redeem_switch_alone_is_not_a_no_op_proposal` and its comment claimed it protected
        // `propose_set_redeem_limits`. It did not: it asserts `redeem_limits_any_set`, which is a
        // DIFFERENT gate. The propose path has its own comparison, that one was missing the
        // switch, and opening redemptions was therefore unreachable in the deployed program while
        // this test passed. A test whose name overstates its reach is worse than no test.
        let only_switch = RedeemLimitsArgs {
            redemptions_enabled: Some(true),
            ..Default::default()
        };
        assert!(redeem_limits_any_set(&only_switch));

        let nothing = RedeemLimitsArgs::default();
        assert!(!redeem_limits_any_set(&nothing));
    }

    // -----------------------------------------------------------------
    // The SECOND gate: redeem_limits_effective_change, which is what propose actually calls.
    // These are the tests that were missing.
    // -----------------------------------------------------------------

    fn changed(args: &RedeemLimitsArgs, cur_enabled: bool) -> bool {
        redeem_limits_effective_change(
            args,
            CUR_BUDGET,
            CUR_WINDOW,
            CUR_THRESHOLD,
            CUR_DELAY,
            cur_enabled,
        )
    }

    #[test]
    fn opening_redemptions_from_closed_IS_an_effective_change() {
        // THE regression test for the P0. If this fails, `propose_set_redeem_limits` rejects the
        // only proposal shape that can open redemptions, and there is no other path: the instant
        // setter refuses `true` in bytecode and the emergency tighten path refuses Some(true).
        let open = RedeemLimitsArgs {
            redemptions_enabled: Some(true),
            ..Default::default()
        };
        assert!(
            changed(&open, false),
            "a switch-only proposal to OPEN redemptions must be a real change; if it is not, \
             redemptions can never be opened"
        );
    }

    #[test]
    fn closing_redemptions_from_open_is_an_effective_change() {
        let close = RedeemLimitsArgs {
            redemptions_enabled: Some(false),
            ..Default::default()
        };
        assert!(changed(&close, true));
    }

    #[test]
    fn proposing_the_state_it_is_already_in_is_a_no_op() {
        // The gate's actual purpose: a doomed proposal must not occupy the single
        // redeem-limits slot for a full 24h.
        let already_open = RedeemLimitsArgs {
            redemptions_enabled: Some(true),
            ..Default::default()
        };
        assert!(!changed(&already_open, true));

        let already_closed = RedeemLimitsArgs {
            redemptions_enabled: Some(false),
            ..Default::default()
        };
        assert!(!changed(&already_closed, false));
    }

    #[test]
    fn an_empty_proposal_is_a_no_op_and_every_numeric_field_is_still_compared() {
        assert!(!changed(&RedeemLimitsArgs::default(), false));

        // Every pre-existing field must keep working; the new arm must not have displaced one.
        for args in [
            RedeemLimitsArgs {
                instant_redeem_budget_usdc: Some(CUR_BUDGET + 1),
                ..Default::default()
            },
            RedeemLimitsArgs {
                instant_redeem_window_seconds: Some(CUR_WINDOW + 1),
                ..Default::default()
            },
            RedeemLimitsArgs {
                large_redeem_threshold_usdc: Some(CUR_THRESHOLD + 1),
                ..Default::default()
            },
            RedeemLimitsArgs {
                redeem_queue_delay_seconds: Some(CUR_DELAY + 1),
                ..Default::default()
            },
        ] {
            assert!(changed(&args, false));
        }

        // And each one, set to its CURRENT value, must not count.
        for args in [
            RedeemLimitsArgs {
                instant_redeem_budget_usdc: Some(CUR_BUDGET),
                ..Default::default()
            },
            RedeemLimitsArgs {
                instant_redeem_window_seconds: Some(CUR_WINDOW),
                ..Default::default()
            },
            RedeemLimitsArgs {
                large_redeem_threshold_usdc: Some(CUR_THRESHOLD),
                ..Default::default()
            },
            RedeemLimitsArgs {
                redeem_queue_delay_seconds: Some(CUR_DELAY),
                ..Default::default()
            },
        ] {
            assert!(!changed(&args, false));
        }
    }

    #[test]
    fn the_two_gates_agree_on_the_switch() {
        // The P0 was the two gates DISAGREEING about a field. Assert they now agree, which is the
        // property that was violated, rather than only asserting each one separately.
        let open = RedeemLimitsArgs {
            redemptions_enabled: Some(true),
            ..Default::default()
        };
        assert_eq!(redeem_limits_any_set(&open), changed(&open, false));
    }

    #[test]
    fn the_redeem_switch_has_no_fat_finger_ceiling_to_violate() {
        // A bool cannot be out of range, so the ceiling validator must accept both values
        // rather than accidentally rejecting the field it does not know about.
        for v in [true, false] {
            let args = RedeemLimitsArgs {
                redemptions_enabled: Some(v),
                ..Default::default()
            };
            assert!(validate_redeem_limits_ceilings(&args).is_ok());
        }
    }
}
