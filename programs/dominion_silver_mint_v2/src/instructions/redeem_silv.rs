// redeem_silv: THE redemption path. One route, instant settlement.
//
// The user burns SILV and receives USDC from the treasury in the same transaction. That is
// the whole flow (Thomas, 2026-08-05: "on va rester tres simple"):
//
//   1. Redeem any amount. The only limit is current treasury solvency.
//   2. One transaction.
//   3. SILV burned, USDC out.
//
// WHAT WAS REMOVED, and why each removal is safe:
//
//   - The T+3 QUEUE, in full: `redeem_queued.rs`, `RedemptionRequest`,
//     `redeem_silv_queued`, `claim_redemption`, `admin_settle_redemption_offchain`,
//     `close_settled_redemption`. Deleting the off-chain settlement path also deletes
//     SolidProof TrustNet MEDIUM #4, where the admin could mark a request settled with no
//     on-chain proof while the user's SILV was already burned. The finding is gone from the
//     codebase rather than argued away in an audit response, which is the strongest form of
//     remediation available.
//
//   - `large_redeem_threshold_usdc`, the per-size tier that forced large redemptions into
//     the queue. Removed for two reasons: it discriminated on amount, which the simple
//     design explicitly rejects, and it actively rewarded structuring (three $4k redemptions
//     instead of one $10k one) so it never bounded anything a determined caller cared about.
//
// WHAT WAS KEPT, and why it is not the thing that was rejected:
//
//   - The GLOBAL rolling budget (`instant_redeem_budget_usdc` over
//     `instant_redeem_window_seconds`). This is ONE ceiling per window applied identically
//     to every caller whatever their size, so it is not amount discrimination. It is the
//     only brake between a bad oracle print and the entire treasury leaving in a single
//     transaction: the oracle guards (staleness, publisher floor, price-delta breaker) are
//     FILTERS, not limiters, and `pause` needs a human to notice inside one block. It stays
//     GLOBAL rather than per-wallet so it is Sybil-proof: a hundred fresh wallets share one
//     counter. Exceeding it now REVERTS (RedeemLimitExceeded) where it used to route to the
//     queue.
//
// The treasury float (D7 option a) still NEVER blocks a redemption: the solvency check reads
// the raw balance, not balance minus float. The float gates the ADMIN's withdrawal, so users
// come ahead of the admin's ability to move cash out.
//
// PREMIUM ROUTING (2026-08-05) changes the treasury's cash flow, which is the one
// non-obvious consequence of this batch. The treasury now pays out the FULL spot value of
// the burned SILV, split between the user (spot minus premium) and the fee vault (the
// premium). Before routing it paid only the user's share and quietly kept the premium. So
// the solvency check must cover the SUM of both legs, and the treasury drains marginally
// faster per redemption than it used to.

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

    // Premium destination. Same account and same reasoning as in mint_silv: the ATA of the
    // fee_vault PDA, derivable rather than stored, and impossible to close.
    /// CHECK: PDA authority of the fee vault. Never signs here (the vault only receives on
    /// this path); it signs only in withdraw_fees.
    #[account(seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault_pda: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = fee_vault_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

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

    // Pyth Lazer verify accounts (all keys pinned + validated in the wrapper).
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

    // Optional per-wallet flags. PDA-seeded FROM `user`, so neither can be presented on
    // somebody else's behalf. Omitting either yields the safe default: full premium, and
    // denied if the KYC gate is armed on the redeem side.
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

    // 1. Pause + redemptions switch (immutable reads; &mut config taken after
    //    the oracle read for disjoint borrows of the Lazer verify accounts).
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    require!(
        ctx.accounts.config.redemptions_enabled,
        DominionError::RedemptionsDisabled
    );

    // 1b. KYC gate. Dormant at launch (`kyc_scope_flags == 0`). Checked before the oracle
    // read so a caller who cannot pass it does not pay the Lazer verify fee first.
    //
    // Redeem is the likely FIRST side Mark arms, since it is the leg that pays out treasury
    // cash while public mint stays open for DEX arbitrage. That asymmetry is why the scope is
    // two bits rather than one switch.
    let user_key = ctx.accounts.user.key();
    enforce_kyc(
        ctx.accounts.config.kyc_scope_flags,
        Side::Redeem,
        ctx.accounts.kyc.as_deref(),
        &user_key,
    )?;

    // 2. Zero guard (per-tx min/max + daily/hourly caps removed in Option B;
    // the global rolling-window budget below is the protection, D10).
    require!(amount_silv > 0, DominionError::ZeroAmount);

    // 3. Oracle read (Lazer verify CPI via the isolated fee-payer PDA + policy).
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

    // 4. Price at PURE SPOT, then split the premium off the payout.
    //
    // `gross_usdc` is the full oracle value of the SILV being burned, and it is what LEAVES
    // THE TREASURY. The user receives `gross - fee`, the fee vault receives `fee`.
    let gross_usdc = silv_to_usdc_at_oracle(amount_silv, oracle_price)?;
    require!(gross_usdc > 0, DominionError::ZeroAmount);

    let premium_bps = effective_premium_bps(
        config.premium_bps_redeem,
        ctx.accounts.fee_exempt.as_deref(),
        &user_key,
        Side::Redeem,
    );
    let fee_usdc = fee_from_amount(gross_usdc, premium_bps)?;
    // `fee_from_amount` is proven never to exceed its input (math.rs). Checked anyway: an
    // unchecked subtraction here would wrap into a colossal payout.
    let to_user_usdc = gross_usdc
        .checked_sub(fee_usdc)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(to_user_usdc > 0, DominionError::ZeroAmount);

    // 5. Slippage, measured on what the USER receives. Unchanged meaning for clients:
    // `min_usdc_out` has always been the user's floor, never the gross.
    require!(
        to_user_usdc >= min_usdc_out,
        DominionError::SlippageExceeded
    );

    // 6. Rolling-window budget state. Computed here, COMMITTED at step 8 only after every
    // check has passed: no config mutation may survive a revert path.
    //
    // Debited by GROSS, not by the user's leg. The budget exists to limit TREASURY OUTFLOW
    // and both legs leave the treasury; debiting only the user's share would let the
    // effective outflow exceed the configured ceiling by the premium.
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
    let new_used = effective_used
        .checked_add(gross_usdc)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    // 7. The two limits, ordered by what they protect.
    //
    // 7a. The global window budget. Exceeding it now REVERTS: there is no queue to fall back
    // to. The caller can retry once the window rolls; the admin can raise the budget (a
    // loosening, so 24h-timelocked and guardian-cancellable) or cut it instantly in an
    // emergency via emergency_tighten_redeem_limits.
    require!(
        new_used <= config.instant_redeem_budget_usdc,
        DominionError::RedeemLimitExceeded
    );

    // 7b. Solvency: "the limit is treasury availability". Covers the SUM of both legs.
    // Checking only the user's leg would let the premium transfer overdraw the treasury and
    // fail deep inside the CPI sequence instead of here with a clear error.
    //
    // The float (D7 option a) is deliberately NOT subtracted: it gates the ADMIN's
    // withdrawal, so a user redeeming comes ahead of the admin's ability to move cash out.
    let treasury_balance = ctx.accounts.usdc_treasury.amount;
    require!(
        treasury_balance >= gross_usdc,
        DominionError::InsufficientTreasury
    );

    // 8. Commit the window BEFORE the CPIs. Atomic: any CPI failure reverts this write along
    // with everything else. Anchor the window to `now` on the first redemption after expiry.
    if window_expired {
        config.instant_window_start = now;
    }
    config.instant_used_usdc = new_used;

    // 9. Dust-filter price update (feeds the circuit breaker; D38). Uses the pre-premium
    // oracle value, which is exactly `gross_usdc`, so the V1 dust threshold keeps its
    // original meaning and nothing has to be recomputed.
    maybe_update_last_price(config, oracle_price, gross_usdc, now);

    // 10. CPIs. Burn SILV from user.
    silv_burn_from_user(
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.user_silv_ata.to_account_info(),
        ctx.accounts.user.to_account_info(),
        amount_silv,
        ctx.accounts.silv_mint.decimals,
    )?;

    // Both USDC legs come out of the treasury and are signed by the same PDA. Together they
    // total `gross_usdc`, which is what step 7b verified the treasury can cover.
    let bump = ctx.bumps.treasury_pda;
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // Leg 1: treasury -> user. The redemption proper.
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

    // Leg 2: treasury -> fee vault. The premium.
    //
    // Skipped entirely at zero rather than transferring 0, same as on the mint side: legal
    // but wasteful, and it would log a line on every redemption by an exempt wallet.
    //
    // Ordered AFTER the user's leg deliberately. Both are in one transaction so neither can
    // land alone, but if a future change ever splits them, the user being paid first is the
    // failure mode to prefer.
    if fee_usdc > 0 {
        usdc_transfer_treasury_to_fee_vault(
            ctx.accounts.classic_token_program.to_account_info(),
            ctx.accounts.usdc_treasury.to_account_info(),
            ctx.accounts.fee_vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.treasury_pda.to_account_info(),
            signer_seeds,
            fee_usdc,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    // 11. Event.
    emit!(RedeemEvent {
        user: user_key,
        amount_silv,
        // NET, i.e. what the user received. The treasury paid amount_usdc + fee_usdc.
        amount_usdc: to_user_usdc,
        price_used_scaled: oracle_price,
        // The EFFECTIVE premium, not config.premium_bps_redeem: 0 means the caller used a
        // redeem-side fee exemption.
        premium_bps_used: premium_bps,
        fee_usdc,
        timestamp: now,
    });

    Ok(())
}
