// redeem_silv: THE redemption path. One route, instant settlement. The user burns SILV and receives
// USDC from the treasury in the same transaction, for any amount the treasury can currently fund.
//
// OUTFLOW DEFINITION, and getting it backwards is a live revert. What leaves the treasury is the
// GROSS oracle value of the burned SILV when fee routing is ON (user leg plus premium leg), and
// GROSS MINUS FEE when routing is OFF (the premium is retained, so only the user leg moves). That
// figure is `total_out`; it drives both the budget debit and the solvency check, and the public client
// mirrors it. The premium is charged in either mode, so the user receives the same amount either way
// and the escape hatch cannot double as a global fee waiver.

use crate::lazer_cpi::{LazerVerifyAccounts, LAZER_FEE_PAYER_SEED};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{
    Mint as InterfaceMint, Token2022, TokenAccount as InterfaceTokenAccount,
};

use crate::assertions::assert_silv_mint_invariants;
use crate::cpi::{
    silv_burn_from_user, usdc_transfer_treasury_to_fee_vault, usdc_transfer_treasury_to_user,
};
use crate::errors::DominionError;
use crate::events::RedeemEvent;
use crate::math::*;
use crate::oracle::{check_price_delta, maybe_update_last_price, read_silver_price_lazer};
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

    /// CHECK: PDA authority of the fee vault. Never signs here; it signs only in withdraw_fees.
    #[account(seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault_pda: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = fee_vault_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = classic_token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = silv_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_silv_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// CHECK: PDA-derived authority for treasury ATA, signs via seeds.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    /// CHECK: pinned to LAZER_PROGRAM_ID + executable in verify_and_get_payload.
    pub lazer_program: UncheckedAccount<'info>,
    /// CHECK: pinned to LAZER_STORAGE in verify_and_get_payload.
    pub lazer_storage: UncheckedAccount<'info>,
    /// CHECK: validated against the Lazer Storage's own treasury (read_treasury) in verify_and_get_payload.
    #[account(mut)]
    pub lazer_treasury: UncheckedAccount<'info>,
    /// CHECK: System-owned isolated fee-payer PDA; derivation validated in the wrapper.
    #[account(mut, seeds = [LAZER_FEE_PAYER_SEED], bump)]
    pub lazer_fee_payer: UncheckedAccount<'info>,
    /// CHECK: pinned to the instructions sysvar in verify_and_get_payload.
    pub instructions_sysvar: UncheckedAccount<'info>,

    // Optional, PDA-seeded FROM `user`, so neither can be presented on somebody else's behalf.
    // Omitting either gives the safe default: full premium, and denied if the KYC gate is armed.
    #[account(seeds = [FEE_EXEMPT_SEED, user.key().as_ref()], bump)]
    pub fee_exempt: Option<Account<'info, FeeExemptAccount>>,

    #[account(seeds = [KYC_SEED, user.key().as_ref()], bump)]
    pub kyc: Option<Account<'info, KycAccount>>,

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
    message_data: Vec<u8>,
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 1. Pause + redemptions switch. &mut config comes after the oracle read (disjoint borrows).
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    require!(
        ctx.accounts.config.redemptions_enabled,
        DominionError::RedemptionsDisabled
    );

    // 1b. KYC gate, dormant at launch (`kyc_scope_flags == 0`). `enforce_kyc` must be called on BOTH
    // sides (mint side: mint_silv.rs step 2b). Before the oracle read, so a failing caller pays no fee.
    let user_key = ctx.accounts.user.key();
    enforce_kyc(
        ctx.accounts.config.kyc_scope_flags,
        Side::Redeem,
        ctx.accounts.kyc.as_deref(),
        &user_key,
    )?;

    // 2. Zero guard. The global rolling-window budget below is the only size limit (D10).
    require!(amount_silv > 0, DominionError::ZeroAmount);

    let lazer_program_ai = ctx.accounts.lazer_program.to_account_info();
    let lazer_storage_ai = ctx.accounts.lazer_storage.to_account_info();
    let lazer_treasury_ai = ctx.accounts.lazer_treasury.to_account_info();
    let lazer_fee_payer_ai = ctx.accounts.lazer_fee_payer.to_account_info();
    let instructions_sysvar_ai = ctx.accounts.instructions_sysvar.to_account_info();
    let system_program_ai = ctx.accounts.system_program.to_account_info();
    let user_ai = ctx.accounts.user.to_account_info();
    let lazer_accts = LazerVerifyAccounts {
        lazer_program: &lazer_program_ai,
        storage: &lazer_storage_ai,
        treasury: &lazer_treasury_ai,
        fee_payer: &lazer_fee_payer_ai,
        instructions_sysvar: &instructions_sysvar_ai,
        system_program: &system_program_ai,
        funder: &user_ai,
    };
    let price_result = read_silver_price_lazer(
        &lazer_accts,
        ctx.bumps.lazer_fee_payer,
        &ctx.accounts.config,
        &clock,
        message_data,
        ed25519_instruction_index,
        signature_index,
    )?;
    let oracle_price = price_result.normalized_price_scaled;

    let config = &mut ctx.accounts.config;
    config.last_used_feed_update_timestamp_us = price_result.feed_update_timestamp_us;
    check_price_delta(config, oracle_price, now)?;
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 4. Price at PURE SPOT. `gross_usdc` is the full oracle value burned; the user gets `gross - fee`.
    let gross_usdc = silv_to_usdc_at_oracle(amount_silv, oracle_price)?;
    require!(gross_usdc > 0, DominionError::ZeroAmount);

    let premium_bps = effective_premium_bps(
        config.premium_bps_redeem,
        ctx.accounts.fee_exempt.as_deref(),
        &user_key,
        Side::Redeem,
        // An EXPIRED exemption silently stops applying: full premium, no revert.
        now,
    );
    // The premium is ALWAYS charged; only its DESTINATION follows the escape hatch. Zeroing the fee
    // when routing is off would pay the user the full gross: an instant global fee waiver.
    let fee_usdc = fee_from_amount(gross_usdc, premium_bps)?;
    // `fee_from_amount` CEILS and never exceeds its input (math.rs). Ceiling is the safe direction:
    // the dust goes to the protocol. Checked anyway, since an underflow here becomes a huge payout.
    let to_user_usdc = gross_usdc
        .checked_sub(fee_usdc)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(to_user_usdc > 0, DominionError::ZeroAmount);

    // 5. Slippage on what the USER receives: `min_usdc_out` is the user's floor, never the gross.
    require!(
        to_user_usdc >= min_usdc_out,
        DominionError::SlippageExceeded
    );

    // 6. Rolling-window budget. Computed here, COMMITTED at step 8 only once every check has passed.
    // Debited by the outflow (see the header), not the trade size. SLIDING window: redeem_window.rs.
    let win = roll_window(
        now,
        config.instant_window_start,
        config.instant_redeem_window_seconds,
        config.instant_used_usdc,
        config.instant_used_prev_usdc,
    );
    // Routing off retains the premium, so debiting the gross would refuse fundable redemptions.
    let fee_routed = if config.fee_routing_disabled {
        0
    } else {
        fee_usdc
    };
    let total_out = to_user_usdc
        .checked_add(fee_routed)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    let new_used = win
        .effective_used
        .checked_add(total_out)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    // 7a. The window budget. Exceeding it REVERTS, there is no queue: retry once the window rolls,
    // or the admin raises it (24h-timelocked) or cuts it via emergency_tighten_redeem_limits.
    require!(
        new_used <= config.instant_redeem_budget_usdc,
        DominionError::RedeemLimitExceeded
    );

    // 7b. Solvency over the SUM of both legs; the user's leg alone would let the premium transfer
    // overdraw. The float (D7 option a) is NOT subtracted: it gates the ADMIN, so users come first.
    let treasury_balance = ctx.accounts.usdc_treasury.amount;
    require!(
        treasury_balance >= total_out,
        DominionError::InsufficientTreasury
    );

    // 8. Commit the window BEFORE the CPIs; a CPI failure reverts these writes too. The CURRENT
    // bucket takes `rolled_current + total_out`, NOT `new_used`: `effective_used` carries a decaying
    // weighted share of the previous bucket, and making it permanent ratchets the limiter shut.
    config.instant_window_start = win.new_window_start;
    config.instant_used_prev_usdc = win.rolled_prev;
    config.instant_used_usdc = win
        .rolled_current
        .checked_add(total_out)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    // 9. Dust-filter price update (D38). Pre-premium value, i.e. `gross_usdc`, so the threshold holds.
    maybe_update_last_price(config, oracle_price, gross_usdc, now);

    silv_burn_from_user(
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.user_silv_ata.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount_silv,
        ctx.accounts.silv_mint.decimals,
    )?;

    // Both USDC legs are signed by the treasury PDA and total `total_out`, which step 7b verified.
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
        to_user_usdc,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // Leg 2: the premium. Skipped at zero rather than transferring 0, which would log a line on every
    // redemption by an exempt wallet. After the user's leg, so a future split still pays the user first.
    if fee_routed > 0 {
        usdc_transfer_treasury_to_fee_vault(
            ctx.accounts.classic_token_program.to_account_info(),
            ctx.accounts.usdc_treasury.to_account_info(),
            ctx.accounts.fee_vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.treasury_pda.to_account_info(),
            signer_seeds,
            fee_routed,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    emit!(RedeemEvent {
        user: user_key,
        amount_silv,
        // NET, what the user received. The real outflow also needs the routing flag as of that slot.
        amount_usdc: to_user_usdc,
        price_used_scaled: oracle_price,
        // The EFFECTIVE premium: 0 means a redeem-side exemption, not config.premium_bps_redeem.
        premium_bps_used: premium_bps,
        // What the VAULT received. Zero with routing disabled, where the premium was still charged.
        fee_usdc: fee_routed,
        timestamp: now,
    });

    Ok(())
}
