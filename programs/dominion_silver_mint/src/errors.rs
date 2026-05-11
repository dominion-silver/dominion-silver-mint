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
    #[msg("Timelock seconds below hard floor (3600)")]
    TimelockTooShort,
    #[msg("Timelock seconds above hard ceiling (2592000)")]
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
}
