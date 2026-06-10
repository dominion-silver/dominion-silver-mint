//! TEST-HARNESS ONLY (feature `test-harness`, ABSENT from the default/deploy
//! build + the generated IDL, exactly like the `dev-hatch` hatches). A thin
//! instruction that drives the Lazer oracle read path (verify CPI + parse +
//! policy) in ISOLATION so the litesvm harness can assert
//! it against a mock Lazer program WITHOUT standing up the full Token-2022 mint
//! environment. It mirrors mint_silv's Lazer account context + glue exactly.
//! It changes no config/token state: it only reads the oracle (which pays the
//! Lazer fee from the `funder`, like any oracle read) and returns the price via
//! return-data. Even if the feature were ever mis-enabled it cannot mint,
//! redeem, or alter config - strictly weaker than the existing `dev-hatch`
//! instructions, which DO mutate config.

use anchor_lang::prelude::*;

use crate::lazer_cpi::{LazerVerifyAccounts, LAZER_FEE_PAYER_SEED};
use crate::oracle::read_silver_price_lazer;
use crate::state::*;

#[derive(Accounts)]
pub struct ProbeOraclePrice<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub funder: Signer<'info>,

    /// CHECK: pinned to LAZER_PROGRAM_ID + executable in verify_and_get_payload.
    pub lazer_program: UncheckedAccount<'info>,
    /// CHECK: pinned to LAZER_STORAGE in verify_and_get_payload.
    pub lazer_storage: UncheckedAccount<'info>,
    /// CHECK: pinned to LAZER_TREASURY in verify_and_get_payload.
    #[account(mut)]
    pub lazer_treasury: UncheckedAccount<'info>,
    /// CHECK: System-owned isolated fee-payer PDA; derivation validated in the wrapper.
    #[account(mut, seeds = [LAZER_FEE_PAYER_SEED], bump)]
    pub lazer_fee_payer: UncheckedAccount<'info>,
    /// CHECK: pinned to the instructions sysvar in verify_and_get_payload.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ProbeOraclePrice>,
    message_data: Vec<u8>,
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<()> {
    let clock = Clock::get()?;

    let lazer_program_ai = ctx.accounts.lazer_program.to_account_info();
    let lazer_storage_ai = ctx.accounts.lazer_storage.to_account_info();
    let lazer_treasury_ai = ctx.accounts.lazer_treasury.to_account_info();
    let lazer_fee_payer_ai = ctx.accounts.lazer_fee_payer.to_account_info();
    let instructions_sysvar_ai = ctx.accounts.instructions_sysvar.to_account_info();
    let system_program_ai = ctx.accounts.system_program.to_account_info();
    let funder_ai = ctx.accounts.funder.to_account_info();
    let lazer_accts = LazerVerifyAccounts {
        lazer_program: &lazer_program_ai,
        storage: &lazer_storage_ai,
        treasury: &lazer_treasury_ai,
        fee_payer: &lazer_fee_payer_ai,
        instructions_sysvar: &instructions_sysvar_ai,
        system_program: &system_program_ai,
        funder: &funder_ai,
    };

    let result = read_silver_price_lazer(
        &lazer_accts,
        ctx.bumps.lazer_fee_payer,
        &ctx.accounts.config,
        &clock,
        message_data,
        ed25519_instruction_index,
        signature_index,
    )?;

    // normalized price (u128 LE, 16 bytes) + feedUpdateTimestamp (u64 LE, 8).
    let mut out = Vec::with_capacity(24);
    out.extend_from_slice(&result.normalized_price_scaled.to_le_bytes());
    out.extend_from_slice(&result.feed_update_timestamp_us.to_le_bytes());
    anchor_lang::solana_program::program::set_return_data(&out);
    Ok(())
}
