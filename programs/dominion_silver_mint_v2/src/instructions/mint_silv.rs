// mint_silv: user sends USDC, receives SILV at Pyth oracle * (1 + premium_bps_mint/10000).
// Option B (CONFIRMED_SPEC.md Section 4.2): the Option A daily cap + on-chain
// reserve are replaced by a single HARD supply cap (D2). Mint always brings
// USDC in; SILV is backed by physical silver in custody (off-chain), so there
// is no on-chain solvency invariant. Launch discount = admin lowers
// premium_bps_mint via the timelocked setter (D4), no special logic here.

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
use crate::oracle::{check_price_delta, maybe_update_last_price, read_silver_price};
use crate::state::*;

#[derive(Accounts)]
#[instruction(amount_usdc: u64, min_silv_out: u64)]
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

pub fn handler(ctx: Context<MintSilv>, amount_usdc: u64, min_silv_out: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let config = &mut ctx.accounts.config;

    // 1. Pause checks.
    require!(!config.paused, DominionError::Paused);
    // 2. Mint-specific pause (D30 front-run defense). CODEX P2-01: gate on the
    // pending premium-mint proposal itself, not just `mint_paused_until`
    // (= executable_at). Otherwise, once the 24h elapses but before the admin
    // executes/cancels, mints would resume at the OLD premium while a change
    // is executable - a front-run window. The nonce is cleared on BOTH execute
    // and cancel, so this closes the window with no gap. The time check is
    // kept as belt-and-suspenders / UI signal.
    require!(now >= config.mint_paused_until, DominionError::MintPaused);
    require!(
        config.pending_premium_mint_nonce.is_none(),
        DominionError::MintPaused
    );

    // 3. Zero-amount guard. (Per-tx min/max + daily caps removed in Option B;
    // the HARD supply cap below is the sole mint-side limit, D2.)
    require!(amount_usdc > 0, DominionError::ZeroAmount);

    // 4. Read Pyth (owner+feed+staleness atomic, conf, sanity, exp branch).
    let oracle_price = read_silver_price(&ctx.accounts.price_update, config, &clock)?;

    // 5. Price-delta circuit breaker.
    check_price_delta(config, oracle_price, now)?;

    // 6. Runtime SILV mint extension + authority assertions.
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 7. Pricing math (ceil price -> floor silv_out, protocol favor).
    let eff_price = effective_mint_price_scaled(oracle_price, config.premium_bps_mint)?;
    let silv_out = mint_silv_out(amount_usdc, eff_price)?;
    require!(silv_out > 0, DominionError::ZeroAmount);

    // 8. Slippage check.
    require!(silv_out >= min_silv_out, DominionError::SlippageExceeded);

    // 9. HARD supply cap (D2, Option B replacement for the Option A daily cap +
    // reserve invariant). `silv_mint.supply` is the pre-CPI circulating supply;
    // reject if minting `silv_out` more would push it above `max_silv_supply`.
    // The cap is in atomic SILV (oz * 1e6) and is admin-raisable from the panel.
    let supply_post = ctx
        .accounts
        .silv_mint
        .supply
        .checked_add(silv_out)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        supply_post <= config.max_silv_supply,
        DominionError::SupplyCapExceeded
    );

    // 10. Dust-filter price update (feeds the circuit breaker; D38).
    maybe_update_last_price(config, oracle_price, amount_usdc, now);

    // 11. CPIs.
    // 11a. USDC: user -> treasury.
    usdc_transfer_user_to_treasury(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.user_usdc_ata.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount_usdc,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // 11b. SILV: PDA mints to user.
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

    // 12. Event.
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
