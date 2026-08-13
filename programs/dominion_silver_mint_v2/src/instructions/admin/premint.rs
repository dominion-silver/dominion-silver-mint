// admin_premint: the launch supply model. The admin mints SILV against the hard supply cap into the
// inventory wallet with NO USDC and NO oracle, a 1:1 mint against the physical allocation the cap
// represents.
//
// ROUND 8: the redirect-then-premint pair is CLOSED, and closed by REMOVAL. The destination is an
// argument of `initialize`, bound atomically, and the only writer afterwards is the 24h-timelocked
// `execute_set_inventory_wallet`. The round-7 shape kept the first binding instant and was refuted:
// compromise the Ops key during the ceremony, before the legitimate binding, and there was no delay
// and no veto between binding your own wallet and issuing the cap into it.
//
// WHAT THIS DOES NOT PROTECT, and D11 in config/mainnet-authorities.json is the answer to it: tokens
// already held by the LEGITIMATE destination. With redemptions open at launch, whoever holds that
// key can redeem them into treasury USDC with no admin instruction and no timelock. That is a
// custody problem, not a program one, and the decision is to pre-mint only the operational tranche.
//
// admin_premint still does not gate on the dormant `mint_paused` field; whoever wires it must
// include this mint path.

use crate::assertions::assert_silv_mint_invariants;
use crate::cpi::silv_mint_to;
use crate::errors::DominionError;
use crate::events::{InventoryWalletChanged, PremintEvent};
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

    // The handler validates this account's OWNER against config.inventory_wallet, so
    // the destination is the configured inventory wallet, not an arbitrary account.
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

    // Same mint guard as mint_silv.
    assert_silv_mint_invariants(&ctx.accounts.silv_mint, config, ctx.program_id)?;

    // The pre-mint counts toward circulating supply and may not push it above the
    // hard cap (100k oz at launch, the size of the physical allocation).
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

    // PDA-signed mint. No USDC, no premium, no oracle.
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
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ROUND 8 T8-03. `SetInventoryWallet` and its handler are DELETED, not restricted.
//
// The round-7 version kept the first binding instant on the argument that with the field unset there
// was nothing to redirect. Codex refuted it: compromise the Ops key DURING the ceremony, before the
// legitimate binding, and the attacker binds their own wallet, unpauses, and issues the hard cap into
// their ATA with no delay and no veto. "Nothing to steal" confused supply already minted with
// issuance power still available.
//
// The destination is now an argument of `initialize`, bound atomically with everything else, and the
// ONLY remaining writer is `execute_set_inventory_wallet` behind the 24h timelock. Deleting the
// instruction removes the surface instead of moving it, which is why this option was preferred over
// proposing at ceremony step 7 and executing at step 8.
