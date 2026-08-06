// Runtime assertions on the SILV mint, re-run on every user instruction. They are
// a DRIFT DETECTOR, not a permission: initialize.rs pins all of this once, and
// re-checking makes a later silent change fail loudly instead.
//
// Pinned at init and locked afterwards: mint_authority (the silv_mint_authority
// PDA), freeze_authority, PermanentDelegate, absence of TransferHook and
// TransferFee, and an extension set within {MetadataPointer, TokenMetadata,
// PermanentDelegate}.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint as InterfaceMint;
use spl_token_2022::extension::{
    permanent_delegate::PermanentDelegate, transfer_fee::TransferFeeConfig,
    transfer_hook::TransferHook, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022::state::Mint as Token2022Mint;

use crate::errors::DominionError;
use crate::state::{ConfigAccount, SILV_MINT_AUTHORITY_SEED};

/// Verify SILV mint extensions and base authorities against the config.
/// Reads the raw mint account data and walks Token-2022 extension TLV blocks.
pub fn assert_silv_mint_invariants(
    silv_mint_account: &InterfaceAccount<InterfaceMint>,
    config: &ConfigAccount,
    program_id: &Pubkey,
) -> Result<()> {
    let (silv_mint_auth_pda, _) =
        Pubkey::find_program_address(&[SILV_MINT_AUTHORITY_SEED], program_id);
    let mint_authority_opt: Option<Pubkey> = silv_mint_account.mint_authority.into();
    require!(
        mint_authority_opt == Some(silv_mint_auth_pda),
        DominionError::SilvMintAuthorityMismatch
    );
    // freeze_authority and PermanentDelegate are the two compliance levers, both
    // held by an EXTERNAL multisig and never by this program: intentional and
    // disclosed (SILV is not censorship resistant), and unrecoverable if that
    // multisig drops below threshold. Freezing one token account does not touch
    // this mint-level authority, so a change here means the key was rotated.
    // See private/MARK_TOKEN_ACL_DECISION.md.
    let freeze_authority_opt: Option<Pubkey> = silv_mint_account.freeze_authority.into();
    require!(
        freeze_authority_opt == Some(config.freeze_authority_expected),
        DominionError::SilvFreezeAuthorityMismatch
    );

    let mint_ai = silv_mint_account.to_account_info();
    let data = mint_ai.try_borrow_data()?;
    let mint_with_ext = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(DominionError::WrongMint))?;

    // initialize.rs guarantees config.permanent_delegate_expected != default, so a
    // missing extension is a hard fail rather than a match against the default.
    let perm = mint_with_ext.get_extension::<PermanentDelegate>();
    match perm {
        Ok(p) => {
            let on_chain_opt: Option<Pubkey> = Option::<Pubkey>::from(p.delegate);
            let on_chain = on_chain_opt.unwrap_or_default();
            require!(
                on_chain == config.permanent_delegate_expected,
                DominionError::PermanentDelegateMismatch
            );
        }
        Err(_) => {
            return Err(error!(DominionError::PermanentDelegateMismatch));
        }
    }

    // Reject the hook on PRESENCE, not on its program_id: a hook pointing at the
    // default program id is still an enabled extension.
    if mint_with_ext.get_extension::<TransferHook>().is_ok() {
        return Err(error!(DominionError::TransferHookUnexpected));
    }

    if mint_with_ext.get_extension::<TransferFeeConfig>().is_ok() {
        return Err(error!(DominionError::TransferFeeUnexpected));
    }

    // Strict allowlist. Subsumes the two rejects above, kept for their clearer
    // error codes, and also catches MintCloseAuthority, NonTransferable and so on.
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
