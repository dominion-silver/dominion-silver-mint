// redeem_silv: INSTANT redemption path only (Option B, CONFIRMED_SPEC.md §4.3).
// User burns SILV, receives USDC at Pyth oracle * (1 - premium_bps_redeem/10000),
// settled immediately from the treasury.
//
// This instruction is the INSTANT branch of the §4.3 decision tree. It does NOT
// create a queue account (engineering decision: conditional PDA creation in one
// ix is a classic Solana bug source; the queued path is the separate
// `redeem_silv_queued` instruction). The decision-tree LOGIC is preserved:
//   - usdc_out >= large_redeem_threshold        -> revert MustUseQueue (client calls redeem_silv_queued)
//   - rolling-window instant budget exhausted   -> revert MustUseQueue (client calls redeem_silv_queued)
//   - instant-eligible but treasury can't cover -> revert InsufficientTreasury (client routes to OTC)
//   - instant-eligible and treasury covers      -> burn + pay now, debit the global rolling-window budget
//
// The rolling-window instant budget is GLOBAL (all users, one counter in
// config) so it is Sybil-proof: splitting across many wallets cannot exceed it
// (D10, fixes the per-tx $5k structuring hole). The float (D7 option a) NEVER
// blocks redemptions: the treasury check is `balance >= usdc_out`, NOT minus
// float. "revert + emit RedeemToOtc" is impossible on Solana (a reverting tx
// rolls back all events); the InsufficientTreasury error code IS the client's
// OTC-routing signal.

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
use crate::oracle::{check_price_delta, maybe_update_last_price, read_silver_price};
use crate::state::*;

#[derive(Accounts)]
#[instruction(amount_silv: u64, min_usdc_out: u64)]
pub struct RedeemSilv<'info> {
    // BPF stack frame is 4 KB; box every sizable account.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Box<Account<'info, ConfigAccount>>,

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

pub fn handler(ctx: Context<RedeemSilv>, amount_silv: u64, min_usdc_out: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let config = &mut ctx.accounts.config;

    // 1. Pause + redemptions switch (D11: manual admin switch, no auto-expiry).
    require!(!config.paused, DominionError::Paused);
    require!(
        config.redemptions_enabled,
        DominionError::RedemptionsDisabled
    );

    // 2. Zero guard (per-tx min/max + daily/hourly caps removed in Option B;
    // the global rolling-window instant budget below is the protection, D10).
    require!(amount_silv > 0, DominionError::ZeroAmount);

    // 3. Oracle read + circuit breaker + runtime mint assertions.
    let oracle_price = read_silver_price(&ctx.accounts.price_update, config, &clock)?;
    check_price_delta(config, oracle_price, now)?;
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 4. Pricing (oracle * (1 - redeem premium); floor, protocol favor).
    let eff_price = effective_redeem_price_scaled(oracle_price, config.premium_bps_redeem)?;
    let usdc_out = redeem_usdc_out(amount_silv, eff_price)?;
    require!(usdc_out > 0, DominionError::ZeroAmount);

    // 5. Slippage.
    require!(usdc_out >= min_usdc_out, DominionError::SlippageExceeded);

    // 6. Rolling-window state (computed, NOT yet committed - we only persist if
    // the instant path fully succeeds; any revert below rolls this back).
    let window_end = config
        .instant_window_start
        .checked_add(config.instant_redeem_window_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    let window_expired = now >= window_end;
    let effective_used: u64 = if window_expired {
        0
    } else {
        config.instant_used_usdc
    };

    // 7. §4.3 routing. NO config mutation on any revert path.
    //   A. Forced queue: single redeem >= large threshold.
    require!(
        usdc_out < config.large_redeem_threshold_usdc,
        DominionError::MustUseQueue
    );
    //   B. Budget exhausted in the current window: client must queue.
    let new_used = effective_used
        .checked_add(usdc_out)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        new_used <= config.instant_redeem_budget_usdc,
        DominionError::MustUseQueue
    );
    //   C. Instant-eligible. Treasury must cover it NOW. Float (D7 option a)
    //   does NOT gate redemptions: check raw balance, not balance - float.
    let treasury_balance = ctx.accounts.usdc_treasury.amount;
    require!(
        treasury_balance >= usdc_out,
        DominionError::InsufficientTreasury
    );

    // 8. Commit the rolling-window budget BEFORE the CPIs (atomic: any CPI
    // failure reverts the whole tx incl. this write). Anchor the window to
    // `now` on first instant redeem after expiry.
    if window_expired {
        config.instant_window_start = now;
    }
    config.instant_used_usdc = new_used;

    // 9. Dust-filter price update (feeds the circuit breaker; D38). Uses the
    // oracle-value equivalent (pre-premium) to match the V1 dust threshold.
    let usdc_equiv = silv_to_usdc_at_oracle(amount_silv, oracle_price)?;
    maybe_update_last_price(config, oracle_price, usdc_equiv, now);

    // 10. CPIs. Burn SILV from user.
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

    // 11. Event.
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
