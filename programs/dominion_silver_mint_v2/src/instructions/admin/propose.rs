// Timelock propose instructions.
// Common rules per PLAN.md §5.3:
//   - Reverts if same-kind pending_*_nonce already Some (D35 single-active).
//   - Reverts if proposed value matches current config (D36 no-op).
//   - Reverts if active_proposal_count >= 10 (D29 cap).
//   - Allocates nonce from config.next_timelock_nonce, increments tracking.
//   - propose_set_premium_mint additionally sets mint_paused_until = executable_at (D30).
//   - propose_withdraw_usdc may be called even while paused (queueing OK; execute reverts on paused).

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{AdminActionProposed, MintPausedUntilSet};
use crate::instructions::admin::execute::{validate_metadata_args, MetadataArgs, OracleGuardsArgs};
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
    let executable_at = now + config.admin_timelock_seconds as i64;

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

    // D30.
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
    let executable_at = now + config.admin_timelock_seconds as i64;

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
    let executable_at = now + config.admin_timelock_seconds as i64;

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
    let executable_at = now + config.admin_timelock_seconds as i64;

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
            || args.dust_filter_min_usdc.is_some(),
        DominionError::OracleGuardsAllNone
    );

    // CODEX P1-01a: pre-validate the §6 bounds on PROPOSE too (mirrors the
    // execute-side checks). An out-of-bounds proposal is rejected immediately
    // instead of consuming the single-active pending-oracle-guards nonce for
    // 24h only to fail at execute. Execute still re-validates (binding,
    // defense in depth). Keep these in lockstep with execute_set_oracle_guards.
    if let Some(v) = args.staleness {
        require!(v >= 5 && v <= 300, DominionError::AboveMaximum);
    }
    if let Some(v) = args.conf_bps {
        require!(v >= 1 && v <= 1000, DominionError::AboveMaximum);
    }
    if let Some(v) = args.max_delta_bps {
        require!(v >= 1 && v <= 5000, DominionError::AboveMaximum);
    }
    if let Some(v) = args.decay_seconds {
        require!(v >= 60 && v <= 7 * 86400, DominionError::AboveMaximum);
    }
    if let Some(v) = args.dust_filter_min_usdc {
        require!(v <= 1_000_000_000_000, DominionError::AboveMaximum);
    }
    // P1-01b symmetry: a zero upper price bound bricks the oracle sanity
    // check (read_silver_price requires normalized <= max_price). Reject here
    // and at execute. min_price == 0 stays allowed (legitimate "no lower
    // bound" off-switch; normalized is u128 >= 0).
    if let Some(v) = args.max_price_scaled {
        require!(v != 0, DominionError::PriceOutOfBounds);
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
    let executable_at = now + config.admin_timelock_seconds as i64;

    let mut data = Vec::with_capacity(64);
    args.serialize(&mut data)
        .map_err(|_| error!(DominionError::SerializationFailure))?;

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

// === ProposeTreasuryFloat (Option B D7: replaces Option A ProposeMinReserve) ===
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

    // Fat-finger ceiling only (no lower bound: 0 is valid per D7).
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
    let executable_at = now + config.admin_timelock_seconds as i64;

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
    let executable_at = now + config.admin_timelock_seconds as i64;

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
    new_feed_id: [u8; 32],
    new_receiver_program: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;

    require!(new_feed_id != [0u8; 32], DominionError::InvalidFeedId);
    // CODEX P1-02: only the feed id is mutable. The receiver program is
    // hard-pinned to the official Pyth receiver, here (early reject) and again
    // at execute (binding enforcement, defense in depth).
    require!(
        new_receiver_program == PYTH_RECEIVER_OFFICIAL,
        DominionError::WrongPythReceiver
    );
    let unchanged =
        new_feed_id == config.pyth_feed_id && new_receiver_program == config.pyth_receiver_program;
    require!(!unchanged, DominionError::ProposalNoOp);
    require!(
        config.pending_pyth_feed_nonce.is_none(),
        DominionError::ProposalAlreadyActive
    );
    require!(
        config.active_proposal_count < MAX_ACTIVE_PROPOSALS,
        DominionError::TooManyActiveProposals
    );

    let nonce = config.next_timelock_nonce;
    let executable_at = now + config.admin_timelock_seconds as i64;

    let mut data = Vec::with_capacity(64);
    data.extend_from_slice(&new_feed_id);
    data.extend_from_slice(new_receiver_program.as_ref());

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

    // P2-05: at least one field set; each PROVIDED field must be non-empty and
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
    let executable_at = now + config.admin_timelock_seconds as i64;

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
