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

    // SC-C3: defense-in-depth bounds at execute time. If propose accepts
    // a value (it does today, mostly), this layer rejects out-of-range
    // values so a 24h-window attacker cannot fully disable oracle guards.
    // Bounds chosen to match `dev_set_*` floors/ceilings + sane mainnet
    // operating ranges (PLAN.md §3, §8).
    // CODEX P1-01: bounds aligned to CONFIRMED_SPEC.md §6 (was 5..600 staleness,
    // no conf/delta lower bound). Spec §6: staleness 5..300, conf_bps 1..1000,
    // max_delta_bps 1..5000. The min on conf_bps / max_delta_bps prevents a
    // value of 0 from silently bricking the oracle (conf_bps=0 => only an
    // exactly-zero Pyth confidence passes; max_delta_bps=0 => any price move
    // reverts). decay_seconds / dust_filter are spec-silent: defensive bounds
    // added per D14 so the price-delta breaker cannot be neutered.
    if let Some(v) = g.staleness {
        require!(v >= 5 && v <= 300, DominionError::AboveMaximum);
        config.max_staleness_seconds = v;
    }
    if let Some(v) = g.conf_bps {
        // Spec §6: 1..1000 bps. Min 1 so the oracle cannot be bricked.
        require!(v >= 1 && v <= 1000, DominionError::AboveMaximum);
        config.max_confidence_bps = v;
    }
    if let Some(v) = g.min_price_scaled {
        config.min_price_usd_scaled = v;
    }
    if let Some(v) = g.max_price_scaled {
        config.max_price_usd_scaled = v;
    }
    // CODEX P1-01b: a zero UPPER price bound bricks every oracle read
    // (read_silver_price requires `normalized <= max_price_usd_scaled`; any
    // positive price then reverts). It is NOT a valid "off" sentinel - unlike
    // `min_price == 0`, which legitimately disables the lower bound since
    // `normalized` is u128 >= 0. Forbid max == 0 outright (the old
    // `|| max == 0` escape allowed a 24h-timelocked admin to brick the oracle).
    require!(
        config.max_price_usd_scaled != 0,
        DominionError::PriceOutOfBounds
    );
    // Cross-field: min must be 0 (lower bound off) or strictly below max.
    require!(
        config.min_price_usd_scaled == 0
            || config.min_price_usd_scaled < config.max_price_usd_scaled,
        DominionError::PriceOutOfBounds
    );
    if let Some(v) = g.max_delta_bps {
        // Spec §6: 1..5000 bps. Min 1 so a normal price move cannot brick.
        require!(v >= 1 && v <= 5000, DominionError::AboveMaximum);
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
    // Option B: reserve_price_ramp_bps removed (no reserve-check price).

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
        tl.action_data.len() >= 32 + 32,
        DominionError::MalformedActionData
    );
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&tl.action_data[..32]);
    let receiver = Pubkey::try_from(&tl.action_data[32..64])
        .map_err(|_| error!(DominionError::MalformedActionData))?;
    require!(feed_id != [0u8; 32], DominionError::InvalidFeedId);
    // CODEX P1-02: binding enforcement (defense in depth vs propose). Only the
    // feed id is mutable; the Pyth receiver stays the official program forever,
    // so a compromised/misused admin path cannot swap in a malicious receiver.
    require!(
        receiver == PYTH_RECEIVER_OFFICIAL,
        DominionError::WrongPythReceiver
    );

    config.pyth_feed_id = feed_id;
    config.pyth_receiver_program = receiver;

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
