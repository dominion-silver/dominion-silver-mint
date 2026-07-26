use anchor_lang::prelude::*;

#[error_code]
pub enum DominionError {
    #[msg("Protocol is paused")]
    Paused = 6000,
    #[msg("Mint is paused (premium proposal in flight)")]
    MintPaused,
    #[msg("Amount below per-tx minimum")]
    BelowMinimum,
    #[msg("Amount above per-tx maximum")]
    AboveMaximum,
    #[msg("Pyth price update is stale")]
    StaleOracle,
    #[msg("Pyth confidence interval too wide")]
    OracleLowConfidence,
    #[msg("Oracle price outside sanity bounds")]
    PriceOutOfBounds,
    #[msg("Pyth exponent scaling out of safe range")]
    OracleScalingOutOfBounds,
    #[msg("Wrong Pyth feed id")]
    WrongOracleFeed,
    #[msg("Pyth account owner does not match expected receiver program")]
    WrongOracleOwner,
    #[msg("Pyth price update not Full verification level")]
    OracleNotFullyVerified,
    #[msg("Oracle returned a non-positive price")]
    NegativeOraclePrice,
    #[msg("Price moved too much vs last recorded")]
    PriceDeltaExceeded,
    #[msg("Caller not authorized for this instruction")]
    Unauthorized,
    #[msg("Treasury balance below requested payout")]
    InsufficientTreasury,
    #[msg("Operation would breach treasury minimum reserve")]
    TreasuryBelowReserve,
    #[msg("Daily cap exceeded")]
    DailyCapExceeded,
    #[msg("Hourly redeem cap exceeded")]
    HourlyRedeemCapExceeded,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Amount cannot be zero")]
    ZeroAmount,
    #[msg("Pending admin pubkey does not match signer")]
    InvalidPendingAdmin,
    #[msg("Pending admin transfer expired")]
    PendingAdminExpired,
    #[msg("Premium above hard ceiling")]
    PremiumTooHigh,
    #[msg("Combined premium below minimum spread")]
    PremiumSpreadTooLow,
    #[msg("Slippage check failed (output below min_out)")]
    SlippageExceeded,
    #[msg("Token program account does not match expected program id")]
    WrongTokenProgram,
    #[msg("Mint account does not match config")]
    WrongMint,
    #[msg("Treasury account does not match config")]
    WrongTreasury,
    #[msg("Timelock window has not yet elapsed")]
    TimelockNotElapsed,
    #[msg("Timelock action was cancelled")]
    TimelockActionCancelled,
    #[msg("Timelock action already executed")]
    TimelockActionAlreadyExecuted,
    #[msg("SILV mint PermanentDelegate does not match expected")]
    PermanentDelegateMismatch,
    #[msg("SILV mint must not have TransferHook enabled")]
    TransferHookUnexpected,
    #[msg("SILV mint must not have TransferFee enabled")]
    TransferFeeUnexpected,
    #[msg("Provided day_epoch does not match current UTC day")]
    DayEpochMismatch,
    #[msg("Provided hour_epoch does not match current UTC hour")]
    HourEpochMismatch,
    #[msg("Withdraw blocked while protocol is paused")]
    WithdrawBlockedWhilePaused,
    #[msg("Timelock seconds below hard floor (86400)")]
    TimelockTooShort,
    #[msg("Timelock seconds above hard ceiling (604800)")]
    TimelockTooLong,
    #[msg("Guardian is in cooldown after recent removal")]
    GuardianInCooldown,
    #[msg("Guardian count would exceed max")]
    GuardianCountExceeded,
    #[msg("Compliance mode value unchanged")]
    ComplianceModeUnchanged,
    #[msg("Provided nonce does not match expected timelock account")]
    NonceMismatch,
    #[msg("Proposed value is no-op (matches current config)")]
    ProposalNoOp,
    #[msg("Another proposal of the same kind is already active")]
    ProposalAlreadyActive,
    #[msg("Too many active proposals (max 10)")]
    TooManyActiveProposals,
    #[msg("All oracle guard fields are None; nothing to update")]
    OracleGuardsAllNone,
    #[msg("Pyth feed id is empty (all zeros)")]
    InvalidFeedId,
    #[msg("Withdraw recipient ATA owner does not match action_data recipient")]
    WithdrawRecipientMismatch,
    #[msg("Action data is malformed (wrong length or content)")]
    MalformedActionData,
    #[msg("Failed to serialize/deserialize action data")]
    SerializationFailure,
    #[msg("Hourly counter previous-hour PDA mismatch")]
    PrevHourMismatch,
    // CODEX C-01: rug-by-init defense.
    #[msg("SILV mint already has non-zero supply at init (rug-by-init defense)")]
    SilvMintHasPreexistingSupply,
    // CODEX C-02: bootstrap authority validation.
    #[msg("SILV mint authority must be the silv_mint_authority PDA")]
    SilvMintAuthorityMismatch,
    #[msg("SILV mint freeze_authority must be None")]
    SilvFreezeAuthorityMustBeNone,
    // CODEX M-02: external dependency hard-pin.
    #[msg("USDC mint not in known-good allowlist (Circle mainnet/devnet/testnet)")]
    UsdcMintNotAllowed,
    #[msg("Pyth receiver program does not match the official deployment")]
    WrongPythReceiver,
    // CODEX H-03: reserve floor cannot be reduced below absolute minimum.
    #[msg("treasury_min_reserve_bps cannot be reduced below the protocol floor")]
    ReserveFloorBelowMinimum,
    // CODEX 2nd-pass M-01: metadata update authority pinning at init.
    #[msg("SILV mint metadata update_authority must be the silv_metadata_authority PDA")]
    SilvMetadataUpdateAuthorityMismatch,
    // Option B (CONFIRMED_SPEC.md 2026-05-15). APPEND ONLY - never reorder:
    // discriminants are positional and external clients read the numeric code.
    #[msg("Mint would exceed the SILV supply cap")]
    SupplyCapExceeded,
    #[msg("Redemptions are currently disabled by the admin switch")]
    RedemptionsDisabled,
    #[msg("This redemption must use the queued (T+3) path; call redeem_silv_queued")]
    MustUseQueue,
    #[msg("Withdrawal would breach the treasury minimum float")]
    FloorBreached,
    #[msg("Redemption queue delay has not elapsed yet")]
    QueueNotReady,
    #[msg("Redemption request is not in Pending status")]
    RequestNotPending,
    #[msg("Redemption request owner does not match signer")]
    RedeemRequestOwnerMismatch,
    // CODEX P1-03: SILV mint carries a Token-2022 extension outside the strict
    // allowlist {MetadataPointer, TokenMetadata, PermanentDelegate}.
    #[msg("SILV mint has a disallowed Token-2022 extension")]
    DisallowedMintExtension,
    // Codex deferred batch (2026-05-19). APPEND ONLY - never reorder:
    // discriminants are positional and external clients read the numeric code.
    // P2-03: close_settled_redemption rent-reclaim guard.
    #[msg("Redemption request is not in SettledOffchain status")]
    RequestNotSettled,
    // P2-05: per-field metadata bounds (Option<String> + size caps).
    #[msg("Metadata update has no fields set (all None); nothing to update")]
    MetadataNoFields,
    #[msg("Metadata field is present but empty (blanking is not allowed)")]
    MetadataFieldEmpty,
    #[msg("Metadata field exceeds its maximum length")]
    MetadataFieldTooLong,
    // Pyth Lazer (Pyth Pro) oracle migration (2026-06-09). APPEND ONLY.
    // Section 5.2 / 5.2.1 of private/PYTH_PRO_MIGRATION_PLAN.md.
    #[msg("A pinned Lazer account (program/storage/treasury/sysvar/system) did not match")]
    LazerWrongAccount,
    #[msg("The Lazer program account is not executable")]
    LazerProgramNotExecutable,
    #[msg("The Lazer Storage account is too small to read the fee")]
    LazerStorageMalformed,
    #[msg("The Lazer single-update fee exceeds the Dominion ceiling")]
    LazerFeeTooHigh,
    #[msg("The Lazer fee-payer PDA did not match the expected derivation")]
    LazerFeePayerMismatch,
    #[msg("verify_message returned no return-data")]
    LazerReturnDataMissing,
    #[msg("verify_message return-data came from the wrong program")]
    LazerReturnDataWrongProgram,
    #[msg("verify_message return-data is malformed (length / trailing bytes)")]
    LazerReturnDataMalformed,
    #[msg("Lazer payload parse/extraction failed")]
    LazerPayloadInvalid,
    #[msg("The inbound Lazer message exceeds the size cap")]
    LazerMessageTooLarge,
    #[msg("Lazer publisher count below the required floor")]
    LazerTooFewPublishers,
    #[msg("Lazer price is carried-forward (feedUpdateTimestamp mismatch / non-monotonic)")]
    LazerCarriedForward,
    #[msg("Lazer payload channel does not match the configured channel")]
    LazerWrongChannel,
    // Launch spec 2026-07 (lean launch: pre-mint + hard cap, KYC/PoR deferred).
    // APPEND ONLY - never reorder.
    #[msg("Supply cap can only be lowered instantly; raising it is not available at launch")]
    SupplyCapRaiseBlocked,
    #[msg("Public direct mint is disabled (closed at launch; opens with KYC in Phase 1)")]
    PublicMintDisabled,
    #[msg("Inventory wallet is not set; call set_inventory_wallet first")]
    InventoryWalletNotSet,
    #[msg("Pre-mint destination is not owned by the configured inventory wallet")]
    InvalidInventoryDestination,
    #[msg(
        "Enabling redemptions is blocked at launch; it opens with the Phase 1 KYC/redeem upgrade"
    )]
    RedemptionsEnableBlocked,
    #[msg("SILV mint freeze_authority does not match config.freeze_authority_expected")]
    SilvFreezeAuthorityMismatch,
    // FIX A (launch spec 2026-07): loosen-slow / tighten-fast on the redeem
    // throttles. APPEND ONLY - never reorder.
    #[msg("Loosening a redeem throttle requires the 24h timelock (propose_set_redeem_limits); only tightening is instant")]
    LooseningRequiresTimelock,
    #[msg("At least one redeem-limit field must be provided")]
    RedeemLimitsAllNone,
    // Audit remediation wave 0 (2026-07-25). APPEND ONLY - never reorder.
    #[msg("initialize must be signed by the program's upgrade authority")]
    DeployerNotUpgradeAuthority,
    #[msg("initialize requires an upgradeable program: initialize before revoking the upgrade authority")]
    ProgramNotUpgradeable,
    // NOTE: a TreasuryAtaMismatch variant was added and then REMOVED before the
    // IDL was regenerated. Anchor's own init_if_needed codegen already validates
    // the existing ATA (mint, owner, token program, derived address) and raises
    // ConstraintTokenMint / ConstraintTokenOwner / AccountNotAssociatedTokenAccount,
    // so the variant was unreachable and would have permanently occupied a
    // discriminant. Removed while it was still safe to remove.
    #[msg("Queue delay below the hard floor (loosening the queue below it would remove the only throttle on the queued path)")]
    QueueDelayTooShort,
    #[msg("Removing this guardian would take the active set below the floor; add a replacement guardian first")]
    GuardianFloorBreached,
    #[msg("A removal is already scheduled for this guardian")]
    GuardianRemovalAlreadyScheduled,
    #[msg("No removal is scheduled for this guardian")]
    GuardianRemovalNotScheduled,

    #[msg("Supply cap cannot be set below the SILV already minted (it would permanently brick minting, since raising the cap is blocked)")]
    SupplyCapBelowSupply,
    // AUDIT review of daac4ac (P1): a scheduled removal used to stay armed forever
    // once matured, which turned it into a stored instant-removal coupon.
    #[msg("Guardian removal notice has expired; schedule a new one")]
    GuardianRemovalExpired,
    // AUDIT review of daac4ac (P0): the targeted guardian's self-veto is capped at
    // one use, otherwise a rogue guardian is permanently unremovable.
    #[msg("This guardian has already used its one self-cancel")]
    GuardianSelfCancelExhausted,
}
