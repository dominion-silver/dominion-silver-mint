// Dual-token-program CPI helpers.
// USDC = classic SPL Token. SILV = SPL Token-2022.
// USDC transfers use the *_checked variant (transfer_checked).
// SILV mint/burn intentionally use the UNCHECKED Token-2022 CPI (anchor_spl
// 0.31 exposes no Token-2022 *_checked wrapper) - safe because the SILV mint
// is `address`-pinned in every Accounts struct and its decimals are pinned to
// 6 at init and immutable. See the per-fn comments below.

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

// ---------------------------------------------------------------------------
// Premium routing (, 2026-08-05). Three wrappers, mechanically identical to the two
// above, kept SEPARATE and named for their destination rather than folded into a generic
// `usdc_transfer`.
// The reason is that this file's whole purpose is to make the money flow readable at the
// CALL SITE. `usdc_transfer_user_to_treasury(...)` next to
// `usdc_transfer_user_to_fee_vault(...)` inside mint_silv says exactly what the split does.
// A single generic helper called twice with different account arguments would hide the one
// thing a reviewer needs to check: that the backing leg and the revenue leg go to different
// accounts.
// ---------------------------------------------------------------------------

/// Transfer the MINT premium from the user's USDC ATA to the program-owned fee vault.
/// The other leg of the same split is `usdc_transfer_user_to_treasury`, which carries the
/// net. Together they must sum to exactly what the user authorised.
pub fn usdc_transfer_user_to_fee_vault<'info>(
    classic_token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to_fee_vault: AccountInfo<'info>,
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
            to: to_fee_vault,
            authority: user_authority,
        },
    );
    classic::transfer_checked(cpi_ctx, amount, decimals)
}

/// Transfer the REDEEM premium from the treasury to the fee vault. Treasury PDA signs.
/// Note what this means for treasury outflow, because it is the one non-obvious
/// consequence of routing fees out: on redemption the treasury now pays the FULL spot value
/// of the burned SILV, split between the user and this vault. Before routing it paid only
/// the user's share and kept the premium. The solvency check must therefore cover the sum,
/// not just the user's leg.
pub fn usdc_transfer_treasury_to_fee_vault<'info>(
    classic_token_program: AccountInfo<'info>,
    from_treasury: AccountInfo<'info>,
    to_fee_vault: AccountInfo<'info>,
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
            to: to_fee_vault,
            authority: treasury_pda,
        },
        treasury_seeds,
    );
    classic::transfer_checked(cpi_ctx, amount, decimals)
}

/// Sweep accrued premium out of the fee vault to an admin-chosen destination.
/// This is the ONLY path out of the vault, and the fee-vault PDA signs it. The destination
/// is an instruction argument rather than stored config, so a wrong address costs one
/// misdirected sweep instead of breaking mint and redeem (which is what a stored, wrong fee
/// destination would do, since the fee transfer happens inside those instructions).
pub fn usdc_transfer_fee_vault_to_destination<'info>(
    classic_token_program: AccountInfo<'info>,
    from_fee_vault: AccountInfo<'info>,
    to_destination: AccountInfo<'info>,
    usdc_mint: AccountInfo<'info>,
    fee_vault_pda: AccountInfo<'info>,
    fee_vault_seeds: &[&[&[u8]]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let cpi_ctx = CpiContext::new_with_signer(
        classic_token_program,
        classic::TransferChecked {
            from: from_fee_vault,
            mint: usdc_mint,
            to: to_destination,
            authority: fee_vault_pda,
        },
        fee_vault_seeds,
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
    // this calls the UNCHECKED `token_2022::mint_to` (anchor_spl
    // 0.31 exposes no Token-2022 `mint_to_checked` wrapper). It is safe HERE
    // and only here because: (a) the SILV mint is `address = config.silv_mint`
    // pinned in every Accounts struct, and (b) SILV decimals are pinned to 6
    // at init and immutable, so the decimal-confusion class the `_checked`
    // variant guards against is unreachable in the fresh-deploy model. If that
    // assumption ever changes, switch to the raw
    // spl_token_2022::instruction::mint_to_checked path.
    token_2022::mint_to(cpi_ctx, amount).map(|_| ())?;
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
    // unchecked `burn` (no Token-2022 `burn_checked` wrapper in
    // anchor_spl 0.31). Safe for the same reason as mint_to above: SILV mint is
    // address-pinned and decimals are init-pinned to 6 and immutable.
    token_2022::burn(cpi_ctx, amount).map(|_| ())?;
    let _ = decimals;
    Ok(())
}
