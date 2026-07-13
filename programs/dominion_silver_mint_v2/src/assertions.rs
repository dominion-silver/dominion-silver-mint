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
    transfer_hook::TransferHook, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
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
    // every call. Init pins the mint_authority to the silv_mint_authority PDA and the
    // freeze_authority to config.freeze_authority_expected (the compliance multisig,
    // launch spec 2026-07). The program PDA controls mint_authority; the freeze
    // authority is a permanent Token-2022 power fixed at mint creation.
    // Runtime check makes drift impossible to miss.
    let (silv_mint_auth_pda, _) =
        Pubkey::find_program_address(&[SILV_MINT_AUTHORITY_SEED], program_id);
    let mint_authority_opt: Option<Pubkey> = silv_mint_account.mint_authority.into();
    require!(
        mint_authority_opt == Some(silv_mint_auth_pda),
        DominionError::SilvMintAuthorityMismatch
    );
    // Freeze authority MUST equal config.freeze_authority_expected (launch spec
    // 2026-07: Mark confirmed he wants BOTH compliance levers). The SILV mint carries
    // a freeze authority (block/thaw a sanctioned wallet, OFAC/court order) in addition
    // to the PermanentDelegate (seize/clawback). initialize.rs pins the freeze
    // authority to the expected compliance multisig (!= default) at mint creation, and
    // no program instruction changes it; freezing/thawing a specific token account is
    // done directly via the SPL Token-2022 FreezeAccount/ThawAccount by the multisig,
    // which does NOT change this mint-level authority. Runtime check makes drift
    // impossible to miss (mirrors the PermanentDelegate pin below).
    // NOTE: the earlier launch batch pinned this strictly to None (FIX E). That was
    // reversed once Mark confirmed the freeze lever; both authorities are permanent
    // Token-2022 powers fixed at mint creation.
    let freeze_authority_opt: Option<Pubkey> = silv_mint_account.freeze_authority.into();
    require!(
        freeze_authority_opt == Some(config.freeze_authority_expected),
        DominionError::SilvFreezeAuthorityMismatch
    );

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

    // CODEX P1-03: strict allowlist at runtime too (defense in depth vs the
    // init-time check). The SILV mint may carry ONLY MetadataPointer +
    // TokenMetadata + PermanentDelegate. Subsumes the explicit
    // TransferHook/TransferFee rejects above (kept for clearer errors) and
    // also catches MintCloseAuthority / DefaultAccountState / NonTransferable
    // / InterestBearingConfig / ConfidentialTransfer / Group* / etc.
    let ext_types = mint_with_ext
        .get_extension_types()
        .map_err(|_| error!(DominionError::WrongMint))?;
    for et in ext_types.iter() {
        require!(
            matches!(
                et,
                ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
                    | ExtensionType::PermanentDelegate
            ),
            DominionError::DisallowedMintExtension
        );
    }

    Ok(())
}
