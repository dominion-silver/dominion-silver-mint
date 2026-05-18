// mint_silv: user sends USDC, receives SILV at Pyth oracle * (1 + premium_bps_mint/10000).
// Canonical execution order per PLAN.md §5.3.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{
    Mint as InterfaceMint, Token2022, TokenAccount as InterfaceTokenAccount,
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::assertions::assert_silv_mint_invariants;
use crate::cpi::{silv_mint_to, usdc_transfer_user_to_treasury};
use crate::errors::DominionError;
use crate::events::MintEvent;
use crate::math::*;
use crate::oracle::{
    check_price_delta, maybe_update_last_price, read_silver_price, update_reserve_check_price,
};
use crate::state::*;

#[derive(Accounts)]
#[instruction(amount_usdc: u64, min_silv_out: u64, day_epoch: u32)]
pub struct MintSilv<'info> {
    // BPF stack frame is capped at 4 KB. ConfigAccount alone is ~1 KB
    // and the full Accounts struct deserialized would overflow the stack
    // (observed on devnet: "Access violation in stack frame 5"). Box every
    // sizable account to keep them on the heap.
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

    #[account(mut)]
    pub user: Signer<'info>,

    // Pinned via config.
    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    #[account(mut, address = config.silv_mint)]
    pub silv_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(mut, address = config.usdc_treasury)]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    // User's USDC ATA (classic SPL).
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = classic_token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    // User's SILV ATA (Token-2022).
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = silv_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_silv_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    // Mint authority PDA.
    /// CHECK: PDA derived deterministically; signs SILV mint via seeds.
    #[account(seeds = [SILV_MINT_AUTHORITY_SEED], bump)]
    pub silv_mint_authority: AccountInfo<'info>,

    // Pyth price update with owner pinned.
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
    ctx: Context<MintSilv>,
    amount_usdc: u64,
    min_silv_out: u64,
    day_epoch: u32,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let config = &mut ctx.accounts.config;

    // 1. Pause checks.
    require!(!config.paused, DominionError::Paused);
    // 2. Mint-specific pause (premium proposal in flight).
    require!(now >= config.mint_paused_until, DominionError::MintPaused);

    // Day epoch sanity.
    require!(
        day_epoch == DailyCountersAccount::current_day_epoch(now),
        DominionError::DayEpochMismatch
    );

    // 3. Per-tx caps (USDC equivalent terms).
    require!(amount_usdc > 0, DominionError::ZeroAmount);
    require!(
        amount_usdc >= config.min_mint_amount_usdc,
        DominionError::BelowMinimum
    );
    require!(
        amount_usdc <= config.max_mint_amount_per_tx_usdc,
        DominionError::AboveMaximum
    );

    // 4. Account constraints already enforced by Anchor.

    // 5. Read Pyth (owner+feed+staleness atomic, conf, sanity, exp branch).
    let oracle_price = read_silver_price(&ctx.accounts.price_update, config, &clock)?;

    // 6. Price-delta circuit breaker.
    check_price_delta(config, oracle_price, now)?;

    // 7. Update reserve_check_price (slow-track upward, instant down).
    update_reserve_check_price(config, oracle_price, now)?;

    // 8. Runtime SILV mint extension + authority assertions.
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 9. Pricing math (floor protocol-favor).
    let eff_price = effective_mint_price_scaled(oracle_price, config.premium_bps_mint)?;
    let silv_out = mint_silv_out(amount_usdc, eff_price)?;
    require!(silv_out > 0, DominionError::ZeroAmount);

    // 10. Slippage check.
    require!(silv_out >= min_silv_out, DominionError::SlippageExceeded);

    // 11. DailyCounters init / load. H8 fix: use rent_payer == default as the "fresh" sentinel
    // (more robust than `epoch==0 && counters==0` which has edge cases).
    let daily = &mut ctx.accounts.daily;
    if daily.rent_payer == Pubkey::default() {
        // Newly initialized via init_if_needed.
        daily.day_epoch = day_epoch;
        daily.rent_payer = ctx.accounts.user.key();
    } else {
        require!(
            daily.day_epoch == day_epoch,
            DominionError::DayEpochMismatch
        );
    }

    // 12. Cap checks.
    let new_minted = daily
        .minted_today_usdc
        .checked_add(amount_usdc)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        new_minted <= config.daily_mint_cap_usdc,
        DominionError::DailyCapExceeded
    );

    // 13. (Mint has no treasury reserve check; mint always increases backing in USDC.)

    // 14. Bump counters BEFORE CPIs (atomicity rolls back on CPI failure).
    daily.minted_today_usdc = new_minted;

    // 15. Dust-filter price update.
    maybe_update_last_price(config, oracle_price, amount_usdc, now);

    // 16. CPIs.
    // 16a. USDC: user -> treasury.
    usdc_transfer_user_to_treasury(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.user_usdc_ata.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount_usdc,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // 16b. SILV: PDA mints to user.
    let bump = ctx.bumps.silv_mint_authority;
    let seeds: &[&[u8]] = &[SILV_MINT_AUTHORITY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    silv_mint_to(
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.user_silv_ata.to_account_info(),
        ctx.accounts.silv_mint_authority.to_account_info(),
        signer_seeds,
        silv_out,
        ctx.accounts.silv_mint.decimals,
    )?;

    // 17. Event.
    emit!(MintEvent {
        user: ctx.accounts.user.key(),
        amount_usdc,
        amount_silv: silv_out,
        price_used_scaled: oracle_price,
        premium_bps_used: config.premium_bps_mint,
        timestamp: now,
    });

    Ok(())
}
