// CODEX H-02: thaw_account is DISABLED. See lib.rs comment block.
//
// This file is kept as dead-code reference for the architectural redesign
// once the freeze/thaw model is finalized with the auditor. The original
// design called spl_token_2022::thaw_account with the PermanentDelegate as
// authority, which the SPL program rejects (it requires the mint's
// freeze_authority, not the permanent delegate). Since freeze_authority is
// pinned to None at init (CODEX C-02), there is no working thaw path
// today.
//
// Original docs (now misleading; for redesign reference only):
// thaw_account: D42. Recovers users frozen by PermanentDelegate during
// compliance ON window. Admin signs Token-2022 thaw_account CPI as the
// PermanentDelegate authority via Squads vault.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint as InterfaceMint, Token2022, TokenAccount as InterfaceTokenAccount,
};

use crate::events::AccountThawed;
use crate::state::*;

#[derive(Accounts)]
pub struct ThawAccount<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    #[account(mut, address = config.silv_mint)]
    pub silv_mint: InterfaceAccount<'info, InterfaceMint>,

    // SC-M9: explicit token::mint constraint. The SPL CPI would reject a
    // mint mismatch but checking it here gives a cleaner Anchor error and
    // removes the trust placed in SPL's check (defense in depth).
    #[account(
        mut,
        token::mint = silv_mint,
        token::token_program = token_2022_program,
    )]
    pub silv_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// CHECK: PermanentDelegate authority. Pinned to `config.permanent_delegate_expected`
    /// (Ops Squads vault PDA). Caller arranges signing externally via Squads.
    #[account(address = config.permanent_delegate_expected)]
    pub permanent_delegate_authority: Signer<'info>,

    #[account(address = config.token_2022_program)]
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<ThawAccount>) -> Result<()> {
    let ix = spl_token_2022::instruction::thaw_account(
        ctx.accounts.token_2022_program.key,
        &ctx.accounts.silv_account.key(),
        &ctx.accounts.silv_mint.key(),
        ctx.accounts.permanent_delegate_authority.key,
        &[],
    )?;
    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.silv_account.to_account_info(),
            ctx.accounts.silv_mint.to_account_info(),
            ctx.accounts.permanent_delegate_authority.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
    )?;
    emit!(AccountThawed {
        silv_account: ctx.accounts.silv_account.key(),
    });
    Ok(())
}
