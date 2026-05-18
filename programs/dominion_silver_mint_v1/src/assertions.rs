// Runtime assertions on the SILV mint, run on every user instruction.
// Defends against future upgrades silently enabling dangerous Token-2022 extensions.
//
// CODEX C-02 strengthens: also asserts the base mint authorities each call.
// Init time enforces these too (one-shot), but defense-in-depth catches any
// theoretical drift across upgrades.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint as InterfaceMint;
use spl_token_2022::extension::{
    permanent_delegate::PermanentDelegate, transfer_fee::TransferFeeConfig,
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use spl_token_2022::state::Mint as Token2022Mint;

use crate::errors::DominionError;
use crate::state::{ConfigAccount, SILV_MINT_AUTHORITY_SEED};

/// Verify SILV mint extensions + base authorities match config invariants.
/// Reads the raw mint account data and walks Token-2022 extension TLV blocks.
pub fn assert_silv_mint_invariants(
    silv_mint_account: &InterfaceAccount<InterfaceMint>,
    config: &ConfigAccount,
    program_id: &Pubkey,
) -> Result<()> {
    // CODEX C-02 defense-in-depth: assert base mint_authority + freeze_authority
    // every call. Init pins these to the silv_mint_authority PDA + None
    // respectively; they cannot change post-init given how the mint is set up
    // (program PDA controls mint_authority; freeze_authority None is permanent).
    // Runtime check makes drift impossible to miss.
    let (silv_mint_auth_pda, _) =
        Pubkey::find_program_address(&[SILV_MINT_AUTHORITY_SEED], program_id);
    let mint_authority_opt: Option<Pubkey> = silv_mint_account.mint_authority.into();
    require!(
        mint_authority_opt == Some(silv_mint_auth_pda),
        DominionError::SilvMintAuthorityMismatch
    );
    // Runtime check accepts EITHER None (target/strict) OR the silv_mint_authority
    // PDA (current devnet state, since the off-chain init script set both authorities
    // to the PDA rather than leaving freeze_authority None). PDA-held freeze authority
    // is dead unless a program upgrade exposes a freeze ix; the program currently
    // exposes no such ix. This is documented in REVIEW_REPORT.md (CODEX H-02 / C-02).
    // Rejects anything else (e.g., deployer keypair = drift from intended state).
    let freeze_authority_opt: Option<Pubkey> = silv_mint_account.freeze_authority.into();
    let freeze_ok = match freeze_authority_opt {
        None => true,
        Some(k) => k == silv_mint_auth_pda,
    };
    require!(freeze_ok, DominionError::SilvFreezeAuthorityMustBeNone);

    let mint_ai = silv_mint_account.to_account_info();
    let data = mint_ai.try_borrow_data()?;
    let mint_with_ext = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(DominionError::WrongMint))?;

    // PermanentDelegate must equal config.permanent_delegate_expected (which init guarantees != default).
    let perm = mint_with_ext.get_extension::<PermanentDelegate>();
    match perm {
        Ok(p) => {
            // OptionalNonZeroPubkey deref to Option<Pubkey> for safe Some/None handling.
            let on_chain_opt: Option<Pubkey> = Option::<Pubkey>::from(p.delegate);
            let on_chain = on_chain_opt.unwrap_or_default();
            require!(
                on_chain == config.permanent_delegate_expected,
                DominionError::PermanentDelegateMismatch
            );
        }
        Err(_) => {
            // Extension missing on a SILV mint that should always have it: hard fail.
            // (config.permanent_delegate_expected is asserted non-default at initialize.)
            return Err(error!(DominionError::PermanentDelegateMismatch));
        }
    }

    // TransferHook must NOT be enabled. Reject extension presence regardless of program_id
    // (defense in depth: even a hook with program_id=default is still an enabled extension).
    if mint_with_ext.get_extension::<TransferHook>().is_ok() {
        return Err(error!(DominionError::TransferHookUnexpected));
    }

    // TransferFee must NOT be enabled.
    if mint_with_ext.get_extension::<TransferFeeConfig>().is_ok() {
        return Err(error!(DominionError::TransferFeeUnexpected));
    }

    Ok(())
}
