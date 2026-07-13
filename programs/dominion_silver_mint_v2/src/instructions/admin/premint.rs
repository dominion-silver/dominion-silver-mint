// admin_premint + set_inventory_wallet: the launch supply model (Mark's Telegram,
// 2026-06-30). The admin (Ops Squads) pre-mints SILV against the hard supply cap
// into the inventory wallet, with NO USDC and NO oracle: it is a 1:1 mint against
// the physical allocation the cap represents. The market maker seeds the DEX from
// that inventory, and users buy on the secondary market. Public direct mint is
// CLOSED at launch (mint_silv gates on config.public_mint_enabled), so this admin
// pre-mint is the only mint path at launch. Public mint opens with KYC in Phase 1.
//
// ADMIN-TRUST NOTE (accepted launch risk, flagged in the triple-review): both
// admin_premint and set_inventory_wallet are instant (admin-only, no timelock). A
// compromised Ops-Squads admin can set_inventory_wallet(redirect) + admin_premint up
// to the remaining cap headroom into a redirected wallet in one block. This is BOUNDED
// by the 100k hard cap (SupplyCapRaiseBlocked prevents raising it). The redirected SILV
// CANNOT drain the contract treasury: public redeem is closed and re-enabling it is
// blocked on-chain (RedemptionsEnableBlocked, Codex P0-01 fix), so no redemption can pay
// out treasury USDC. The residual is that the SILV could be dumped on the DEX (the MM's
// pool), bounded by the 100k cap. Matches the launch trust model (the multisig admin is
// trusted to seed inventory). Phase 1 hardening: timelock set_inventory_wallet.
// admin_premint also does not yet gate on the reserved `mint_paused` field (dormant at
// launch); the Phase 1 author must wire it, since pre-mint is a mint path.

use crate::assertions::assert_silv_mint_invariants;
use crate::cpi::silv_mint_to;
use crate::errors::DominionError;
use crate::events::PremintEvent;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint as InterfaceMint, Token2022, TokenAccount as InterfaceTokenAccount,
};

#[derive(Accounts)]
pub struct AdminPremint<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    pub admin: Signer<'info>,

    #[account(mut, address = config.silv_mint)]
    pub silv_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    // The inventory SILV token account. Its owner is validated == config.inventory_wallet
    // in the handler, so the pre-mint destination is the CURRENTLY-CONFIGURED inventory
    // wallet, not an arbitrary account. Note: the admin controls config.inventory_wallet
    // via set_inventory_wallet (instant at launch). See the ADMIN-TRUST note in the file
    // header: a compromised admin can pre-mint remaining cap headroom to a redirected
    // inventory wallet. Bounded by the 100k cap + closed public paths; Phase 1 should
    // timelock set_inventory_wallet.
    #[account(
        mut,
        token::mint = silv_mint,
        token::token_program = token_2022_program,
    )]
    pub inventory_silv_ata: Box<InterfaceAccount<'info, InterfaceTokenAccount>>,

    /// CHECK: PDA derived deterministically; signs the SILV mint via seeds.
    #[account(seeds = [SILV_MINT_AUTHORITY_SEED], bump)]
    pub silv_mint_authority: AccountInfo<'info>,

    #[account(address = config.token_2022_program)]
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn premint_handler(ctx: Context<AdminPremint>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;

    require!(amount > 0, DominionError::ZeroAmount);
    require!(!config.paused, DominionError::Paused);
    require!(
        config.inventory_wallet != Pubkey::default(),
        DominionError::InventoryWalletNotSet
    );
    require!(
        ctx.accounts.inventory_silv_ata.owner == config.inventory_wallet,
        DominionError::InvalidInventoryDestination
    );

    // Runtime SILV mint extension + authority assertions (same guard as mint_silv).
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // HARD supply cap: the pre-mint counts toward total circulating supply and
    // cannot push it above the cap (100k oz at launch = the physical allocation).
    let supply_post = ctx
        .accounts
        .silv_mint
        .supply
        .checked_add(amount)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;
    require!(
        supply_post <= config.max_silv_supply,
        DominionError::SupplyCapExceeded
    );

    // Mint SILV to the inventory account (PDA-signed; no USDC, no premium, no oracle).
    let bump = ctx.bumps.silv_mint_authority;
    let seeds: &[&[u8]] = &[SILV_MINT_AUTHORITY_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    silv_mint_to(
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.silv_mint.to_account_info(),
        ctx.accounts.inventory_silv_ata.to_account_info(),
        ctx.accounts.silv_mint_authority.to_account_info(),
        signer_seeds,
        amount,
        ctx.accounts.silv_mint.decimals,
    )?;

    emit!(PremintEvent {
        inventory: config.inventory_wallet,
        amount,
        supply_post,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetInventoryWallet<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
}

/// Admin sets the pre-mint destination owner (instant, late-binding). Required
/// before the first admin_premint.
pub fn set_inventory_wallet_handler(
    ctx: Context<SetInventoryWallet>,
    wallet: Pubkey,
) -> Result<()> {
    require!(
        wallet != Pubkey::default(),
        DominionError::InventoryWalletNotSet
    );
    ctx.accounts.config.inventory_wallet = wallet;
    Ok(())
}
