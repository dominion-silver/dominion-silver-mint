// redeem_silv: user burns SILV, receives USDC at Pyth oracle * (1 - premium_bps_redeem/10000).
// Treasury min-reserve invariant enforced post-state.
// Hourly redeem cap based on bounded snapshot (D16).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{
    Mint as InterfaceMint, Token2022, TokenAccount as InterfaceTokenAccount,
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::assertions::assert_silv_mint_invariants;
use crate::cpi::{silv_burn_from_user, usdc_transfer_treasury_to_user};
use crate::errors::DominionError;
use crate::events::RedeemEvent;
use crate::math::*;
use crate::oracle::{
    check_price_delta, maybe_update_last_price, read_silver_price, update_reserve_check_price,
};
use crate::state::*;

#[derive(Accounts)]
#[instruction(amount_silv: u64, min_usdc_out: u64, day_epoch: u32, hour_epoch: u32)]
pub struct RedeemSilv<'info> {
    // BPF stack frame is 4 KB; box every sizable account.
    // See mint_silv.rs for context (handler crashed with stack overflow).
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = DailyCountersAccount::SIZE,
        seeds = [DAILY_SEED, &day_epoch.to_le_bytes()],
        bump,
    )]
    pub daily: Box<Account<'info, DailyCountersAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = HourlyCountersAccount::SIZE,
        seeds = [HOURLY_SEED, &hour_epoch.to_le_bytes()],
        bump,
    )]
    pub hourly: Box<Account<'info, HourlyCountersAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    #[account(mut, address = config.silv_mint)]
    pub silv_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, address = config.usdc_treasury)]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    // User's USDC ATA.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = classic_token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    // User's SILV ATA.
    #[account(
        mut,
        associated_token::mint = silv_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_silv_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    // Treasury PDA (signs the USDC transfer out).
    /// CHECK: PDA-derived authority for treasury ATA, signs via seeds.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    #[account(owner = config.pyth_receiver_program)]
    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,

    #[account(address = config.token_2022_program)]
    pub token_2022_program: Program<'info, Token2022>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RedeemSilv>,
    amount_silv: u64,
    min_usdc_out: u64,
    day_epoch: u32,
    hour_epoch: u32,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let config = &mut ctx.accounts.config;

    // 1. Pause check.
    require!(!config.paused, DominionError::Paused);

    require!(
        day_epoch == DailyCountersAccount::current_day_epoch(now),
        DominionError::DayEpochMismatch
    );
    require!(
        hour_epoch == HourlyCountersAccount::current_hour_epoch(now),
        DominionError::HourEpochMismatch
    );

    // Read oracle.
    let oracle_price = read_silver_price(&ctx.accounts.price_update, config, &clock)?;
    check_price_delta(config, oracle_price, now)?;
    update_reserve_check_price(config, oracle_price, now)?;

    // Runtime SILV mint extension + authority assertions.
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 3. Per-tx caps (USDC equivalent at runtime, D43).
    require!(amount_silv > 0, DominionError::ZeroAmount);
    let usdc_equiv = silv_to_usdc_at_oracle(amount_silv, oracle_price)?;
    require!(
        usdc_equiv >= config.min_redeem_amount_usdc,
        DominionError::BelowMinimum
    );
    require!(
        usdc_equiv <= config.max_redeem_amount_per_tx_usdc,
        DominionError::AboveMaximum
    );

    // Compute USDC payout.
    let eff_price = effective_redeem_price_scaled(oracle_price, config.premium_bps_redeem)?;
    let usdc_out = redeem_usdc_out(amount_silv, eff_price)?;
    require!(usdc_out > 0, DominionError::ZeroAmount);

    // Slippage.
    require!(usdc_out >= min_usdc_out, DominionError::SlippageExceeded);

    // Treasury balance check.
    let treasury_balance_pre = ctx.accounts.usdc_treasury.amount;
    require!(
        treasury_balance_pre >= usdc_out,
        DominionError::InsufficientTreasury
    );
    let treasury_balance_post = treasury_balance_pre - usdc_out;

    // Post-state reserve invariant.
    let silv_supply_pre = ctx.accounts.silv_mint.supply;
    let silv_supply_post = silv_supply_pre
        .checked_sub(amount_silv)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    check_reserve_invariant_post_state(
        treasury_balance_post,
        silv_supply_post,
        config.reserve_check_price_scaled,
        config.treasury_min_reserve_bps,
    )?;

    // Daily counter init / load. H8: use rent_payer == default as freshness sentinel.
    let daily = &mut ctx.accounts.daily;
    if daily.rent_payer == Pubkey::default() {
        daily.day_epoch = day_epoch;
        daily.rent_payer = ctx.accounts.user.key();
    } else {
        require!(
            daily.day_epoch == day_epoch,
            DominionError::DayEpochMismatch
        );
    }

    let new_redeemed = daily
        .redeemed_today_usdc
        .checked_add(usdc_out)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        new_redeemed <= config.daily_redeem_cap_usdc,
        DominionError::DailyCapExceeded
    );

    // Hourly cap (D16). Snapshot bound: if previous hour's account exists in remaining_accounts,
    // bound new snapshot by `min(current_treasury, prev_snapshot - prev_redeemed)` to defeat
    // hour-boundary double-dip attack. If no prev hour passed, snapshot = current_treasury (first
    // hour after a quiet period; daily cap remains the backstop).
    let hourly = &mut ctx.accounts.hourly;
    if hourly.rent_payer == Pubkey::default() {
        hourly.hour_epoch = hour_epoch;
        hourly.rent_payer = ctx.accounts.user.key();

        let mut snapshot = treasury_balance_pre;
        // Optional prev_hour bound via first remaining account.
        if let Some(prev_hour_ai) = ctx.remaining_accounts.first() {
            // Anchor doesn't validate this; we deserialize manually and assert PDA seeds.
            let expected_pda = Pubkey::find_program_address(
                &[HOURLY_SEED, &(hour_epoch.saturating_sub(1)).to_le_bytes()],
                ctx.program_id,
            )
            .0;
            require!(
                prev_hour_ai.key() == expected_pda,
                DominionError::PrevHourMismatch
            );
            // SC-H5 defense-in-depth: also check ownership. Anchor disc
            // match + PDA derivation match are already strong, but explicit
            // owner check is cheap and removes any future-upgrade collision
            // risk.
            require!(
                prev_hour_ai.owner == ctx.program_id,
                DominionError::PrevHourMismatch
            );
            let prev_data = prev_hour_ai.try_borrow_data()?;
            // Account data layout: 8 bytes Anchor disc + HourlyCountersAccount fields.
            // Skip discriminator, deserialize.
            let prev = HourlyCountersAccount::try_deserialize(&mut &prev_data[..])
                .map_err(|_| error!(DominionError::PrevHourMismatch))?;
            require!(
                prev.hour_epoch == hour_epoch.saturating_sub(1),
                DominionError::PrevHourMismatch
            );
            let prev_remaining = prev
                .treasury_at_hour_start_usdc
                .saturating_sub(prev.redeemed_this_hour_usdc);
            snapshot = snapshot.min(prev_remaining);
        }
        hourly.treasury_at_hour_start_usdc = snapshot;
    } else {
        require!(
            hourly.hour_epoch == hour_epoch,
            DominionError::HourEpochMismatch
        );
    }
    let new_hourly = hourly
        .redeemed_this_hour_usdc
        .checked_add(usdc_out)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let hourly_cap = (hourly.treasury_at_hour_start_usdc as u128)
        .checked_mul(config.hourly_redeem_cap_bps_of_snapshot as u128)
        .ok_or(error!(DominionError::ArithmeticOverflow))?
        .checked_div(BPS_DENOM)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        (new_hourly as u128) <= hourly_cap,
        DominionError::HourlyRedeemCapExceeded
    );

    // Bump counters BEFORE CPIs.
    daily.redeemed_today_usdc = new_redeemed;
    hourly.redeemed_this_hour_usdc = new_hourly;

    // Dust-filter price update.
    maybe_update_last_price(config, oracle_price, usdc_equiv, now);

    // CPIs.
    // Burn SILV from user.
    silv_burn_from_user(
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.user_silv_ata.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount_silv,
        ctx.accounts.silv_mint.decimals,
    )?;

    // Transfer USDC: treasury PDA -> user.
    let bump = ctx.bumps.treasury_pda;
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    usdc_transfer_treasury_to_user(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.user_usdc_ata.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.treasury_pda.to_account_info(),
        signer_seeds,
        usdc_out,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // Event.
    emit!(RedeemEvent {
        user: ctx.accounts.user.key(),
        amount_silv,
        amount_usdc: usdc_out,
        price_used_scaled: oracle_price,
        premium_bps_used: config.premium_bps_redeem,
        timestamp: now,
    });

    Ok(())
}
