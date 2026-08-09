// Dominion Silver mint/redeem program.
// 1 SILV = 1 troy oz physical LBMA silver.
// USDC in (classic SPL Token) <-> SILV out (SPL Token-2022) at the Pyth Lazer silver price + premium.
// See PLAN.md in repo root for design rationale.

use anchor_lang::prelude::*;

pub mod assertions;
pub mod cpi;
pub mod errors;
pub mod events;
pub mod instructions;
// Pyth Lazer: a hand-rolled payload parser (the official crate does not build for SBF; this one is
// machine-verified against its wire format in tools/lazer-verify), the verify_message CPI wrapper
// plus isolated fee-payer PDA, and the oracle policy. All wired by oracle.rs.
pub mod lazer;
pub mod lazer_cpi;
pub mod lazer_price;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

// THE MAINNET PROGRAM ID, generated 2026-08-08 at the mainnet ceremony (runbook step 1). Keypair at
// ~/.config/solana/dominion-mainnet-program.json, mode 600, NEVER in this repo.
//
// ONE ID FOR BOTH CLUSTERS, deliberately. `declare_id!` is a single literal, so a devnet rehearsal on
// a different id can only ever exercise a DIFFERENT binary than the one that ships. Round 5 concluded
// NO-GO partly because "the mainnet candidate does not exist yet"; keeping a separate rehearsal id
// would have preserved exactly that gap. The devnet deployment under this id is the rehearsal, and its
// bytes are the candidate's bytes.
//
// This id MUST be a fresh deploy: the ConfigAccount layout is incompatible with V1 and with the
// pre-Lazer V2, and the "no stale state" hypothesis depends on the id being neither.
//
// Retired: V1 J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5, pre-Lazer V2
// GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX.
// SUPERSEDED but still deployed on devnet: HXaptAcaXBoEAsNuEv4ZwYrciHbMxSpip2VScRVDjo1Z, the 2026-08-07 rehearsal
// contract. It carries three timelocked proposals and predates the round 5 remediation, so it is a
// historical record, not a target. Close it once the rehearsal under this id has run.
declare_id!("3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ");

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

    // Redeem is a SINGLE INSTANT ROUTE: burn SILV, receive USDC, same transaction. There is no queue
    // and no queued instruction. A redeem that cannot be served REVERTS (over the rolling-window
    // budget, or over the treasury balance); the client's `classifyRedeem` predicts both before signing.
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

    // REMOVED 2026-08-05 with the queued-redemption lifecycle: redeem_silv_queued, claim_redemption,
    // admin_settle_redemption_offchain, close_settled_redemption. Removing instructions is ABI-breaking;
    // it was free because redemptions were never enabled on any cluster, so no request account exists.

    // === Fee-exemption whitelist (per-side flags) ===
    // Both instant: the worst case is foregone revenue, not lost principal. Rationale at the handlers.

    /// `expires_at` is MANDATORY: a unix timestamp in SECONDS, strictly in the future, capped at
    /// MAX_FEE_EXEMPT_TERM_SECONDS. Zero is refused (C-01), so every waiver carries a term and is
    /// renewed by one instant transaction. That renewal IS the review the term exists to force.
    pub fn set_fee_exempt(
        ctx: Context<SetFeeExempt>,
        wallet: Pubkey,
        flags: u8,
        expires_at: i64,
    ) -> Result<()> {
        instructions::admin::fee_whitelist::set_fee_exempt_handler(ctx, wallet, flags, expires_at)
    }

    pub fn remove_fee_exempt(ctx: Context<RemoveFeeExempt>, wallet: Pubkey) -> Result<()> {
        instructions::admin::fee_whitelist::remove_fee_exempt_handler(ctx, wallet)
    }

    /// Sweep accrued premium out of the program-owned fee vault to a destination chosen per call.
    /// Instant: the vault backs nothing and `config.admin` is already a multisig.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        instructions::admin::fee_whitelist::withdraw_fees_handler(ctx, amount)
    }

    /// The fee-vault ESCAPE HATCH, instant in both directions. With routing off the premium stays in
    /// the treasury. It exists because USDC carries a Circle freeze authority and the premium transfer
    /// is unconditional, so a frozen vault would otherwise brick mint AND redeem for non-exempt wallets.
    pub fn set_fee_routing_enabled(ctx: Context<SetFeeRouting>, enabled: bool) -> Result<()> {
        instructions::admin::fee_whitelist::set_fee_routing_enabled_handler(ctx, enabled)
    }

    // === KYC gate (DORMANT: kyc_scope_flags == 0) ===
    // It ships now so arming it later is a config change, not a program upgrade plus a second audit. The
    // attestor key can ONLY write and revoke attestations: it cannot mint, pause, move funds or arm it.

    pub fn set_kyc_operator(ctx: Context<SetKycOperator>, operator: Pubkey) -> Result<()> {
        instructions::admin::kyc_admin::set_kyc_operator_handler(ctx, operator)
    }

    /// `flags` is a Side bitfield: bit 0 mint, bit 1 redeem, 0 = off. Instant in BOTH
    /// directions; the handler explains why that inverts the usual asymmetry.
    pub fn set_kyc_scope(ctx: Context<SetKycScope>, flags: u8) -> Result<()> {
        instructions::admin::kyc_admin::set_kyc_scope_handler(ctx, flags)
    }

    /// `reference` is a HASH of the provider's record id. NEVER PII, not even hashed PII.
    pub fn attest_kyc(ctx: Context<AttestKyc>, wallet: Pubkey, reference: [u8; 32]) -> Result<()> {
        instructions::admin::kyc_admin::attest_kyc_handler(ctx, wallet, reference)
    }

    pub fn revoke_kyc(ctx: Context<RevokeKyc>, wallet: Pubkey, allow_disarm: bool) -> Result<()> {
        instructions::admin::kyc_admin::revoke_kyc_handler(ctx, wallet, allow_disarm)
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

    // Instant param setters: no timelock, bounded by the compile-time ceilings in state/config.rs.

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

    /// ROUND 5 P1-04. The minimum size of a priced operation, atomic USDC: `amount_usdc` on the mint
    /// side, the gross USDC value of `amount_silv` on the redeem side. Instant in BOTH directions,
    /// bounded by `MIN_OPERATION_CEILING_USDC`; zero disables the floor. It is an availability
    /// control on the strict-anti-replay slot, not a value control, which is why it carries no
    /// timelock. Full reasoning at `caps::set_min_operation_usdc_handler`.
    pub fn set_min_operation_usdc(ctx: Context<SetParam>, new_min_usdc: u64) -> Result<()> {
        instructions::admin::caps::set_min_operation_usdc_handler(ctx, new_min_usdc)
    }

    // FIX A: the redeem throttles are loosen-slow / tighten-fast. This is the ONLY instant path and it
    // takes tighten-direction values only; LOOSENING goes through propose/execute_set_redeem_limits.
    pub fn emergency_tighten_redeem_limits(
        ctx: Context<SetParam>,
        args: instructions::admin::execute::RedeemLimitsArgs,
    ) -> Result<()> {
        instructions::admin::caps::emergency_tighten_redeem_limits_handler(ctx, args)
    }

    // Pre-mint supply model: admin_premint mints SILV against the hard cap into the inventory wallet
    // with no USDC and no oracle read; set_inventory_wallet sets the destination (late-binding).
    /// ROUND 7. Propose a CHANGE of the pre-mint destination. 24h, guardian-cancellable.
    pub fn propose_set_inventory_wallet(
        ctx: Context<ProposeInventoryWallet>,
        new_wallet: Pubkey,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_inventory_wallet_handler(ctx, new_wallet)
    }

    pub fn execute_set_inventory_wallet(
        ctx: Context<ExecuteInventoryWallet>,
        nonce: u64,
    ) -> Result<()> {
        instructions::admin::execute::execute_set_inventory_wallet_handler(ctx, nonce)
    }

    // ROUND 8 T8-03: `set_inventory_wallet` is REMOVED from the program surface. The destination is
    // an `initialize` argument, and the only post-initialize writer is the timelocked pair above.

    pub fn admin_premint(ctx: Context<AdminPremint>, amount: u64) -> Result<()> {
        instructions::admin::premint::premint_handler(ctx, amount)
    }

    /// DEV ONLY: bumps max_staleness_seconds without timelock. Compiled only under the non-default
    /// `dev-hatch` feature, so it is absent from release/deploy builds and from the generated IDL.
    #[cfg(feature = "dev-hatch")]
    pub fn dev_set_max_staleness(ctx: Context<DevSetOracleParam>, secs: u32) -> Result<()> {
        instructions::admin::dev::dev_set_max_staleness_handler(ctx, secs)
    }

    /// DEV ONLY: sets premium_bps_mint + premium_bps_redeem without timelock. Compiled only under the
    /// non-default `dev-hatch` feature, so it is absent from release builds and from the IDL.
    #[cfg(feature = "dev-hatch")]
    pub fn dev_set_premiums(
        ctx: Context<DevSetOracleParam>,
        mint_bps: u16,
        redeem_bps: u16,
    ) -> Result<()> {
        instructions::admin::dev::dev_set_premiums_handler(ctx, mint_bps, redeem_bps)
    }

    /// TEST-HARNESS ONLY (feature `test-harness`), absent from release builds and the IDL. Read-only:
    /// drives the Lazer oracle read path in isolation and returns the price via return-data.
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

    /// SCHEDULES a removal, does not apply it. The guardian keeps full powers for
    /// admin_timelock_seconds and may cancel its own removal, so one admin signature cannot clear the veto.
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

    // Freeze / thaw are NOT Dominion instructions, deliberately. The SILV mint's freeze_authority is
    // the compliance multisig, so freezing or thawing an account is done with direct Token-2022
    // FreezeAccount / ThawAccount transactions signed by that multisig, exactly as seize/clawback goes
    // directly through the PermanentDelegate (D12). Neither changes the authorities assertions.rs pins.

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

    // FIX A: the 24h-timelocked loosen path. The instant tighten lane is emergency_tighten_redeem_limits.
    pub fn propose_set_redeem_limits(
        ctx: Context<ProposeRedeemLimits>,
        args: instructions::admin::execute::RedeemLimitsArgs,
    ) -> Result<()> {
        instructions::admin::propose::propose_set_redeem_limits_handler(ctx, args)
    }

    pub fn execute_set_redeem_limits(ctx: Context<ExecuteRedeemLimits>, nonce: u64) -> Result<()> {
        instructions::admin::execute::execute_set_redeem_limits_handler(ctx, nonce)
    }

    // D7: treasury minimum FLOAT.
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

    // Per-field Option<String>. None = leave that field unchanged (execute skips its CPI, so it
    // cannot be blanked). A provided field must be non-empty and within its size cap.
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
    //
    // REVIEW PASS ON 3bf3097. `close_timelock_account` is REMOVED, and it was the last member of this
    // section. It swept a timelock account left behind by a cancel or an execute, and it required
    // `cancelled || executed_at.is_some()`. Both writers of those fields close the account in the
    // same transaction: `CancelTimelocked` carries `close = rent_recipient`, and so does every one of
    // the ten `Execute*` contexts. Anchor's close runs on exit, drains the lamports and zeroes the
    // account, so no LIVE account can ever hold the state this instruction demanded.
    //
    // It was unreachable, and the repo's own tests said so without anyone reading it: both had to
    // fabricate the state with `clone_timelock(.., |tl| tl.cancelled = true)`, under the comment
    // "Cancel closes the account, so that state is placed directly."
    //
    // This is the sixth instruction in SolidProof T-006. Adding an event to something that cannot
    // execute would satisfy the letter of the finding and tell the reader something false. The
    // honest answer is five instructions carrying events, and a sixth that could never run.
}
