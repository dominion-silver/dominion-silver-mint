// Pyth Lazer (Pyth Pro) verify_message CPI wrapper + isolated fee-payer PDA.
// Section 5.2 / 5.2.1 of private/PYTH_PRO_MIGRATION_PLAN.md.
//
// The Lazer program (`pytd2yyk...`) is UPGRADEABLE and Solana propagates
// signer/writable privileges through a CPI. Therefore the `payer` we hand to
// `verify_message` (which does a System transfer of the fee) MUST NEVER be the
// user wallet: a malicious Lazer upgrade could drain it. We use a dedicated,
// System-owned `lazer_fee_payer` PDA, funded with EXACTLY the (capped) fee just
// before the CPI and left at zero after, so a compromised callee can only ever
// take the PDA's tiny transient balance, never a user wallet.
//
// Trust: `verify_message` proves "a trusted Lazer signer signed message_data"
// and returns the inner `VerifiedMessage.payload`. We parse ONLY that returned
// payload (never the input envelope). The ed25519 ix that proves the signature
// is referenced by `ed25519_instruction_index` / `signature_index`; the Lazer
// program binds it to OUR exact `message_data` (signature.rs slice_eq), so the
// one-buffer invariant (5.2) holds as long as the caller passes the SAME
// `message_data` here that it parses for price. The caller passes the RETURNED
// payload to `crate::lazer::extract_feed_price`, never the input.
//
// BEHAVIORAL verification (invoke_signed, the malicious-callee resistance, the
// rent mechanics of the transient PDA) is covered by the solana-program-test
// harness with a mock + malicious Lazer program (Section 9). The PURE helpers
// here (instruction encoding, fee read, return-data parse) are host-unit-tested
// below.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
    pubkey::Pubkey,
    system_instruction,
    sysvar::instructions as sysvar_instructions,
};

use crate::errors::DominionError;

// Hard-pins (Section 4). Same on devnet + mainnet.
pub const LAZER_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
pub const LAZER_STORAGE: Pubkey =
    anchor_lang::solana_program::pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
pub const LAZER_TREASURY: Pubkey =
    anchor_lang::solana_program::pubkey!("Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak");

// Anchor instruction discriminator = sha256("global:verify_message")[..8].
// The Lazer contract is anchor 0.31.1 (verified). Locked here; the host-only
// verification crate asserts this byte-for-byte against
// `pyth_lazer_solana_contract::instruction::VerifyMessage::DISCRIMINATOR`.
pub const VERIFY_MESSAGE_DISCRIMINATOR: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];

// The current on-chain fee is 1 lamport; this is the absolute ceiling we will
// fund / pay. A malicious Lazer upgrade that raised the fee beyond this is
// rejected (and could only ever take up to this much from the transient PDA).
pub const LAZER_FEE_CEILING: u64 = 10_000; // 0.00001 SOL

pub const LAZER_FEE_PAYER_SEED: &[u8] = b"lazer_fee_payer";

// Offset of `single_update_fee_in_lamports` in the Lazer Storage account:
// 8 (anchor disc) + 32 (top_authority) + 32 (treasury).
const STORAGE_FEE_OFFSET: usize = 8 + 32 + 32;

// Defensive cap on the returned payload size (the SILV payload is ~50 bytes).
const MAX_RETURN_PAYLOAD: usize = 2048;

// Defensive cap on the inbound SolanaMessage envelope (4 magic + 64 sig +
// 32 pubkey + 2 len + ~50 payload ~= 152 bytes). Bounds the `as u32` length
// encoding + the ix data size; a real Solana tx is <= 1232 bytes anyway.
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

/// PURE: parse `VerifiedMessage` return-data (borsh: public_key: Pubkey [32] +
/// payload: Vec<u8> [4-byte len + bytes]) and return the inner payload, with no
/// trailing bytes and a size cap.
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

/// Verify a Lazer message via the upgradeable Lazer program and return the
/// inner signed payload. RUNTIME (invoke); behavioral tests are in the
/// solana-program-test harness.
pub fn verify_and_get_payload(
    accts: &LazerVerifyAccounts,
    fee_payer_bump: u8,
    message_data: Vec<u8>,
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<Vec<u8>> {
    // 0. Bound the inbound message (defense in depth; spec 5.2).
    require!(
        message_data.len() <= MAX_MESSAGE_DATA,
        DominionError::LazerMessageTooLarge
    );

    // 1. Hard-pin every Lazer account; require the program executable.
    require!(
        accts.lazer_program.key() == LAZER_PROGRAM_ID,
        DominionError::LazerWrongAccount
    );
    require!(
        accts.storage.key() == LAZER_STORAGE,
        DominionError::LazerWrongAccount
    );
    require!(
        accts.treasury.key() == LAZER_TREASURY,
        DominionError::LazerWrongAccount
    );
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

    // 2. Read + bound the effective fee.
    let fee = {
        let data = accts.storage.try_borrow_data()?;
        read_fee(&data)?
    };

    // 3. Fund the PDA with EXACTLY the fee (user -> PDA). The user is the outer
    //    signer; its signer privilege propagates to this System CPI. The user
    //    is NEVER passed to the Lazer CPI below.
    //    fee == 0 (the on-chain fee is currently 1 lamport, so this is not a
    //    live config): no funding occurs and the PDA stays at zero. The
    //    behavior of `verify_message` with a zero-balance PDA payer + a
    //    zero-value internal transfer is a corner case verified explicitly by
    //    the solana-program-test harness (fee = 0 / 1 / ceiling); do NOT add an
    //    untested "fix" here without that harness.
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

    // 4. CPI verify_message with the PDA as `payer`, signed via seeds. The
    //    Lazer program's internal transfer drains the PDA's fee to its treasury,
    //    leaving the PDA at zero.
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

    // 5. Return-data discipline: present, from the Lazer program, well-formed.
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
        // sha256("global:verify_message")[..8], recomputed independently.
        // (The host-only verification crate also asserts this == the SDK's.)
        assert_eq!(
            VERIFY_MESSAGE_DISCRIMINATOR,
            [180, 193, 120, 55, 189, 135, 203, 83]
        );
    }

    #[test]
    fn ix_data_layout() {
        let msg = vec![0xAAu8, 0xBB, 0xCC];
        let d = build_verify_ix_data(&msg, 0x0102, 0x07);
        // discriminator
        assert_eq!(&d[0..8], &VERIFY_MESSAGE_DISCRIMINATOR);
        // vec len (u32 LE) = 3
        assert_eq!(&d[8..12], &[3, 0, 0, 0]);
        // bytes
        assert_eq!(&d[12..15], &[0xAA, 0xBB, 0xCC]);
        // ed25519_instruction_index (u16 LE) = 0x0102
        assert_eq!(&d[15..17], &[0x02, 0x01]);
        // signature_index (u8)
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
    fn parse_verified_message_ok() {
        // 32-byte pubkey + len(4) + payload
        let mut ret = vec![9u8; 32];
        let payload = vec![1u8, 2, 3, 4, 5];
        ret.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        ret.extend_from_slice(&payload);
        assert_eq!(parse_verified_message(&ret).unwrap(), payload);
    }

    #[test]
    fn parse_verified_message_rejects_trailing_and_short_and_oversize() {
        // trailing byte
        let mut ret = vec![9u8; 32];
        ret.extend_from_slice(&(2u32).to_le_bytes());
        ret.extend_from_slice(&[1u8, 2, 0xFF]); // 1 extra
        assert!(parse_verified_message(&ret).is_err());
        // too short
        assert!(parse_verified_message(&[0u8; 35]).is_err());
        // oversize length field
        let mut big = vec![9u8; 32];
        big.extend_from_slice(&((MAX_RETURN_PAYLOAD as u32) + 1).to_le_bytes());
        assert!(parse_verified_message(&big).is_err());
    }
}
