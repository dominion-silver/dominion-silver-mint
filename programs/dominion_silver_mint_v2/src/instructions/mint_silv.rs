// mint_silv: user sends USDC, receives SILV at Pyth oracle * (1 + premium_bps_mint/10000).
// Option B (CONFIRMED_SPEC.md Section 4.2): the Option A daily cap + on-chain
// reserve are replaced by a single HARD supply cap (D2). Mint always brings
// USDC in; SILV is backed by physical silver in custody (off-chain), so there
// is no on-chain solvency invariant. Launch discount = admin lowers
// premium_bps_mint via the timelocked setter (D4), no special logic here.

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

    // --- Premium destination (Thomas, 2026-08-05) ---
    //
    // The vault is the ASSOCIATED TOKEN ACCOUNT of the fee_vault PDA, so it is fully
    // derivable and deliberately NOT stored in ConfigAccount (see FEE_VAULT_SEED).
    //
    // Deliberately NOT `init_if_needed`: it is created once at deploy time by a script. Two
    // reasons. Making the first minter pay its rent would be a surprise, and an
    // `init_if_needed` on an account the user does not own is an attack surface. Requiring
    // it to pre-exist is safe here in a way it would not be for a plain wallet destination,
    // because a PDA-owned ATA can never be CLOSED: closing needs the owner's signature and
    // this program never signs a CloseAccount for this PDA. So it must exist once, and after
    // that it always will.
    /// CHECK: PDA authority of the fee vault. It never signs on this path (the vault only
    /// receives here); it signs only in withdraw_fees.
    #[account(seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault_pda: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = fee_vault_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

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

    // --- Optional per-wallet flags (2026-08-05) ---
    //
    // Both are PDA-seeded FROM `user`, so neither can be presented on somebody else's
    // behalf: there is nothing to spoof, and no ownership check beyond the seeds is needed.
    //
    // Both are OPTIONAL, and in both cases omitting the account yields the SAFE default:
    // no exemption means the full premium is charged, and no attestation means the action is
    // denied if the KYC gate is armed. A client that forgets to pass them can lose a
    // discount or be refused, never gain a privilege.
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

    // 1. Pause checks (immutable config reads; &mut taken after the oracle read
    //    so the Lazer verify accounts can be borrowed disjointly).
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    // Launch spec 2026-07: public direct mint is CLOSED at launch (the admin
    // pre-mint is the only mint path; users buy on the DEX). This gate is before
    // the oracle read, so the price oracle is dormant while public mint is closed.
    // Public mint opens together with the KYC gate in Phase 1.
    require!(
        ctx.accounts.config.public_mint_enabled,
        DominionError::PublicMintDisabled
    );
    // 2. Mint-specific pause (D30 front-run defense). CODEX P2-01: gate on the
    // pending premium-mint proposal itself, not just `mint_paused_until`
    // (= executable_at). Otherwise, once the 24h elapses but before the admin
    // executes/cancels, mints would resume at the OLD premium while a change
    // is executable - a front-run window. The nonce is cleared on BOTH execute
    // and cancel, so this closes the window with no gap. The time check is
    // kept as belt-and-suspenders / UI signal.
    require!(
        now >= ctx.accounts.config.mint_paused_until,
        DominionError::MintPaused
    );
    require!(
        ctx.accounts.config.pending_premium_mint_nonce.is_none(),
        DominionError::MintPaused
    );

    // 2b. KYC gate. DORMANT at launch: `kyc_scope_flags == 0` admits everyone, which is why
    // "mint at launch without KYC" needs no special casing here.
    //
    // Checked BEFORE the oracle read on purpose. The Lazer verify CPI costs the caller a
    // fee, and somebody who cannot pass the gate should not pay it to find out.
    let user_key = ctx.accounts.user.key();
    enforce_kyc(
        ctx.accounts.config.kyc_scope_flags,
        Side::Mint,
        ctx.accounts.kyc.as_deref(),
        &user_key,
    )?;

    // 3. Zero-amount guard. (Per-tx min/max + daily caps removed in Option B;
    // the HARD supply cap below is the sole mint-side limit, D2.)
    require!(amount_usdc > 0, DominionError::ZeroAmount);

    // 4. Read SILV price from Lazer (verify CPI via the isolated fee-payer PDA,
    //    parse the returned payload, apply the 5.4-5.6 policy). The user funds
    //    the PDA but is NEVER passed to the Lazer CPI.
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
    // 5.4: advance the non-decreasing high-water mark on this accepted read.
    config.last_used_feed_update_timestamp_us = price_result.feed_update_timestamp_us;

    // 5. Price-delta circuit breaker.
    check_price_delta(config, oracle_price, now)?;

    // 6. Runtime SILV mint extension + authority assertions.
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // 7. Fee split, then price at PURE SPOT (Thomas, 2026-08-05).
    //
    // The premium comes OFF THE TOP of the incoming USDC and is routed to the fee vault;
    // SILV is minted on the NET at the raw oracle price. This replaces pricing through a
    // marked-up `effective_mint_price_scaled`, for two reasons documented in
    // math.rs::fee_from_amount:
    //
    //   - the old form produced no fee AMOUNT to route. The user's whole payment went to the
    //     treasury and they simply received less SILV, so the fee existed as under-issuance
    //     rather than as money. Sending premium revenue anywhere needs an explicit amount.
    //   - "1%" now means 1% of what the user sends, on both sides. The old mint form charged
    //     1% of the NET, i.e. 0.9901% of the gross: a 1 bp discrepancy that was invisible and
    //     impossible to explain to anyone.
    //
    // The user's SILV is unchanged to within one atomic unit either way. What changed is
    // where the premium ends up.
    let premium_bps = effective_premium_bps(
        config.premium_bps_mint,
        ctx.accounts.fee_exempt.as_deref(),
        &user_key,
        Side::Mint,
        // A6: an exemption can carry an expiry. An EXPIRED one silently stops applying and the
        // caller pays the full premium, rather than reverting: a lapsed commercial arrangement
        // must not become a broken product for that wallet.
        now,
    );
    // A5: with routing OFF, the premium stays in the treasury (the pre-2026-08-05 behaviour) and
    // NO fee amount is carved out at all. Setting `fee_usdc` to zero is what makes the whole
    // downstream path fall back cleanly: the treasury receives the gross, no fee CPI runs, and a
    // frozen or otherwise unusable fee vault stops mattering.
    //
    // The user's SILV changes, deliberately and in their favour by the premium, because the SILV is
    // minted on the net. That is correct for a fallback whose purpose is to keep the product
    // working: it forgoes revenue rather than charging a fee it cannot route.
    let fee_usdc = if config.fee_routing_enabled {
        fee_from_amount(amount_usdc, premium_bps)?
    } else {
        0
    };
    // `fee_from_amount` is proven never to exceed its input (math.rs), so this cannot
    // underflow. Checked anyway: an unchecked subtraction here would wrap into a colossal
    // net on any future change to that guarantee.
    let net_usdc = amount_usdc
        .checked_sub(fee_usdc)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(net_usdc > 0, DominionError::ZeroAmount);
    let silv_out = mint_silv_out(net_usdc, oracle_price)?;
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
    // 11a. USDC: user -> treasury. The BACKING leg, net of premium. The treasury now
    // receives exactly what backs the SILV just issued, with no premium mixed in.
    usdc_transfer_user_to_treasury(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.user_usdc_ata.to_account_info(),
        ctx.accounts.usdc_treasury.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.user.to_account_info(),
        net_usdc,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // 11a-bis. USDC: user -> fee vault. The REVENUE leg.
    //
    // Skipped entirely at zero rather than transferring 0: a zero-amount transfer_checked is
    // legal but burns compute and writes a log line on every single mint by an exempt wallet.
    //
    // Both legs are in the same transaction as the mint, so there is no state in which the
    // user has paid and received nothing: any failure here reverts the SILV mint too.
    if fee_usdc > 0 {
        usdc_transfer_user_to_fee_vault(
            ctx.accounts.classic_token_program.to_account_info(),
            ctx.accounts.user_usdc_ata.to_account_info(),
            ctx.accounts.fee_vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.user.to_account_info(),
            fee_usdc,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

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
        user: user_key,
        // GROSS, i.e. what the user authorised. net = amount_usdc - fee_usdc.
        amount_usdc,
        amount_silv: silv_out,
        price_used_scaled: oracle_price,
        // The EFFECTIVE premium, not config.premium_bps_mint: 0 here means the caller used a
        // mint-side fee exemption. This is the field to read when auditing whitelist usage.
        premium_bps_used: premium_bps,
        fee_usdc,
        timestamp: now,
    });

    Ok(())
}
