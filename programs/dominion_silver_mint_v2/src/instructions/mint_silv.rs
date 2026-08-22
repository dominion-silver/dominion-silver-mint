// mint_silv: USDC in, the premium comes OFF THE TOP, SILV is minted on the remainder at PURE SPOT.
//   fee      = ceil(amount_usdc * premium_bps_mint / 10_000)     (math.rs::fee_from_amount)
//   silv_out = (amount_usdc - fee) / spot
// So the all-in price a minter pays per ounce is `spot / (1 - bps/1e4)`, NOT `spot * (1 + bps/1e4)`.
// The two differ by bps^2/1e8, 1bp at the launch 1% and 25bp at the 500bp ceiling, and the public
// client mirrors this formula: do not paraphrase it as a marked-up price.
// The premium is ALWAYS charged; only its DESTINATION is conditional on `fee_routing_disabled`.
// Supply is bounded by one HARD cap; SILV is backed off-chain, so no on-chain solvency invariant.

use crate::assertions::assert_silv_mint_invariants;
use crate::cpi::{silv_mint_to, usdc_transfer_user_to_fee_vault, usdc_transfer_user_to_treasury};
use crate::errors::DominionError;
use crate::events::MintEvent;
use crate::lazer_cpi::{LazerVerifyAccounts, LAZER_FEE_PAYER_SEED};
use crate::math::*;
use crate::oracle::{check_price_delta, maybe_update_last_price, read_silver_price_lazer};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{
    Mint as InterfaceMint, Token2022, TokenAccount as InterfaceTokenAccount,
};

#[derive(Accounts)]
#[instruction(amount_usdc: u64, min_silv_out: u64)]
pub struct MintSilv<'info> {
    // BPF stack frame is 4 KB and ConfigAccount alone is ~1 KB: box every sizable account or the
    // struct overflows it (devnet: "Access violation in stack frame 5").
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

    // Premium destination: the ATA of the fee_vault PDA, derivable and so NOT stored in config.
    // Deliberately NOT `init_if_needed` (a deploy script creates it once), which is safe only because
    // a PDA-owned ATA can never be CLOSED: this program never signs a CloseAccount for this PDA.
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
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = classic_token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = silv_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_silv_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// CHECK: PDA derived deterministically; signs SILV mint via seeds.
    #[account(seeds = [SILV_MINT_AUTHORITY_SEED], bump)]
    pub silv_mint_authority: AccountInfo<'info>,

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
    ctx: Context<MintSilv>,
    amount_usdc: u64,
    min_silv_out: u64,
    message_data: Vec<u8>,
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 1. Pause checks. &mut config comes after the oracle read (disjoint borrows).
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    // Public direct mint is CLOSED at launch: pre-mint is the only path, users buy on the DEX.
    require!(
        ctx.accounts.config.public_mint_enabled,
        DominionError::PublicMintDisabled
    );
    // 2. Mint pause (front-run defence). BOTH checks are needed: between the 24h elapsing and the
    // admin executing or cancelling, the time check alone would resume mints at the OLD premium.
    require!(
        now >= ctx.accounts.config.mint_paused_until,
        DominionError::MintPaused
    );
    require!(
        ctx.accounts.config.pending_premium_mint_nonce.is_none(),
        DominionError::MintPaused
    );

    // 2b. KYC gate, dormant at launch (`kyc_scope_flags == 0`). `enforce_kyc` must be called on BOTH
    // sides (redeem side: redeem_silv.rs step 1b). Before the oracle read, so a failure costs no fee.
    let user_key = ctx.accounts.user.key();
    enforce_kyc(
        ctx.accounts.config.kyc_scope_flags,
        Side::Mint,
        ctx.accounts.kyc.as_deref(),
        &user_key,
    )?;

    // 3. Zero-amount guard. The HARD supply cap below is the sole mint-side VALUE limit.
    require!(amount_usdc > 0, DominionError::ZeroAmount);

    // 3b. , the AVAILABILITY floor. The redeem side has the matching check at
    // `redeem_silv.rs` step 4b; one field, `config.min_operation_usdc`, governs both, because the slot
    // it protects is shared.
    // It sits here rather than after the oracle read for one reason and it is NOT a safety one: the
    // whole transaction reverts either way, so the Lazer fee and the high-water write are rolled back
    // identically wherever this check lives. It is here because `amount_usdc` is already known, so a
    // dust caller is refused before the CPI rather than after it, which costs them the verify fee and
    // costs us the compute. The redeem side cannot do the same, because the size of a redeem is only
    // known once the price is read.
    // made the anti-replay strict, which turned `last_used_feed_update_timestamp_us` into one
    // global slot in a writable config: whoever consumes a print blocks every other operation until
    // the next one. Measured with no floor, at $58.34/oz and 100 bps, 60 micro-USDC was enough to
    // take that slot and still receive SILV, so the invariant that stops a REPLAY was simultaneously
    // a permissionless denial primitive. The floor is what makes capture cost working capital rather
    // than dust; the derivation is on `ConfigAccount::min_operation_usdc` and pinned by a unit test.
    // Zero disables it, which is what an in-place upgrade of an existing config decodes.
    require!(
        amount_usdc >= ctx.accounts.config.min_operation_usdc,
        DominionError::OperationBelowMinimum
    );

    // 4. Read SILV price from Lazer. The user funds the fee-payer PDA but is NEVER passed to the CPI.
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
    // Advance the non-decreasing feed-timestamp high-water mark on this accepted read (5.4).
    config.last_used_feed_update_timestamp_us = price_result.feed_update_timestamp_us;

    check_price_delta(config, oracle_price, now)?;

    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 7. Fee split, then price at PURE SPOT rather than through a marked-up rate: a marked-up rate
    // yields no fee AMOUNT to route, and "1%" here means 1% of what the user sends, not of the net.
    let premium_bps = effective_premium_bps(
        config.premium_bps_mint,
        ctx.accounts.fee_exempt.as_deref(),
        &user_key,
        Side::Mint,
        // An EXPIRED exemption silently stops applying: full premium, no revert.
        now,
    );
    // The premium is ALWAYS charged; only its DESTINATION follows the escape hatch. Keep `net` net of
    // it in both modes: zeroing the fee when routing is off would mint on the FULL amount and hand the
    // premium to the minter, a global fee waiver routing around the 24h timelock on premium changes.
    let fee_usdc = fee_from_amount(amount_usdc, premium_bps)?;
    // `fee_from_amount` CEILS and never exceeds its input (math.rs); the dust rounds to the protocol.
    let net_usdc = amount_usdc
        .checked_sub(fee_usdc)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(net_usdc > 0, DominionError::ZeroAmount);
    let silv_out = mint_silv_out(net_usdc, oracle_price)?;
    require!(silv_out > 0, DominionError::ZeroAmount);

    require!(silv_out >= min_silv_out, DominionError::SlippageExceeded);

    // 9. HARD supply cap, in atomic SILV (oz * 1e6). `supply` is the pre-CPI circulating supply.
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

    // 10. Dust-filter price update (feeds the circuit breaker; ). The two legs below always sum to
    // `amount_usdc`: only the premium's DESTINATION is conditional (step 7).
    maybe_update_last_price(config, oracle_price, amount_usdc, now);

    let fee_routed = if config.fee_routing_disabled {
        0
    } else {
        fee_usdc
    };
    let to_treasury = amount_usdc
        .checked_sub(fee_routed)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    // 11a. The BACKING leg: net of the premium with routing ON, the full amount with it OFF.
    usdc_transfer_user_to_treasury(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.user_usdc_ata.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.user.to_account_info(),
        to_treasury,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // 11a-bis. The REVENUE leg. Skipped at zero rather than logging a 0-transfer on every mint by an
    // exempt wallet. Same transaction as the mint, so the user can never pay and receive nothing.
    if fee_routed > 0 {
        usdc_transfer_user_to_fee_vault(
            ctx.accounts.classic_token_program.to_account_info(),
            ctx.accounts.user_usdc_ata.to_account_info(),
            ctx.accounts.fee_vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.user.to_account_info(),
            fee_routed,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

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

    emit!(MintEvent {
        user: user_key,
        // GROSS, what the user authorised. net = amount_usdc - fee_usdc.
        amount_usdc,
        amount_silv: silv_out,
        price_used_scaled: oracle_price,
        // The EFFECTIVE premium: 0 means a mint-side exemption. Read this to audit whitelist usage.
        premium_bps_used: premium_bps,
        // What the VAULT received. (premium_bps_used > 0, fee_usdc == 0) is "charged but not routed".
        fee_usdc: fee_routed,
        timestamp: now,
    });

    Ok(())
}
