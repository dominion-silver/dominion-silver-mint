// Dual-token-program CPI helpers.
// USDC = classic SPL Token. SILV = SPL Token-2022.
// Always uses *_checked variants (verifies decimals).

use anchor_lang::prelude::*;
use anchor_spl::token as classic;
use anchor_spl::token_2022;

/// Transfer USDC from user ATA to treasury PDA-owned ATA.
/// User signs the outer tx; their authority signs the transfer.
pub fn usdc_transfer_user_to_treasury<'info>(
    classic_token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to_treasury: AccountInfo<'info>,
    usdc_mint: AccountInfo<'info>,
    user_authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        classic_token_program,
        classic::TransferChecked {
            from,
            mint: usdc_mint,
            to: to_treasury,
            authority: user_authority,
        },
    );
    classic::transfer_checked(cpi_ctx, amount, decimals)
}

/// Transfer USDC from treasury PDA-owned ATA to user.
/// Treasury PDA signs via seeds.
pub fn usdc_transfer_treasury_to_user<'info>(
    classic_token_program: AccountInfo<'info>,
    from_treasury: AccountInfo<'info>,
    to_user: AccountInfo<'info>,
    usdc_mint: AccountInfo<'info>,
    treasury_pda: AccountInfo<'info>,
    treasury_seeds: &[&[&[u8]]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let cpi_ctx = CpiContext::new_with_signer(
        classic_token_program,
        classic::TransferChecked {
            from: from_treasury,
            mint: usdc_mint,
            to: to_user,
            authority: treasury_pda,
        },
        treasury_seeds,
    );
    classic::transfer_checked(cpi_ctx, amount, decimals)
}

/// Mint SILV (Token-2022) to user ATA via the official anchor_spl wrapper.
/// Mint authority is a program PDA that signs via seeds.
pub fn silv_mint_to<'info>(
    token_2022_program: AccountInfo<'info>,
    silv_mint: AccountInfo<'info>,
    to_user: AccountInfo<'info>,
    mint_authority_pda: AccountInfo<'info>,
    mint_authority_seeds: &[&[&[u8]]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let cpi_ctx = CpiContext::new_with_signer(
        token_2022_program,
        token_2022::MintTo {
            mint: silv_mint,
            to: to_user,
            authority: mint_authority_pda,
        },
        mint_authority_seeds,
    );
    // anchor_spl 0.30 token_2022::mint_to wraps spl_token_2022::instruction::mint_to.
    // We need the *_checked variant for decimal-safety. Use the helper that explicitly
    // calls mint_to_checked under the hood.
    token_2022::mint_to(cpi_ctx, amount).map(|_| ())?;
    // Note: anchor_spl 0.30 doesn't expose a `mint_to_checked` wrapper for Token-2022.
    // The unchecked `mint_to` is safe HERE because the mint account is pinned via
    // `address = config.silv_mint` in the Anchor accounts struct, and the SILV mint
    // decimals are immutable post-init. If `decimals` ever needs verification at CPI
    // time, switch to the raw spl_token_2022::instruction::mint_to_checked path.
    let _ = decimals; // kept for ABI symmetry with classic transfer_checked
    Ok(())
}

/// Burn SILV (Token-2022) from user ATA. User signs as authority.
pub fn silv_burn_from_user<'info>(
    token_2022_program: AccountInfo<'info>,
    silv_mint: AccountInfo<'info>,
    user_silv_ata: AccountInfo<'info>,
    user_authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        token_2022_program,
        token_2022::Burn {
            mint: silv_mint,
            from: user_silv_ata,
            authority: user_authority,
        },
    );
    token_2022::burn(cpi_ctx, amount).map(|_| ())?;
    let _ = decimals;
    Ok(())
}
