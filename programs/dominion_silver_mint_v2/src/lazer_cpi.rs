// Pyth Lazer (Pyth Pro) verify_message CPI wrapper plus its isolated fee-payer PDA.

// INVARIANT: the `payer` handed to `verify_message` is never a user wallet. Lazer
// is upgradeable and Solana propagates signer privileges through a CPI, so the
// System-owned `lazer_fee_payer` PDA is funded with exactly the capped fee just
// before the CPI and left at zero after, bounding a malicious upgrade's take.

// INVARIANT (one buffer): the caller must price the SAME `message_data` it passes
// here, and must price only the payload this returns, never the input envelope.
// Lazer binds the ed25519 instruction to that exact buffer.

// invoke_signed and malicious-callee resistance are covered by the litesvm harness.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
    pubkey::Pubkey,
    system_instruction,
    sysvar::instructions as sysvar_instructions,
};

use crate::errors::DominionError;

// Hard-pins. Same on devnet and mainnet.
pub const LAZER_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
pub const LAZER_STORAGE: Pubkey =
    anchor_lang::solana_program::pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
// The Lazer treasury is deliberately NOT a pinned constant: it differs between
// mainnet and devnet, so pinning it would force a per-cluster build. It is read
// at runtime from the pinned LAZER_STORAGE account (read_treasury below).

// sha256("global:verify_message")[..8]. The host-only verification crate asserts
// this against the Lazer SDK's own constant.
pub const VERIFY_MESSAGE_DISCRIMINATOR: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];

// Ceiling in lamports on the Lazer fee we will fund or pay (the live fee is 1).
// A Lazer upgrade raising the fee past this is rejected.
pub const LAZER_FEE_CEILING: u64 = 10_000; // 0.00001 SOL

pub const LAZER_FEE_PAYER_SEED: &[u8] = b"lazer_fee_payer";

// Lazer Storage layout: disc(8) top_authority(32) treasury(32) fee(8) ...
const STORAGE_TREASURY_OFFSET: usize = 8 + 32;
const STORAGE_FEE_OFFSET: usize = 8 + 32 + 32;

// Loose cap in bytes; Solana's own return-data limit is 1024 B.
const MAX_RETURN_PAYLOAD: usize = 2048;

// Loose cap in bytes on the inbound envelope (a real one is ~152 B). Bounds the
// `as u32` length encoding and the ix data size.
const MAX_MESSAGE_DATA: usize = 1024;

/// PURE: build the `verify_message` instruction data (discriminator + borsh
/// args: message_data: Vec<u8>, ed25519_instruction_index: u16, signature_index: u8).
fn build_verify_ix_data(
    message_data: &[u8],
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 4 + message_data.len() + 2 + 1);
    data.extend_from_slice(&VERIFY_MESSAGE_DISCRIMINATOR);
    data.extend_from_slice(&(message_data.len() as u32).to_le_bytes());
    data.extend_from_slice(message_data);
    data.extend_from_slice(&ed25519_instruction_index.to_le_bytes());
    data.push(signature_index);
    data
}

/// PURE: read the bounded `single_update_fee_in_lamports` from Storage data.
fn read_fee(storage_data: &[u8]) -> Result<u64> {
    require!(
        storage_data.len() >= STORAGE_FEE_OFFSET + 8,
        DominionError::LazerStorageMalformed
    );
    let fee = u64::from_le_bytes(
        storage_data[STORAGE_FEE_OFFSET..STORAGE_FEE_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    require!(fee <= LAZER_FEE_CEILING, DominionError::LazerFeeTooHigh);
    Ok(fee)
}

/// PURE: read the Lazer Storage's own `treasury` pubkey, so the wrapper stays
/// cluster-agnostic. See the note on the treasury near LAZER_STORAGE.
fn read_treasury(storage_data: &[u8]) -> Result<Pubkey> {
    require!(
        storage_data.len() >= STORAGE_TREASURY_OFFSET + 32,
        DominionError::LazerStorageMalformed
    );
    Ok(Pubkey::new_from_array(
        storage_data[STORAGE_TREASURY_OFFSET..STORAGE_TREASURY_OFFSET + 32]
            .try_into()
            .unwrap(),
    ))
}

/// PURE: parse `VerifiedMessage` return-data (borsh: public_key Pubkey, then
/// payload Vec<u8>) into the inner payload. Rejects trailing bytes and oversize.
fn parse_verified_message(ret: &[u8]) -> Result<Vec<u8>> {
    require!(ret.len() >= 36, DominionError::LazerReturnDataMalformed);
    let len = u32::from_le_bytes(ret[32..36].try_into().unwrap()) as usize;
    require!(
        len <= MAX_RETURN_PAYLOAD,
        DominionError::LazerReturnDataMalformed
    );
    require!(
        ret.len() == 36 + len,
        DominionError::LazerReturnDataMalformed
    );
    Ok(ret[36..].to_vec())
}

/// The accounts the wrapper needs. All are pinned/validated inside.
pub struct LazerVerifyAccounts<'a, 'info> {
    pub lazer_program: &'a AccountInfo<'info>,
    pub storage: &'a AccountInfo<'info>,
    pub treasury: &'a AccountInfo<'info>,
    /// The isolated fee-payer PDA (System-owned), seeds = [LAZER_FEE_PAYER_SEED].
    pub fee_payer: &'a AccountInfo<'info>,
    pub instructions_sysvar: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    /// The dominion ix's user signer; funds the PDA. NEVER passed to the CPI.
    pub funder: &'a AccountInfo<'info>,
}

/// Verify a Lazer message via the upgradeable Lazer program and return the inner
/// signed payload. Only that return value may be parsed for price.
pub fn verify_and_get_payload(
    accts: &LazerVerifyAccounts,
    fee_payer_bump: u8,
    message_data: Vec<u8>,
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<Vec<u8>> {
    require!(
        message_data.len() <= MAX_MESSAGE_DATA,
        DominionError::LazerMessageTooLarge
    );

    require!(
        accts.lazer_program.key() == LAZER_PROGRAM_ID,
        DominionError::LazerWrongAccount
    );
    require!(
        accts.storage.key() == LAZER_STORAGE,
        DominionError::LazerWrongAccount
    );
    // The treasury is validated at the storage borrow below, not here.
    require!(
        accts.instructions_sysvar.key() == sysvar_instructions::ID,
        DominionError::LazerWrongAccount
    );
    require!(
        accts.system_program.key() == anchor_lang::solana_program::system_program::ID,
        DominionError::LazerWrongAccount
    );
    require!(
        accts.lazer_program.executable,
        DominionError::LazerProgramNotExecutable
    );

    // fee-payer PDA must be exactly our derivation (System-owned).
    let expected_pda =
        Pubkey::create_program_address(&[LAZER_FEE_PAYER_SEED, &[fee_payer_bump]], &crate::ID)
            .map_err(|_| error!(DominionError::LazerFeePayerMismatch))?;
    require!(
        accts.fee_payer.key() == expected_pda,
        DominionError::LazerFeePayerMismatch
    );

    // Treasury check and bounded fee read share one borrow of the pinned
    // storage. Lazer's own `has_one = treasury` would also catch a wrong
    // account; pre-checking turns it into our explicit LazerWrongAccount.
    let fee = {
        let data = accts.storage.try_borrow_data()?;
        require!(
            accts.treasury.key() == read_treasury(&data)?,
            DominionError::LazerWrongAccount
        );
        read_fee(&data)?
    };

    // Fund the PDA with EXACTLY the fee. The user's signer privilege reaches
    // this System CPI but the user never reaches the Lazer CPI below. The
    // fee == 0 case (PDA stays at zero) is exercised by the litesvm harness at
    // fee 0, 1 and ceiling; do not "fix" it here without running that.
    if fee > 0 {
        invoke(
            &system_instruction::transfer(accts.funder.key, accts.fee_payer.key, fee),
            &[
                accts.funder.clone(),
                accts.fee_payer.clone(),
                accts.system_program.clone(),
            ],
        )?;
    }

    // CPI with the PDA as `payer`, signed via seeds. Lazer's internal transfer
    // drains the fee to its treasury, leaving the PDA at zero.
    let ix = Instruction {
        program_id: LAZER_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accts.fee_payer.key(), true),
            AccountMeta::new_readonly(accts.storage.key(), false),
            AccountMeta::new(accts.treasury.key(), false),
            AccountMeta::new_readonly(accts.system_program.key(), false),
            AccountMeta::new_readonly(accts.instructions_sysvar.key(), false),
        ],
        data: build_verify_ix_data(&message_data, ed25519_instruction_index, signature_index),
    };
    invoke_signed(
        &ix,
        &[
            accts.fee_payer.clone(),
            accts.storage.clone(),
            accts.treasury.clone(),
            accts.system_program.clone(),
            accts.instructions_sysvar.clone(),
            accts.lazer_program.clone(),
        ],
        &[&[LAZER_FEE_PAYER_SEED, &[fee_payer_bump]]],
    )?;

    let (prog, ret) = get_return_data().ok_or(error!(DominionError::LazerReturnDataMissing))?;
    require!(
        prog == LAZER_PROGRAM_ID,
        DominionError::LazerReturnDataWrongProgram
    );
    parse_verified_message(&ret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminator_is_anchor_global_verify_message() {
        assert_eq!(
            VERIFY_MESSAGE_DISCRIMINATOR,
            [180, 193, 120, 55, 189, 135, 203, 83]
        );
    }

    #[test]
    fn ix_data_layout() {
        let msg = vec![0xAAu8, 0xBB, 0xCC];
        let d = build_verify_ix_data(&msg, 0x0102, 0x07);
        // disc, then u32-LE vec len, bytes, u16-LE ed25519 index, u8 sig index.
        assert_eq!(&d[0..8], &VERIFY_MESSAGE_DISCRIMINATOR);
        assert_eq!(&d[8..12], &[3, 0, 0, 0]);
        assert_eq!(&d[12..15], &[0xAA, 0xBB, 0xCC]);
        assert_eq!(&d[15..17], &[0x02, 0x01]);
        assert_eq!(d[17], 0x07);
        assert_eq!(d.len(), 18);
    }

    fn storage_with_fee(fee: u64) -> Vec<u8> {
        let mut s = vec![0u8; STORAGE_FEE_OFFSET + 8];
        s[STORAGE_FEE_OFFSET..STORAGE_FEE_OFFSET + 8].copy_from_slice(&fee.to_le_bytes());
        s
    }

    #[test]
    fn read_fee_ok_and_bounded() {
        assert_eq!(read_fee(&storage_with_fee(1)).unwrap(), 1);
        assert_eq!(
            read_fee(&storage_with_fee(LAZER_FEE_CEILING)).unwrap(),
            LAZER_FEE_CEILING
        );
        assert!(read_fee(&storage_with_fee(LAZER_FEE_CEILING + 1)).is_err());
        assert!(read_fee(&[0u8; 10]).is_err()); // too small
    }

    #[test]
    fn read_treasury_ok_and_bounded() {
        let want = Pubkey::new_unique();
        let mut s = vec![0u8; STORAGE_FEE_OFFSET + 8];
        s[STORAGE_TREASURY_OFFSET..STORAGE_TREASURY_OFFSET + 32].copy_from_slice(&want.to_bytes());
        assert_eq!(read_treasury(&s).unwrap(), want);
        assert!(read_treasury(&[0u8; STORAGE_TREASURY_OFFSET + 31]).is_err()); // too small
    }

    #[test]
    fn parse_verified_message_ok() {
        let mut ret = vec![9u8; 32]; // pubkey, then u32-LE len, then payload
        let payload = vec![1u8, 2, 3, 4, 5];
        ret.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        ret.extend_from_slice(&payload);
        assert_eq!(parse_verified_message(&ret).unwrap(), payload);
    }

    #[test]
    fn parse_verified_message_rejects_trailing_and_short_and_oversize() {
        let mut ret = vec![9u8; 32];
        ret.extend_from_slice(&(2u32).to_le_bytes());
        ret.extend_from_slice(&[1u8, 2, 0xFF]); // one byte past the declared length
        assert!(parse_verified_message(&ret).is_err());
        assert!(parse_verified_message(&[0u8; 35]).is_err()); // too short
        let mut big = vec![9u8; 32];
        big.extend_from_slice(&((MAX_RETURN_PAYLOAD as u32) + 1).to_le_bytes());
        assert!(parse_verified_message(&big).is_err());
    }
}
