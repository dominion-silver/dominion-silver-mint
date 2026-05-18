// Option B queued-redemption lifecycle (CONFIRMED_SPEC.md §4.3 ENQUEUE + §4.4).
//
// Three instructions:
//   - redeem_silv_queued: client calls when a redeem must be queued (the
//     instant `redeem_silv` reverted MustUseQueue: amount >= large threshold OR
//     the rolling-window instant budget is exhausted), or voluntarily. SILV is
//     BURNED NOW (D9: prevents double-spend); a RedemptionRequest PDA records
//     it; the USDC is priced at CLAIM time (D9).
//   - claim_redemption: after redeem_queue_delay_seconds, prices at the CLAIM
//     oracle, pays from the treasury if it can cover. If not, it reverts and
//     the request stays Pending (an on-chain IOU); the admin later settles it
//     OTC. NOT gated by redemptions_enabled (§8: disabling blocks NEW
//     redemptions; a committed queued IOU stays claimable; only global pause
//     stops it).
//   - admin_settle_redemption_offchain: admin marks a Pending request
//     SettledOffchain after honoring it via the OTC desk.
//
// "revert + emit RedeemToOtc" is impossible on Solana (a reverting tx rolls
// back all events): the InsufficientTreasury error code + the durable Pending
// status ARE the off-chain settlement signal.

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
use crate::events::{RedeemQueued, RedemptionClaimed, RedemptionSettledOffchain};
use crate::math::{effective_redeem_price_scaled, redeem_usdc_out, silv_to_usdc_at_oracle};
use crate::oracle::{check_price_delta, maybe_update_last_price, read_silver_price};
use crate::state::*;

// ---------------------------------------------------------------------------
// 1. redeem_silv_queued: burn SILV now, create the queued request.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(amount_silv: u64, request_nonce: u64)]
pub struct RedeemSilvQueued<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, address = config.silv_mint)]
    pub silv_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    #[account(
        mut,
        associated_token::mint = silv_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_silv_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    // Deterministic per-(owner, nonce) PDA. `init` (NOT init_if_needed): a
    // second tx reusing the same nonce fails cleanly (account already in use);
    // the client retries with the fresh config.next_redeem_request_nonce.
    #[account(
        init,
        payer = user,
        space = RedemptionRequest::SIZE,
        seeds = [REDEEM_REQUEST_SEED, user.key().as_ref(), &request_nonce.to_le_bytes()],
        bump,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(address = config.token_2022_program)]
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn queued_handler(
    ctx: Context<RedeemSilvQueued>,
    amount_silv: u64,
    request_nonce: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let config = &mut ctx.accounts.config;

    // §8: disabling redemptions blocks NEW queue entries too. Pause is the
    // global stop.
    require!(!config.paused, DominionError::Paused);
    require!(
        config.redemptions_enabled,
        DominionError::RedemptionsDisabled
    );
    require!(amount_silv > 0, DominionError::ZeroAmount);
    // Monotonic global request numbering: the client must use the current
    // next nonce (under contention another user's queued tx may bump it first;
    // the client refetches and retries). Reusing `NonceMismatch`.
    require!(
        request_nonce == config.next_redeem_request_nonce,
        DominionError::NonceMismatch
    );

    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    let claimable_at = now
        .checked_add(config.redeem_queue_delay_seconds as i64)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    // Burn SILV NOW (D9). If the burn fails the whole tx reverts and the
    // Anchor-created request account is rolled back (rent refunded).
    silv_burn_from_user(
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.user_silv_ata.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount_silv,
        ctx.accounts.silv_mint.decimals,
    )?;

    let req = &mut ctx.accounts.redemption_request;
    req.owner = ctx.accounts.user.key();
    req.amount_silv = amount_silv;
    req.requested_at = now;
    req.claimable_at = claimable_at;
    req.nonce = request_nonce;
    req.status = RedemptionStatus::Pending;
    req.bump = ctx.bumps.redemption_request;
    req.reserved = [0u8; 32];

    config.next_redeem_request_nonce = config
        .next_redeem_request_nonce
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    emit!(RedeemQueued {
        owner: ctx.accounts.user.key(),
        amount_silv,
        nonce: request_nonce,
        claimable_at,
        timestamp: now,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 2. claim_redemption: after the delay, price at CLAIM oracle, pay if covered.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimRedemption<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    // Re-derive + verify the PDA from its own stored (owner, nonce, bump).
    // `close = owner` on success refunds rent to the owner; combined with the
    // status=Claimed write + account deletion this makes a second claim
    // impossible.
    #[account(
        mut,
        close = owner,
        seeds = [REDEEM_REQUEST_SEED, owner.key().as_ref(), &redemption_request.nonce.to_le_bytes()],
        bump = redemption_request.bump,
        has_one = owner @ DominionError::RedeemRequestOwnerMismatch,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    #[account(mut, address = config.usdc_treasury)]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
        associated_token::token_program = classic_token_program,
    )]
    pub owner_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA-derived treasury authority, signs the USDC transfer via seeds.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    #[account(owner = config.pyth_receiver_program)]
    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_handler(ctx: Context<ClaimRedemption>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let config = &mut ctx.accounts.config;

    // NOT gated by redemptions_enabled (§8: queued IOU stays claimable; SILV
    // already burned). Only the global pause stops a claim.
    require!(!config.paused, DominionError::Paused);

    {
        let req = &ctx.accounts.redemption_request;
        require!(
            req.status == RedemptionStatus::Pending,
            DominionError::RequestNotPending
        );
        require!(now >= req.claimable_at, DominionError::QueueNotReady);
    }
    let amount_silv = ctx.accounts.redemption_request.amount_silv;
    let nonce = ctx.accounts.redemption_request.nonce;
    let owner_key = ctx.accounts.redemption_request.owner;

    // Oracle priced at CLAIM time (D9: the user bears price risk over the delay).
    let oracle_price = read_silver_price(&ctx.accounts.price_update, config, &clock)?;
    check_price_delta(config, oracle_price, now)?;
    let eff_price = effective_redeem_price_scaled(oracle_price, config.premium_bps_redeem)?;
    let usdc_out = redeem_usdc_out(amount_silv, eff_price)?;
    require!(usdc_out > 0, DominionError::ZeroAmount);

    // Treasury must cover NOW. Float (D7 option a) does NOT gate redemptions:
    // raw balance, not balance - float. If short -> revert, the request stays
    // Pending (durable on-chain IOU); admin later settles OTC.
    require!(
        ctx.accounts.usdc_treasury.amount >= usdc_out,
        DominionError::InsufficientTreasury
    );

    // Dust-filter price update (feeds the circuit breaker; D38).
    let usdc_equiv = silv_to_usdc_at_oracle(amount_silv, oracle_price)?;
    maybe_update_last_price(config, oracle_price, usdc_equiv, now);

    // Mark Claimed BEFORE the CPI (atomic: a CPI failure reverts the whole tx
    // and the status stays Pending). On success Anchor `close` deletes the
    // account, so a re-claim is impossible regardless.
    ctx.accounts.redemption_request.status = RedemptionStatus::Claimed;

    let bump = ctx.bumps.treasury_pda;
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    usdc_transfer_treasury_to_user(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.owner_usdc_ata.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.treasury_pda.to_account_info(),
        signer_seeds,
        usdc_out,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(RedemptionClaimed {
        owner: owner_key,
        amount_silv,
        amount_usdc: usdc_out,
        price_used_scaled: oracle_price,
        nonce,
        timestamp: now,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 3. admin_settle_redemption_offchain: mark a Pending request settled via OTC.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AdminSettleRedemptionOffchain<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ DominionError::Unauthorized,
    )]
    pub config: Box<Account<'info, ConfigAccount>>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, redemption_request.owner.as_ref(), &redemption_request.nonce.to_le_bytes()],
        bump = redemption_request.bump,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,
}

pub fn settle_offchain_handler(ctx: Context<AdminSettleRedemptionOffchain>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(
        ctx.accounts.redemption_request.status == RedemptionStatus::Pending,
        DominionError::RequestNotPending
    );

    let req = &mut ctx.accounts.redemption_request;
    req.status = RedemptionStatus::SettledOffchain;

    emit!(RedemptionSettledOffchain {
        owner: req.owner,
        amount_silv: req.amount_silv,
        nonce: req.nonce,
        by: ctx.accounts.admin.key(),
        timestamp: now,
    });
    Ok(())
}
