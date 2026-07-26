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
// Pyth Lazer (Pyth Pro) dependency-free payload parser, wired into the oracle
// path via oracle.rs (the Core -> Lazer migration, private/PYTH_PRO_MIGRATION_
// PLAN.md). The official pyth-lazer-protocol crate does not build for SBF
// (off-chain dep tree), hence this hand-roll; it is machine-verified against
// that crate's wire format in tools/lazer-verify.
pub mod lazer;
// Pyth Lazer verify_message CPI wrapper + isolated fee-payer PDA (Section 5.2).
// Runtime-verified end-to-end by the litesvm harness (tools/lazer-harness).
pub mod lazer_cpi;
// Pyth Lazer oracle policy + pricing (Sections 5.4-5.6), wired by oracle.rs.
pub mod lazer_price;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

// CODEX P0-01: V2 is a MANDATORY fresh deploy under a NEW program ID (the
// V1/V2 ConfigAccount layout is incompatible; the whole "no stale V1 state"
// safety hypothesis depends on this ID NOT being the V1 ID
// J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5).
// 2026-06-10 PYTH LAZER: the Lazer migration changed the ConfigAccount layout
// AGAIN (pyth_feed_id[32]+receiver -> pyth_lazer_feed_id[u32]+min_publishers),
// so the old V2 config at GDN5ktEm88... is incompatible -> another fresh deploy
// under a new ID. Old V2/Core devnet id (retired): GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX.
// Keypair: target/deploy/dominion_silver_mint_v2-keypair.json (gitignored).
declare_id!("6bgSnXYg11BWnGRc3R7xenDPCqt2xu2YswkzQGr4AoYh");

#[program]
pub mod dominion_silver_mint {
    use super::*;
    use crate::instructions::admin::execute::OracleGuardsArgs;

    // === User instructions ===

    pub fn mint_silv(
        ctx: Context<MintSilv>,
        amount_usdc: u64,
        min_silv_out: u64,
        message_data: Vec<u8>,
        ed25519_instruction_index: u16,
        signature_index: u8,
    ) -> Result<()> {
        instructions::mint_silv::handler(
            ctx,
            amount_usdc,
            min_silv_out,
            message_data,
            ed25519_instruction_index,
            signature_index,
        )
    }

    // Option B redeem = INSTANT path only (§4.3). A redeem that must queue
    // reverts MustUseQueue; the client then calls `redeem_silv_queued`.
    pub fn redeem_silv(
        ctx: Context<RedeemSilv>,
        amount_silv: u64,
        min_usdc_out: u64,
        message_data: Vec<u8>,
        ed25519_instruction_index: u16,
        signature_index: u8,
    ) -> Result<()> {
        instructions::redeem_silv::handler(
            ctx,
            amount_silv,
            min_usdc_out,
            message_data,
            ed25519_instruction_index,
            signature_index,
        )
    }

    // Option B queued-redemption lifecycle (§4.3 ENQUEUE + §4.4).
    pub fn redeem_silv_queued(
        ctx: Context<RedeemSilvQueued>,
        amount_silv: u64,
        request_nonce: u64,
    ) -> Result<()> {
        instructions::redeem_queued::queued_handler(ctx, amount_silv, request_nonce)
    }

    pub fn claim_redemption(
        ctx: Context<ClaimRedemption>,
        message_data: Vec<u8>,
        ed25519_instruction_index: u16,
        signature_index: u8,
    ) -> Result<()> {
        instructions::redeem_queued::claim_handler(
            ctx,
            message_data,
            ed25519_instruction_index,
            signature_index,
        )
    }

    pub fn admin_settle_redemption_offchain(
        ctx: Context<AdminSettleRedemptionOffchain>,
    ) -> Result<()> {
        instructions::redeem_queued::settle_offchain_handler(ctx)
    }

    // P2-03: owner reclaims the rent of a request the admin already settled
    // off-chain (SettledOffchain). Owner-gated, terminal-state only.
    pub fn close_settled_redemption(ctx: Context<CloseSettledRedemption>) -> Result<()> {
        instructions::redeem_queued::close_settled_redemption_handler(ctx)
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

    // Option B instant param setters (§6, no timelock, bounded by compile-time
    // ceilings - D14). Replaces the Option A per-tx/daily/hourly cap setters.

    pub fn set_max_silv_supply(ctx: Context<SetMaxSupply>, new_max: u64) -> Result<()> {
        instructions::admin::caps::set_max_silv_supply_handler(ctx, new_max)
    }

    /// Instant CLOSE of the public mint. FALSE-ONLY; opening goes through the
    /// 24h timelock (propose_set_public_mint / execute_set_public_mint).
    pub fn set_public_mint_enabled(ctx: Context<SetParam>, enabled: bool) -> Result<()> {
        instructions::admin::caps::set_public_mint_enabled_handler(ctx, enabled)
    }

    pub fn set_redemptions_enabled(ctx: Context<SetParam>, enabled: bool) -> Result<()> {
        instructions::admin::caps::set_redemptions_enabled_handler(ctx, enabled)
    }

    // FIX A (launch spec 2026-07): the four redeem throttles
    // (instant_redeem_budget, instant_redeem_window, large_redeem_threshold,
    // redeem_queue_delay) are loosen-slow / tighten-fast. This is the ONLY instant
    // path and it accepts safe-direction (tighten) values only; LOOSENING goes
    // through the 24h-timelocked propose/execute_set_redeem_limits below. Replaces
    // the four individual instant setters (which were instant loosen holes).
    pub fn emergency_tighten_redeem_limits(
        ctx: Context<SetParam>,
        args: instructions::admin::execute::RedeemLimitsArgs,
    ) -> Result<()> {
        instructions::admin::caps::emergency_tighten_redeem_limits_handler(ctx, args)
    }

    // Launch spec 2026-07: the pre-mint supply model (Mark's Telegram 2026-06-30).
    // admin_premint mints SILV against the hard cap into the inventory wallet with
    // no USDC and no oracle; set_inventory_wallet sets the destination (late-binding).
    pub fn set_inventory_wallet(ctx: Context<SetInventoryWallet>, wallet: Pubkey) -> Result<()> {
        instructions::admin::premint::set_inventory_wallet_handler(ctx, wallet)
    }

    pub fn admin_premint(ctx: Context<AdminPremint>, amount: u64) -> Result<()> {
        instructions::admin::premint::premint_handler(ctx, amount)
    }

    /// DEV ONLY: bumps max_staleness_seconds without timelock.
    /// CODEX P0-02: compiled ONLY under the non-default `dev-hatch` feature -
    /// absent from release/deploy builds + the generated IDL.
    #[cfg(feature = "dev-hatch")]
    pub fn dev_set_max_staleness(ctx: Context<DevSetOracleParam>, secs: u32) -> Result<()> {
        instructions::admin::dev::dev_set_max_staleness_handler(ctx, secs)
    }

    /// DEV ONLY: sets premium_bps_mint + premium_bps_redeem without timelock.
    /// CODEX P0-02: compiled ONLY under the non-default `dev-hatch` feature -
    /// absent from release/deploy builds + the generated IDL.
    #[cfg(feature = "dev-hatch")]
    pub fn dev_set_premiums(
        ctx: Context<DevSetOracleParam>,
        mint_bps: u16,
        redeem_bps: u16,
    ) -> Result<()> {
        instructions::admin::dev::dev_set_premiums_handler(ctx, mint_bps, redeem_bps)
    }

    /// TEST-HARNESS ONLY (feature `test-harness`). Read-only: drives the Lazer
    /// oracle read path in isolation + returns the price via return-data.
    /// Absent from release/deploy builds + the generated IDL.
    #[cfg(feature = "test-harness")]
    pub fn probe_oracle_price(
        ctx: Context<ProbeOraclePrice>,
        message_data: Vec<u8>,
        ed25519_instruction_index: u16,
        signature_index: u8,
    ) -> Result<()> {
        instructions::probe::handler(
            ctx,
            message_data,
            ed25519_instruction_index,
            signature_index,
        )
    }

    pub fn add_guardian(ctx: Context<AddGuardian>, guardian_pubkey: Pubkey) -> Result<()> {
        instructions::admin::guardian::add_handler(ctx, guardian_pubkey)
    }

    /// AUDIT 0.12b: SCHEDULES a removal (does not apply it). The guardian keeps
    /// full powers for admin_timelock_seconds and may cancel its own removal, so a
    /// compromised admin can no longer clear the veto in one signature.
    pub fn remove_guardian(ctx: Context<RemoveGuardian>, guardian_pubkey: Pubkey) -> Result<()> {
        instructions::admin::guardian::remove_handler(ctx, guardian_pubkey)
    }

    /// Applies a scheduled removal after its window. Permissionless on purpose.
    pub fn finalize_guardian_removal(
        ctx: Context<FinalizeGuardianRemoval>,
        guardian_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::admin::guardian::finalize_removal_handler(ctx, guardian_pubkey)
    }

    /// Cancels a scheduled removal. Admin OR the targeted guardian itself.
    pub fn cancel_guardian_removal(
        ctx: Context<CancelGuardianRemoval>,
        guardian_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::admin::guardian::cancel_removal_handler(ctx, guardian_pubkey)
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

    // Freeze / thaw are NOT Dominion-program instructions. The SILV mint carries a
    // freeze_authority = the compliance multisig (launch spec 2026-07: Mark confirmed
    // the freeze lever), so freezing/thawing a specific token account is done directly
    // via the SPL Token-2022 FreezeAccount / ThawAccount instructions signed by that
    // multisig (e.g. a Squads tx), exactly as the seize/clawback is done directly via
    // the PermanentDelegate (D12). Neither lever needs a wrapper instruction here, and
    // neither changes the mint-level authorities that assertions.rs pins every call.
    // (The old instructions/admin/thaw.rs dead-code file was removed in the Option B
    // teardown; it is intentionally not reintroduced.)

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

    /// Propose OPENING the public mint (24h timelock, guardian-cancellable).
    pub fn propose_set_public_mint(ctx: Context<ProposePublicMint>, new_value: bool) -> Result<()> {
        instructions::admin::propose::propose_set_public_mint_handler(ctx, new_value)
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

    // FIX A (launch spec 2026-07): the 24h-timelocked loosen path for the four
    // redeem throttles. The instant tighten fast-lane is emergency_tighten_redeem_limits.
    pub fn propose_set_redeem_limits(
        ctx: Context<ProposeRedeemLimits>,
        args: instructions::admin::execute::RedeemLimitsArgs,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_redeem_limits_handler(ctx, args)
    }

    pub fn execute_set_redeem_limits(ctx: Context<ExecuteRedeemLimits>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_redeem_limits_handler(ctx, nonce)
    }

    // Option B D7: treasury minimum FLOAT (replaces Option A min-reserve bps).
    pub fn propose_set_treasury_min_float(
        ctx: Context<ProposeTreasuryFloat>,
        new_float_usdc: u64,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_treasury_min_float_handler(ctx, new_float_usdc)
    }

    pub fn execute_set_treasury_min_float(
        ctx: Context<ExecuteTreasuryFloat>,
        nonce: u64,
    ) -> Result<()> {
        instructions::admin::execute::execute_set_treasury_min_float_handler(ctx, nonce)
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
        new_lazer_feed_id: u32,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_pyth_feed_handler(ctx, new_lazer_feed_id)
    }

    pub fn execute_set_public_mint(ctx: Context<ExecutePublicMint>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_public_mint_handler(ctx, nonce)
    }

    pub fn execute_set_pyth_feed(ctx: Context<ExecutePythFeed>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_pyth_feed_handler(ctx, nonce)
    }

    // P2-05: per-field Option<String>. None = leave that field unchanged
    // (execute skips its CPI, so it cannot be blanked). A provided field must
    // be non-empty and within its size cap.
    pub fn propose_update_metadata(
        ctx: Context<ProposeUpdateMetadata>,
        name: Option<String>,
        symbol: Option<String>,
        uri: Option<String>,
    ) -> Result<()> {
        instructions::admin::propose::propose_update_metadata_handler(ctx, name, symbol, uri)
    }

    pub fn execute_update_metadata(ctx: Context<ExecuteUpdateMetadata>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_update_metadata_handler(ctx, nonce)
    }

    // === Rent reclaim ===
    // Option B: close_daily_counter / close_hourly_counter removed (the daily/
    // hourly counter accounts no longer exist - Option A teardown).

    pub fn close_timelock_account(ctx: Context<CloseTimelockAccount>, nonce: u64) -> Result<()> {
        instructions::admin::close_accounts::close_timelock_account_handler(ctx, nonce)
    }
}
