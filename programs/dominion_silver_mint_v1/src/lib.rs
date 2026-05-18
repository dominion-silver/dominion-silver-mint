// Dominion Silver mint/redeem program.
// 1 SILV = 1 troy oz physical LBMA silver.
// USDC in (classic SPL Token) <-> SILV out (SPL Token-2022) at Pyth XAG/USD price + premium.
// See PLAN.md in repo root for design rationale.

use anchor_lang::prelude::*;

pub mod assertions;
pub mod cpi;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");

#[program]
pub mod dominion_silver_mint {
    use super::*;
    use crate::instructions::admin::execute::OracleGuardsArgs;

    // === User instructions ===

    pub fn mint_silv(
        ctx: Context<MintSilv>,
        amount_usdc: u64,
        min_silv_out: u64,
        day_epoch: u32,
    ) -> Result<()> {
        instructions::mint_silv::handler(ctx, amount_usdc, min_silv_out, day_epoch)
    }

    pub fn redeem_silv(
        ctx: Context<RedeemSilv>,
        amount_silv: u64,
        min_usdc_out: u64,
        day_epoch: u32,
        hour_epoch: u32,
    ) -> Result<()> {
        instructions::redeem_silv::handler(ctx, amount_silv, min_usdc_out, day_epoch, hour_epoch)
    }

    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
        instructions::deposit_usdc::handler(ctx, amount)
    }

    // === Initialize (one-shot) ===

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    // === Emergency ===

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::emergency::pause::pause_handler(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::emergency::pause::unpause_handler(ctx)
    }

    // === Admin: instant ===

    pub fn set_mint_caps(
        ctx: Context<SetCaps>,
        min_tx_usdc: u64,
        max_tx_usdc: u64,
        daily_cap_usdc: u64,
    ) -> Result<()> {
        instructions::admin::caps::set_mint_caps_handler(
            ctx,
            min_tx_usdc,
            max_tx_usdc,
            daily_cap_usdc,
        )
    }

    pub fn set_redeem_caps(
        ctx: Context<SetCaps>,
        min_tx_usdc: u64,
        max_tx_usdc: u64,
        daily_cap_usdc: u64,
    ) -> Result<()> {
        instructions::admin::caps::set_redeem_caps_handler(
            ctx,
            min_tx_usdc,
            max_tx_usdc,
            daily_cap_usdc,
        )
    }

    pub fn set_hourly_redeem_cap(ctx: Context<SetCaps>, bps: u16) -> Result<()> {
        instructions::admin::caps::set_hourly_redeem_cap_handler(ctx, bps)
    }

    /// DEV ONLY: bumps max_staleness_seconds without timelock.
    /// REMOVE OR FEATURE-GATE BEFORE MAINNET.
    pub fn dev_set_max_staleness(
        ctx: Context<DevSetOracleParam>,
        secs: u32,
    ) -> Result<()> {
        instructions::admin::dev::dev_set_max_staleness_handler(ctx, secs)
    }

    /// DEV ONLY: sets premium_bps_mint + premium_bps_redeem without timelock.
    /// REMOVE OR FEATURE-GATE BEFORE MAINNET.
    pub fn dev_set_premiums(
        ctx: Context<DevSetOracleParam>,
        mint_bps: u16,
        redeem_bps: u16,
    ) -> Result<()> {
        instructions::admin::dev::dev_set_premiums_handler(ctx, mint_bps, redeem_bps)
    }

    pub fn add_guardian(ctx: Context<AddGuardian>, guardian_pubkey: Pubkey) -> Result<()> {
        instructions::admin::guardian::add_handler(ctx, guardian_pubkey)
    }

    pub fn remove_guardian(ctx: Context<RemoveGuardian>, guardian_pubkey: Pubkey) -> Result<()> {
        instructions::admin::guardian::remove_handler(ctx, guardian_pubkey)
    }

    pub fn propose_admin_transfer(
        ctx: Context<ProposeAdminTransfer>,
        new_admin: Pubkey,
    ) -> Result<()> {
        instructions::admin::transfer::propose_handler(ctx, new_admin)
    }

    pub fn accept_admin_transfer(ctx: Context<AcceptAdminTransfer>) -> Result<()> {
        instructions::admin::transfer::accept_handler(ctx)
    }

    pub fn cancel_admin_transfer(ctx: Context<CancelAdminTransfer>) -> Result<()> {
        instructions::admin::transfer::cancel_handler(ctx)
    }

    pub fn cancel_timelocked_action(ctx: Context<CancelTimelocked>, nonce: u64) -> Result<()> {
        instructions::admin::timelock::cancel_handler(ctx, nonce)
    }

    // CODEX H-02: thaw_account REMOVED from entry points.
    //
    // The original handler called spl_token_2022::instruction::thaw_account
    // signing with the PermanentDelegate authority. SPL requires the mint's
    // freeze_authority as the signer, NOT the permanent delegate. Since the
    // SILV mint is initialized with freeze_authority = None (CODEX C-02),
    // there IS no freeze authority that can thaw. So the documented
    // "compliance recovery" path could not work as written.
    //
    // The handler code (instructions/admin/thaw.rs) is preserved as
    // dead-code reference; no #[program] entry point exposes it. If a real
    // freeze/thaw flow is needed later, it requires architectural redesign:
    // either set freeze_authority to a Squads-controlled key (introducing
    // explicit centralized freeze capability, with all the on-chain assertions
    // that implies), or use a different recovery mechanism.
    //
    // Tracked in POLISH_BACKLOG.md "Out-of-scope add-ons".

    // === Admin: timelocked propose/execute ===

    pub fn propose_set_premium_mint(ctx: Context<ProposePremium>, new_bps: u16) -> Result<()> {
        instructions::admin::propose::propose_set_premium_mint_handler(ctx, new_bps)
    }

    pub fn execute_set_premium_mint(ctx: Context<ExecutePremium>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_premium_mint_handler(ctx, nonce)
    }

    pub fn propose_set_premium_redeem(ctx: Context<ProposePremium>, new_bps: u16) -> Result<()> {
        instructions::admin::propose::propose_set_premium_redeem_handler(ctx, new_bps)
    }

    pub fn execute_set_premium_redeem(ctx: Context<ExecutePremium>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_premium_redeem_handler(ctx, nonce)
    }

    pub fn propose_withdraw_usdc(
        ctx: Context<ProposeWithdraw>,
        amount: u64,
        recipient: Pubkey,
    ) -> Result<()> {
        instructions::admin::propose::propose_withdraw_usdc_handler(ctx, amount, recipient)
    }

    pub fn execute_withdraw_usdc(ctx: Context<ExecuteWithdraw>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_withdraw_usdc_handler(ctx, nonce)
    }

    pub fn propose_set_compliance_mode(
        ctx: Context<ProposeCompliance>,
        new_value: bool,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_compliance_mode_handler(ctx, new_value)
    }

    pub fn execute_set_compliance_mode(ctx: Context<ExecuteCompliance>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_compliance_mode_handler(ctx, nonce)
    }

    pub fn propose_set_oracle_guards(
        ctx: Context<ProposeOracleGuards>,
        args: OracleGuardsArgs,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_oracle_guards_handler(ctx, args)
    }

    pub fn execute_set_oracle_guards(ctx: Context<ExecuteOracleGuards>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_oracle_guards_handler(ctx, nonce)
    }

    pub fn propose_set_treasury_min_reserve(
        ctx: Context<ProposeMinReserve>,
        new_bps: u16,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_treasury_min_reserve_handler(ctx, new_bps)
    }

    pub fn execute_set_treasury_min_reserve(
        ctx: Context<ExecuteMinReserve>,
        nonce: u64,
    ) -> Result<()> {
        instructions::admin::execute::execute_set_treasury_min_reserve_handler(ctx, nonce)
    }

    pub fn propose_set_admin_timelock(
        ctx: Context<ProposeAdminTimelock>,
        new_seconds: u32,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_admin_timelock_handler(ctx, new_seconds)
    }

    pub fn execute_set_admin_timelock(
        ctx: Context<ExecuteAdminTimelock>,
        nonce: u64,
    ) -> Result<()> {
        instructions::admin::execute::execute_set_admin_timelock_handler(ctx, nonce)
    }

    pub fn propose_set_pyth_feed(
        ctx: Context<ProposePythFeed>,
        new_feed_id: [u8; 32],
        new_receiver_program: Pubkey,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_pyth_feed_handler(
            ctx,
            new_feed_id,
            new_receiver_program,
        )
    }

    pub fn execute_set_pyth_feed(ctx: Context<ExecutePythFeed>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_pyth_feed_handler(ctx, nonce)
    }

    pub fn propose_update_metadata(
        ctx: Context<ProposeUpdateMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::admin::propose::propose_update_metadata_handler(ctx, name, symbol, uri)
    }

    pub fn execute_update_metadata(ctx: Context<ExecuteUpdateMetadata>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_update_metadata_handler(ctx, nonce)
    }

    // === Rent reclaim ===

    pub fn close_daily_counter(ctx: Context<CloseDailyCounter>, day_epoch: u32) -> Result<()> {
        instructions::admin::close_accounts::close_daily_counter_handler(ctx, day_epoch)
    }

    pub fn close_hourly_counter(ctx: Context<CloseHourlyCounter>, hour_epoch: u32) -> Result<()> {
        instructions::admin::close_accounts::close_hourly_counter_handler(ctx, hour_epoch)
    }

    pub fn close_timelock_account(ctx: Context<CloseTimelockAccount>, nonce: u64) -> Result<()> {
        instructions::admin::close_accounts::close_timelock_account_handler(ctx, nonce)
    }
}
