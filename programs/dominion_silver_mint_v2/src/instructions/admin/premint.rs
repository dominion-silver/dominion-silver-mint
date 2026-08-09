// admin_premint + set_inventory_wallet: the launch supply model. The admin mints
// SILV against the hard supply cap into the inventory wallet with NO USDC and NO
// oracle, a 1:1 mint against the physical allocation the cap represents. Public
// direct mint is closed at launch, so this is the only mint path.

// ROUND 7: the redirect-then-premint pair is CLOSED. This header used to say "Phase 1 should
// timelock the setter", and both auditors independently said phase 1 was now. Changing an
// already-bound inventory wallet goes through propose_set_inventory_wallet + 24h + execute, so a
// guardian sees a redirect a day before any supply can land in the new wallet. The FIRST binding is
// still instant, deliberately: with the field unset `admin_premint` refuses, so there is nothing to
// redirect. See set_inventory_wallet_handler below.
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

#[derive(Accounts)]
pub struct SetInventoryWallet<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,
    pub admin: Signer<'info>,
}

/// Admin BINDS the pre-mint destination owner, once. Required before the first `admin_premint`.
///
/// ROUND 7, SolidProof condition 4 and Codex condition 3. This used to be instant in both directions,
/// which made the pair `set_inventory_wallet(attacker)` + `admin_premint(remaining headroom)` a single
/// block with no delay and no veto. Both auditors called that untenable for mainnet while a premint
/// capability exists. The hard cap bounds the size of the theft; it provides no window in which anyone
/// could see it coming.
///
/// WHY THE FIRST BINDING STAYS INSTANT, and why that is not the same hole. The attack is a REDIRECT:
/// it needs a wallet already bound and supply worth diverting. While the field is still the default,
/// `admin_premint` refuses outright (`InventoryWalletNotSet`), so there is nothing to redirect and
/// nothing to steal. Making the first bind wait 24h would add a dead day to a ceremony that moves real
/// funds, and a longer ceremony is one with more room for mistakes. This is a deliberate deviation
/// from the letter of the condition, and it is disclosed as one.
pub fn set_inventory_wallet_handler(
    ctx: Context<SetInventoryWallet>,
    wallet: Pubkey,
) -> Result<()> {
    require!(
        wallet != Pubkey::default(),
        DominionError::InventoryWalletNotSet
    );
    require!(
        ctx.accounts.config.inventory_wallet == Pubkey::default(),
        DominionError::InventoryWalletChangeRequiresTimelock
    );
    let old_wallet = ctx.accounts.config.inventory_wallet;
    ctx.accounts.config.inventory_wallet = wallet;
    // The event is load-bearing, not decoration: an instant redirect cannot be
    // blocked, so a monitor has to be able to alert on one it did not authorize.
    emit!(InventoryWalletChanged {
        old_wallet,
        new_wallet: wallet,
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}
