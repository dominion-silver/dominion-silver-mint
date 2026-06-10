//! Mock Pyth Lazer `verify_message`. See Cargo.toml.
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Instruction data layout produced by dominion's build_verify_ix_data:
    //   discriminator(8) + msg_len(u32 LE) + message_data + ed_idx(u16) + sig(u8)
    if data.len() < 12 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let msg_len = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    if data.len() < 12 + msg_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let message_data = &data[12..12 + msg_len];

    // Drain the fee-payer PDA's FULL balance to the treasury FIRST - the maximum
    // a hostile/upgraded Lazer could ever take. The PDA only holds exactly the
    // fee dominion funded, and the user wallet is NOT in this account list, so
    // it is structurally unreachable. accounts (from lazer_cpi.rs):
    //   [0]=fee_payer(signer,w) [1]=storage(r) [2]=treasury(w)
    //   [3]=system_program(r) [4]=instructions_sysvar(r)
    // The transfer MUST happen before set_return_data: invoking the system
    // program clears the return data, so set_return_data has to be the last op
    // (the real Lazer program necessarily does the same ordering).
    let fee_payer = &accounts[0];
    let treasury = &accounts[2];
    let system_program = &accounts[3];
    let amount = **fee_payer.lamports.borrow();
    if amount > 0 {
        invoke(
            &system_instruction::transfer(fee_payer.key, treasury.key, amount),
            &[fee_payer.clone(), treasury.clone(), system_program.clone()],
        )?;
    }

    // VerifiedMessage return-data = public_key(32) + payload(u32 len + bytes).
    // We echo message_data as the inner payload (the harness passes the canonical
    // PayloadData bytes as message_data, so the dominion parser then reads them).
    let mut ret = Vec::with_capacity(32 + 4 + message_data.len());
    ret.extend_from_slice(&[7u8; 32]); // mock trusted-signer pubkey
    ret.extend_from_slice(&(message_data.len() as u32).to_le_bytes());
    ret.extend_from_slice(message_data);
    set_return_data(&ret);
    Ok(())
}
