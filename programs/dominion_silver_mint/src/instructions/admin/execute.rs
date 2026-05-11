// Timelock execute instructions.
// Common rules:
//   - Reverts if now < executable_at (TimelockNotElapsed).
//   - Reverts if cancelled or already executed.
//   - Re-validates args at execute (state may have shifted during the window).
//   - Clears pending_*_nonce, decrements active_proposal_count.
//   - For premium_mint: clears mint_paused_until.
//   - For withdraw: also reverts if paused at execute (D31). Full reserve invariant enforced.
//   - For pyth_feed: atomically sets paused=true (admin must verify + unpause manually).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{Mint as InterfaceMint, Token2022};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::cpi::usdc_transfer_treasury_to_user;
use crate::errors::DominionError;
use crate::events::*;
use crate::math::check_reserve_invariant_post_state;
use crate::oracle::{check_price_delta, read_silver_price, update_reserve_check_price};
use crate::state::*;

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
        new_bps <= PREMIUM_BPS_HARD_CEILING,
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
        new_bps <= PREMIUM_BPS_HARD_CEILING,
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

// === Execute Withdraw (with full reserve check) ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteWithdraw<'info> {
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

    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Account<'info, ClassicMint>,

    #[account(address = config.silv_mint)]
    pub silv_mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(mut, address = config.usdc_treasury)]
    pub usdc_treasury: Account<'info, TokenAccount>,

    /// Recipient USDC ATA. Owner is asserted manually in handler against action_data.recipient.
    /// Anchor `token::authority` constraint cannot reference action_data, so we deserialize
    /// and check manually with a dedicated error.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::token_program = classic_token_program,
    )]
    pub recipient_ata: Account<'info, TokenAccount>,

    /// CHECK: treasury PDA signs.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    // Pyth account refresh: used to update reserve_check_price before invariant check.
    #[account(owner = config.pyth_receiver_program)]
    pub price_update: Account<'info, PriceUpdateV2>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,
}

pub fn execute_withdraw_usdc_handler(ctx: Context<ExecuteWithdraw>, nonce: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

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

    // Refresh reserve_check_price from Pyth.
    // CODEX M-01: apply the same price-delta breaker that user mint/redeem
    // paths use BEFORE updating reserve_check_price. Without this, an admin
    // compromise could wait for an anomalous low Pyth print, ratchet
    // reserve_check_price down (downward updates are instant), then
    // withdraw more USDC in the same tx because the reserve_required term
    // dropped. The breaker rejects > max_price_delta_bps moves vs the last
    // recorded price within the decay window.
    let oracle_price = read_silver_price(&ctx.accounts.price_update, config, &clock)?;
    check_price_delta(config, oracle_price, now)?;
    update_reserve_check_price(config, oracle_price, now)?;

    // Check treasury balance + post-withdraw reserve invariant.
    let treasury_pre = ctx.accounts.usdc_treasury.amount;
    require!(treasury_pre >= amount, DominionError::InsufficientTreasury);
    let treasury_post = treasury_pre - amount;
    let silv_supply = ctx.accounts.silv_mint.supply;
    check_reserve_invariant_post_state(
        treasury_post,
        silv_supply,
        config.reserve_check_price_scaled,
        config.treasury_min_reserve_bps,
    )?;

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
    if let Some(v) = g.staleness {
        require!(v >= 5 && v <= 600, DominionError::AboveMaximum);
        config.max_staleness_seconds = v;
    }
    if let Some(v) = g.conf_bps {
        // 1000 bps = 10% confidence interval is the upper sane bound.
        // Beyond this, the price is essentially noise.
        require!(v <= 1000, DominionError::AboveMaximum);
        config.max_confidence_bps = v;
    }
    if let Some(v) = g.min_price_scaled {
        config.min_price_usd_scaled = v;
    }
    if let Some(v) = g.max_price_scaled {
        config.max_price_usd_scaled = v;
    }
    // Cross-field: post-update min must be < max (or both zero, off).
    require!(
        config.min_price_usd_scaled == 0
            || config.max_price_usd_scaled == 0
            || config.min_price_usd_scaled < config.max_price_usd_scaled,
        DominionError::PriceOutOfBounds
    );
    if let Some(v) = g.max_delta_bps {
        // 5000 bps = 50% per-tx price move is the upper sane bound.
        require!(v <= 5000, DominionError::AboveMaximum);
        config.max_price_delta_bps = v;
    }
    if let Some(v) = g.decay_seconds {
        // 7 days max; longer would mean the breaker basically never re-arms.
        require!(v <= 7 * 86400, DominionError::AboveMaximum);
        config.price_delta_decay_seconds = v;
    }
    if let Some(v) = g.dust_filter_min_usdc {
        config.price_update_min_amount_usdc = v;
    }
    if let Some(v) = g.reserve_price_ramp_bps {
        // 5000 bps/hour upward ramp = 50%/hour is the upper sane bound.
        require!(v <= 5000, DominionError::AboveMaximum);
        config.reserve_check_price_max_increase_per_hour_bps = v;
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
    pub reserve_price_ramp_bps: Option<u16>,
}

// === Execute SetTreasuryMinReserve ===

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ExecuteMinReserve<'info> {
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

pub fn execute_set_treasury_min_reserve_handler(
    ctx: Context<ExecuteMinReserve>,
    nonce: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let tl = &mut ctx.accounts.timelock;
    let now = Clock::get()?.unix_timestamp;

    require!(tl.nonce == nonce, DominionError::NonceMismatch);
    require!(
        tl.action_disc == TimelockAction::SetTreasuryMinReserve as u8,
        DominionError::NonceMismatch
    );
    require!(now >= tl.executable_at, DominionError::TimelockNotElapsed);

    let new_bps = decode_u16(&tl.action_data)?;
    // Defense in depth: re-validate bound even though propose checks it.
    // Protects against: (a) stale pre-fix proposals queued before the
    // propose-side bound was added, (b) future changes to propose that
    // might relax the check.
    require!(new_bps <= 10_000, DominionError::AboveMaximum);
    // CODEX H-03: same lower bound enforced at execute.
    const RESERVE_FLOOR_HARD_MIN_BPS: u16 = 1000;
    require!(
        new_bps >= RESERVE_FLOOR_HARD_MIN_BPS,
        DominionError::ReserveFloorBelowMinimum
    );
    config.treasury_min_reserve_bps = new_bps;
    config.pending_min_reserve_nonce = None;
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

    // Decode (name_len: u32, name, symbol_len: u32, symbol, uri_len: u32, uri).
    let (name, symbol, uri) = decode_metadata(&tl.action_data)?;

    // Build update_field CPIs: name, symbol, uri.
    // Token-2022 metadata interface CPI: spl_token_metadata_interface::instruction::update_field.
    let bump = ctx.bumps.metadata_authority;
    let seeds: &[&[u8]] = &[SILV_METADATA_AUTHORITY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    update_metadata_field(
        ctx.accounts.token_2022_program.key(),
        ctx.accounts.silv_mint.key(),
        ctx.accounts.metadata_authority.key(),
        spl_token_metadata_interface::state::Field::Name,
        name.clone(),
        &[
            ctx.accounts.silv_mint.to_account_info(),
            ctx.accounts.metadata_authority.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
        signer_seeds,
    )?;
    update_metadata_field(
        ctx.accounts.token_2022_program.key(),
        ctx.accounts.silv_mint.key(),
        ctx.accounts.metadata_authority.key(),
        spl_token_metadata_interface::state::Field::Symbol,
        symbol.clone(),
        &[
            ctx.accounts.silv_mint.to_account_info(),
            ctx.accounts.metadata_authority.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
        signer_seeds,
    )?;
    update_metadata_field(
        ctx.accounts.token_2022_program.key(),
        ctx.accounts.silv_mint.key(),
        ctx.accounts.metadata_authority.key(),
        spl_token_metadata_interface::state::Field::Uri,
        uri.clone(),
        &[
            ctx.accounts.silv_mint.to_account_info(),
            ctx.accounts.metadata_authority.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    config.pending_metadata_nonce = None;
    config.active_proposal_count = config.active_proposal_count.saturating_sub(1);
    tl.executed_at = Some(now);

    emit!(MetadataUpdated {
        new_name: name,
        new_symbol: symbol,
        new_uri: uri,
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

fn decode_metadata(data: &[u8]) -> Result<(String, String, String)> {
    let mut cursor = 0usize;
    let name = read_string(data, &mut cursor)?;
    let symbol = read_string(data, &mut cursor)?;
    let uri = read_string(data, &mut cursor)?;
    Ok((name, symbol, uri))
}

fn read_string(data: &[u8], cursor: &mut usize) -> Result<String> {
    require!(
        data.len() >= *cursor + 4,
        DominionError::MalformedActionData
    );
    let len = u32::from_le_bytes(data[*cursor..*cursor + 4].try_into().unwrap()) as usize;
    *cursor += 4;
    require!(
        data.len() >= *cursor + len,
        DominionError::MalformedActionData
    );
    let s = String::from_utf8(data[*cursor..*cursor + len].to_vec())
        .map_err(|_| error!(DominionError::MalformedActionData))?;
    *cursor += len;
    Ok(s)
}

fn decode_u16(data: &[u8]) -> Result<u16> {
    require!(data.len() >= 2, DominionError::MalformedActionData);
    Ok(u16::from_le_bytes([data[0], data[1]]))
}
