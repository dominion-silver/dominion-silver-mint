// Timelock propose instructions.
// Common rules for every proposal:
//   - Reverts if same-kind pending_*_nonce already Some (single-active).
//   - Reverts if proposed value matches current config (no-op).
//   - Reverts if active_proposal_count >= 10 (cap).
//   - Allocates nonce from config.next_timelock_nonce, increments tracking.
//   - propose_set_premium_mint additionally sets mint_paused_until = executable_at ().
//   - propose_withdraw_usdc may be called even while paused (queueing OK; execute reverts on paused).

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{AdminActionProposed, MintPausedUntilSet};
use crate::instructions::admin::execute::{
    redeem_limits_any_set, redeem_limits_effective_change, validate_metadata_args,
    validate_redeem_limits_ceilings, MetadataArgs, OracleGuardsArgs, RedeemLimitsArgs,
};
use crate::state::*;

// === ProposePremium (mint or redeem) ===

#[derive(Accounts)]
pub struct ProposePremium<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    pub system_program: Program<'info, System>,
}

pub fn propose_set_premium_mint_handler(ctx: Context<ProposePremium>, new_bps: u16) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(
        new_bps <= PREMIUM_BPS_MINT_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (new_bps as u32) + (config.premium_bps_redeem as u32) >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );
    require!(
        new_bps != config.premium_bps_mint,
        DominionError::ProposalNoOp
    );
    require!(
        config.pending_premium_mint_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetPremiumMint as u8;
    tl.action_data = encode_u16(new_bps);
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_premium_mint_nonce = Some(nonce);

    config.mint_paused_until = executable_at;

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    emit!(MintPausedUntilSet {
        until: executable_at
    });
    Ok(())
}

pub fn propose_set_premium_redeem_handler(
    ctx: Context<ProposePremium>,
    new_bps: u16,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(
        new_bps <= PREMIUM_BPS_REDEEM_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (config.premium_bps_mint as u32) + (new_bps as u32) >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );
    require!(
        new_bps != config.premium_bps_redeem,
        DominionError::ProposalNoOp
    );
    require!(
        config.pending_premium_redeem_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetPremiumRedeem as u8;
    tl.action_data = encode_u16(new_bps);
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_premium_redeem_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeWithdraw ===

#[derive(Accounts)]
pub struct ProposeWithdraw<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    pub system_program: Program<'info, System>,
}

pub fn propose_withdraw_usdc_handler(
    ctx: Context<ProposeWithdraw>,
    amount: u64,
    recipient: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(amount > 0, DominionError::ZeroAmount);
    require!(
        config.pending_withdraw_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let mut data = Vec::with_capacity(40);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(recipient.as_ref());

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::WithdrawUsdc as u8;
    tl.action_data = data;
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_withdraw_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeCompliance ===

#[derive(Accounts)]
pub struct ProposePublicMint<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    pub system_program: Program<'info, System>,
}

/// Propose OPENING the public mint path ("mint at launch", 2026-07-26).
/// Only `true` is proposable here. Closing is instant via
/// `set_public_mint_enabled(false)`, because closing is the emergency direction: if the
/// oracle misbehaves, mint must stop in one transaction, not in 24 hours.
/// Why opening is timelocked at all, given that a public mint takes USDC IN rather than
/// paying it out: it is not a drain vector, but it is a posture change with two real
/// consequences. It wakes the ORACLE path, which is completely dormant while mint and
/// redeem are both closed, so every staleness / confidence / publisher-count guard
/// becomes load-bearing at that instant. And it lets the public consume the supply-cap
/// headroom that backs the pre-minted inventory. Both deserve an announced,
/// guardian-cancellable window.
pub fn propose_set_public_mint_handler(
    ctx: Context<ProposePublicMint>,
    new_value: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(new_value, DominionError::PublicMintOpenRequiresTimelock);
    require!(
        new_value != config.public_mint_enabled,
        DominionError::PublicMintUnchanged
    );
    require!(
        config.pending_public_mint_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetPublicMint as u8;
    tl.action_data = vec![new_value as u8];
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_public_mint_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeInventoryWallet<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    pub system_program: Program<'info, System>,
}

/// Propose CHANGING the pre-mint destination. Round 7, condition 4.
/// The payload is the 32-byte destination pubkey. there is no instant path and no
/// "first binding" here. `initialize` requires a non-zero destination, so the field is never unset
/// and this pair is the ONLY writer after init. No path returns it to `Pubkey::default()`.
pub fn propose_set_inventory_wallet_handler(
    ctx: Context<ProposeInventoryWallet>,
    new_wallet: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(
        new_wallet != Pubkey::default(),
        DominionError::InventoryWalletNotSet
    );
    require!(
        new_wallet != config.inventory_wallet,
        DominionError::InventoryWalletUnchanged
    );
    require!(
        config.pending_inventory_wallet_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetInventoryWallet as u8;
    tl.action_data = new_wallet.to_bytes().to_vec();
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_inventory_wallet_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeCompliance<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,

    pub system_program: Program<'info, System>,
}

pub fn propose_set_compliance_mode_handler(
    ctx: Context<ProposeCompliance>,
    new_value: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(
        new_value != config.compliance_mode,
        DominionError::ComplianceModeUnchanged
    );
    require!(
        config.pending_compliance_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetComplianceMode as u8;
    tl.action_data = vec![new_value as u8];
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_compliance_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeOracleGuards (Option<T> per field) ===

#[derive(Accounts)]
pub struct ProposeOracleGuards<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    pub system_program: Program<'info, System>,
}

pub fn propose_set_oracle_guards_handler(
    ctx: Context<ProposeOracleGuards>,
    args: OracleGuardsArgs,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    // At least one field must be set.
    require!(
        args.staleness.is_some()
            || args.conf_bps.is_some()
            || args.min_price_scaled.is_some()
            || args.max_price_scaled.is_some()
            || args.max_delta_bps.is_some()
            || args.decay_seconds.is_some()
            || args.dust_filter_min_usdc.is_some()
            || args.min_publishers.is_some(),
        DominionError::OracleGuardsAllNone
    );

    // Pre-validate the Tier A structural ceilings on PROPOSE too (mirrors the
    // execute-side checks; execute re-validates, defense in depth). Lazer
    // migration 5.5: these REPLACE the Core-era ranges (staleness was 5..300).
    // Keep in lockstep with execute_set_oracle_guards.
    if let Some(v) = args.staleness {
        require!(
            v >= 5 && v <= MAX_STALENESS_CEILING_SECONDS,
            DominionError::AboveMaximum
        );
    }
    if let Some(v) = args.conf_bps {
        require!(
            v >= 1 && v <= MAX_CONFIDENCE_BPS_CEILING,
            DominionError::AboveMaximum
        );
    }
    if let Some(v) = args.max_delta_bps {
        require!(
            v >= 1 && v <= MAX_PRICE_DELTA_BPS_CEILING,
            DominionError::AboveMaximum
        );
    }
    if let Some(v) = args.decay_seconds {
        require!(v >= 60 && v <= 7 * 86400, DominionError::AboveMaximum);
    }
    if let Some(v) = args.dust_filter_min_usdc {
        require!(v <= 1_000_000_000_000, DominionError::AboveMaximum);
    }
    if let Some(v) = args.min_publishers {
        // The Tier A hard floor cannot be undercut; the operating value (Tier
        // B, set from live data) sits at or above it.
        require!(
            v >= crate::lazer_price::MIN_PUBLISHERS_FLOOR_HARD,
            DominionError::LazerTooFewPublishers
        );
    }
    // Fat-finger rails on the price band (Lazer 5.5): both settings bounded by
    // the absolute ceiling; max != 0 (a zero upper bound bricks the sanity
    // check). min == 0 stays allowed (legitimate "no lower bound"); the
    // cross-field min < max is enforced at execute.
    if let Some(v) = args.max_price_scaled {
        require!(
            v != 0 && v <= PRICE_FATFINGER_MAX_SCALED,
            DominionError::PriceOutOfBounds
        );
    }
    if let Some(v) = args.min_price_scaled {
        // 0 = lower-bound off-switch; otherwise within the fat-finger band.
        require!(
            v == 0 || (v >= PRICE_FATFINGER_MIN_SCALED && v <= PRICE_FATFINGER_MAX_SCALED),
            DominionError::PriceOutOfBounds
        );
    }
    // Cross-field (Fable audit P3-e): resolve the effective band (the arg if
    // Some, else the current config) and reject min >= max at PROPOSE too, so a
    // doomed proposal cannot occupy the single oracle-guards slot for the full
    // timelock. Execute re-checks against the applied values (defense in depth).
    {
        let eff_min = args.min_price_scaled.unwrap_or(config.min_price_usd_scaled);
        let eff_max = args.max_price_scaled.unwrap_or(config.max_price_usd_scaled);
        require!(
            eff_min == 0 || eff_min < eff_max,
            DominionError::PriceOutOfBounds
        );
    }

    // Reject pure no-op (every Some matches current value).
    let mut effective_change = false;
    if let Some(v) = args.staleness {
        if v != config.max_staleness_seconds {
            effective_change = true;
        }
    }
    if let Some(v) = args.conf_bps {
        if v != config.max_confidence_bps {
            effective_change = true;
        }
    }
    if let Some(v) = args.min_price_scaled {
        if v != config.min_price_usd_scaled {
            effective_change = true;
        }
    }
    if let Some(v) = args.max_price_scaled {
        if v != config.max_price_usd_scaled {
            effective_change = true;
        }
    }
    if let Some(v) = args.max_delta_bps {
        if v != config.max_price_delta_bps {
            effective_change = true;
        }
    }
    if let Some(v) = args.decay_seconds {
        if v != config.price_delta_decay_seconds {
            effective_change = true;
        }
    }
    if let Some(v) = args.dust_filter_min_usdc {
        if v != config.price_update_min_amount_usdc {
            effective_change = true;
        }
    }
    if let Some(v) = args.min_publishers {
        if v != config.min_publishers {
            effective_change = true;
        }
    }
    require!(effective_change, DominionError::ProposalNoOp);

    require!(
        config.pending_oracle_guards_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let mut data = Vec::with_capacity(TimelockQueueAccount::MAX_ACTION_DATA_BYTES);
    args.serialize(&mut data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;
    // Defense in depth (Fable audit P3-d): an action_data write beyond the
    // account budget would corrupt the timelock account. The worst-case borsh
    // of OracleGuardsArgs (~46 B) is far under the cap, but guard it explicitly
    // for parity with propose_update_metadata.
    require!(
        data.len() <= TimelockQueueAccount::MAX_ACTION_DATA_BYTES,
        DominionError::MalformedActionData
    );

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetOracleGuards as u8;
    tl.action_data = data;
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_oracle_guards_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeRedeemLimits (FIX A loosen path, Option<T> per field) ===
// The 24h-timelocked path to change any of the four redeem throttles in ANY
// direction (in practice: to LOOSEN them; instant tightening is the separate
// emergency_tighten_redeem_limits). Mirrors ProposeOracleGuards exactly.

#[derive(Accounts)]
pub struct ProposeRedeemLimits<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    pub system_program: Program<'info, System>,
}

pub fn propose_set_redeem_limits_handler(
    ctx: Context<ProposeRedeemLimits>,
    args: RedeemLimitsArgs,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    // At least one field must be set.
    require!(
        redeem_limits_any_set(&args),
        DominionError::RedeemLimitsAllNone
    );

    // Pre-validate the fat-finger ceilings on PROPOSE too (execute re-validates,
    // defense in depth). Direction is intentionally NOT checked: this path exists
    // precisely to allow a loosen, gated by the 24h delay + guardian cancel.
    validate_redeem_limits_ceilings(&args)?;

    // Reject pure no-op (every provided field already equals current) so a doomed
    // proposal cannot occupy the single redeem-limits slot for the full timelock.
    // Was an inline block per field. Extracted to a pure, unit-tested function in execute.rs
    // after it shipped MISSING the `redemptions_enabled` arm, which made opening redemptions
    // unreachable in the deployed program: a switch-only proposal passed
    // `redeem_limits_any_set`, passed the ceilings, and died here on ProposalNoOp, while
    // `set_redemptions_enabled(true)` is refused in bytecode and `emergency_tighten_redeem_limits`
    // refuses Some(true). No path left to the one action the batch exists to enable.
    // Two independent no-op gates guard this action and a new field has to be added to BOTH.
    // They now live side by side in execute.rs so that is hard to miss.
    require!(
        redeem_limits_effective_change(
            &args,
            config.instant_redeem_budget_usdc,
            config.instant_redeem_window_seconds,
            config.large_redeem_threshold_usdc,
            config.redeem_queue_delay_seconds,
            config.redemptions_enabled,
        ),
        DominionError::ProposalNoOp
    );

    require!(
        config.pending_redeem_limits_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let mut data = Vec::with_capacity(TimelockQueueAccount::MAX_ACTION_DATA_BYTES);
    args.serialize(&mut data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;
    // Worst-case borsh of RedeemLimitsArgs is 4*(1+8) = 36 B, far under the cap;
    // guard explicitly for parity with the other Option<T>-payload proposals.
    require!(
        data.len() <= TimelockQueueAccount::MAX_ACTION_DATA_BYTES,
        DominionError::MalformedActionData
    );

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetRedeemLimits as u8;
    tl.action_data = data;
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_redeem_limits_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeTreasuryFloat (Option B : replaces Option A ProposeMinReserve) ===
// Sets treasury_min_float_usdc, the minimum USDC the admin must leave in the
// treasury on withdraw (option a: blocks ADMIN withdraw only; redemptions can
// still draw below it, then route OTC). 24h-timelocked. There is NO lower
// floor: 0 is a valid value (Mark sets it from the panel; default 0). The
// upper bound is the fat-finger ceiling.

#[derive(Accounts)]
pub struct ProposeTreasuryFloat<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    pub system_program: Program<'info, System>,
}

pub fn propose_set_treasury_min_float_handler(
    ctx: Context<ProposeTreasuryFloat>,
    new_float_usdc: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    // Fat-finger ceiling only (no lower bound: 0 is valid per ).
    require!(
        new_float_usdc <= TREASURY_FLOAT_CEILING_USDC,
        DominionError::AboveMaximum
    );
    require!(
        new_float_usdc != config.treasury_min_float_usdc,
        DominionError::ProposalNoOp
    );
    require!(
        config.pending_treasury_float_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetTreasuryFloat as u8;
    tl.action_data = new_float_usdc.to_le_bytes().to_vec();
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_treasury_float_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeAdminTimelock ===

#[derive(Accounts)]
pub struct ProposeAdminTimelock<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    pub system_program: Program<'info, System>,
}

pub fn propose_set_admin_timelock_handler(
    ctx: Context<ProposeAdminTimelock>,
    new_seconds: u32,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(
        new_seconds >= ADMIN_TIMELOCK_MIN_SECONDS,
        DominionError::TimelockTooShort
    );
    require!(
        new_seconds <= ADMIN_TIMELOCK_MAX_SECONDS,
        DominionError::TimelockTooLong
    );
    require!(
        new_seconds != config.admin_timelock_seconds,
        DominionError::ProposalNoOp
    );
    require!(
        config.pending_admin_timelock_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetAdminTimelock as u8;
    tl.action_data = new_seconds.to_le_bytes().to_vec();
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_admin_timelock_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposePythFeed ===

#[derive(Accounts)]
pub struct ProposePythFeed<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    pub system_program: Program<'info, System>,
}

pub fn propose_set_pyth_feed_handler(
    ctx: Context<ProposePythFeed>,
    new_lazer_feed_id: u32,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    // Pyth Lazer migration: only the numeric feed id is mutable; the Lazer
    // program is a compile-time constant (lazer_cpi.rs), so there is no
    // receiver to pin here anymore.
    require!(new_lazer_feed_id != 0, DominionError::InvalidFeedId);
    require!(
        new_lazer_feed_id != config.pyth_lazer_feed_id,
        DominionError::ProposalNoOp
    );
    require!(
        config.pending_pyth_feed_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let mut data = Vec::with_capacity(4);
    data.extend_from_slice(&new_lazer_feed_id.to_le_bytes());

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::SetPythFeed as u8;
    tl.action_data = data;
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_pyth_feed_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// === ProposeUpdateMetadata ===

#[derive(Accounts)]
pub struct ProposeUpdateMetadata<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = TimelockQueueAccount::SIZE,
        seeds = [TIMELOCK_SEED, &config.next_timelock_nonce.to_le_bytes()],
        bump,
    )]
    pub timelock: Account<'info, TimelockQueueAccount>,
    pub system_program: Program<'info, System>,
}

pub fn propose_update_metadata_handler(
    ctx: Context<ProposeUpdateMetadata>,
    name: Option<String>,
    symbol: Option<String>,
    uri: Option<String>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    // at least one field set; each PROVIDED field must be non-empty and
    // within its cap. Blanking (Some("")) is rejected outright; "leave this
    // field unchanged" is expressed as None (execute skips its CPI). The exact
    // same validation runs again at execute (binding, defense in depth).
    let args = MetadataArgs { name, symbol, uri };
    validate_metadata_args(&args)?;

    require!(
        config.pending_metadata_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now
        .checked_add(config.admin_timelock_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let mut data = Vec::with_capacity(TimelockQueueAccount::MAX_ACTION_DATA_BYTES);
    args.serialize(&mut data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;
    // Defense in depth: the per-field caps already guarantee this fits, but a
    // write that exceeds the account's action_data budget would corrupt the
    // timelock account, so reject it explicitly with a clear error.
    require!(
        data.len() <= TimelockQueueAccount::MAX_ACTION_DATA_BYTES,
        DominionError::MetadataFieldTooLong
    );

    let tl = &mut ctx.accounts.timelock;
    tl.nonce = nonce;
    tl.action_disc = TimelockAction::UpdateMetadata as u8;
    tl.action_data = data;
    tl.scheduled_at = now;
    tl.executable_at = executable_at;
    tl.executed_at = None;
    tl.cancelled = false;
    tl.proposer = ctx.accounts.admin.key();
    tl.rent_payer = ctx.accounts.admin.key();

    config.next_timelock_nonce = nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.active_proposal_count = config
        .active_proposal_count
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    config.pending_metadata_nonce = Some(nonce);

    emit!(AdminActionProposed {
        nonce,
        action_disc: tl.action_disc,
        executable_at,
        proposer: ctx.accounts.admin.key(),
    });
    Ok(())
}

// helpers

fn encode_u16(v: u16) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}
