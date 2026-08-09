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
    // RETIRED, never raised: the launch design REQUIRES a freeze authority to be present and to match
    // config.freeze_authority_expected (see SilvFreezeAuthorityMismatch). Kept as a reserved hole
    // because discriminants are positional, so deleting it would renumber every later variant.
    #[msg("RETIRED: no longer raised. The SILV mint freeze_authority is REQUIRED to be present and to match config.freeze_authority_expected; see SilvFreezeAuthorityMismatch")]
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
    // P1-03: an extension outside the allowlist (MetadataPointer, TokenMetadata, PermanentDelegate).
    #[msg("SILV mint has a disallowed Token-2022 extension")]
    DisallowedMintExtension,
    // Codex deferred batch (2026-05-19). APPEND ONLY.
    #[msg("Redemption request is not in SettledOffchain status")]
    RequestNotSettled,
    // P2-05: per-field metadata bounds (Option<String> + size caps).
    #[msg("Metadata update has no fields set (all None); nothing to update")]
    MetadataNoFields,
    #[msg("Metadata field is present but empty (blanking is not allowed)")]
    MetadataFieldEmpty,
    #[msg("Metadata field exceeds its maximum length")]
    MetadataFieldTooLong,
    // Pyth Lazer oracle migration (2026-06-09). APPEND ONLY.
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
    // Launch spec 2026-07 (pre-mint + hard cap, KYC/PoR deferred). APPEND ONLY.
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
    // FIX A: loosen-slow / tighten-fast on the redeem throttles. APPEND ONLY.
    #[msg("Loosening a redeem throttle requires the 24h timelock (propose_set_redeem_limits); only tightening is instant")]
    LooseningRequiresTimelock,
    #[msg("At least one redeem-limit field must be provided")]
    RedeemLimitsAllNone,
    // Audit remediation wave 0 (2026-07-25). APPEND ONLY - never reorder.
    #[msg("initialize must be signed by the program's upgrade authority")]
    DeployerNotUpgradeAuthority,
    #[msg("initialize requires an upgradeable program: initialize before revoking the upgrade authority")]
    ProgramNotUpgradeable,
    // A TreasuryAtaMismatch variant was removed here before the IDL was regenerated: Anchor's own
    // init_if_needed codegen already validates the existing ATA and raises its own constraint errors,
    // so the variant was unreachable.
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
    // A matured removal must expire, or it becomes a stored instant-removal coupon.
    #[msg("Guardian removal notice has expired; schedule a new one")]
    GuardianRemovalExpired,
    // The targeted guardian's self-veto is capped at one use, or a rogue guardian is unremovable.
    #[msg("This guardian has already used its one self-cancel")]
    GuardianSelfCancelExhausted,
    // "Mint at launch" phase (Thomas, 2026-07-26).
    #[msg("Public mint is already in the requested state")]
    PublicMintUnchanged,
    #[msg("Opening the public mint requires the 24h timelock; only CLOSING it is instant")]
    PublicMintOpenRequiresTimelock,
    // Pre-mainnet upgrade (2026-08-05): instant redeem, fee routing, whitelist, KYC. APPEND ONLY.
    #[msg("This redemption would exceed the global rolling redeem budget for the current window; retry after the window rolls or ask the admin to raise it")]
    RedeemLimitExceeded,
    #[msg("This wallet has no KYC attestation and KYC is currently required for this action")]
    KycRequired,
    #[msg("KYC cannot be enabled while config.kyc_operator is unset: enabling it with no attestor would lock out every holder with no way to approve anyone")]
    KycAttestorNotSet,
    // GOTCHA for the next variant: these messages go through a FORMAT string in Anchor's
    // #[error_code] expansion, so a literal brace is read as a placeholder and fails the build with
    // "invalid format string". Write "mint and redeem", never braces (escaping as {{ }} reads badly).
    #[msg("KYC scope value is unchanged, or sets bits other than mint and redeem")]
    KycScopeInvalid,
    #[msg("Fee-exemption flags must be 1 (mint), 2 (redeem) or 3 (both). Zero and any undefined bit are refused; use remove_fee_exempt to revoke an exemption entirely")]
    FeeExemptFlagsInvalid,
    #[msg("Fee vault balance is below the requested sweep amount")]
    InsufficientFeeVault,
    #[msg("Attestation account does not belong to the signing wallet")]
    AttestationWalletMismatch,
    // Review-of-fixes 2026-08-05. APPEND ONLY.
    #[msg("Fee-exemption expiry is invalid: it is MANDATORY and must be a unix timestamp in SECONDS, strictly in the future, at most MAX_FEE_EXEMPT_TERM_SECONDS away. Zero is NOT an indefinite term. A 13-digit millisecond value is rejected here.")]
    FeeExemptExpiryInvalid,
    #[msg("withdraw_fees destination must not be owned by the fee-vault PDA: funds sent there could never be moved again")]
    FeeWithdrawDestinationStranded,

    /// C-02: arming with an empty roster locks every holder out of the gated side, so the roster
    /// itself is the check. Write at least one attestation (`attest_kyc`) first, then arm.
    #[msg("KYC cannot be armed with zero attestations: attest at least one wallet first")]
    KycNoAttestationsYet,

    /// C-02: clearing `kyc_operator` while a side is gated means no NEW attestation can ever be
    /// written, shutting out every holder not already attested. Disarm first, then decommission.
    #[msg("cannot clear the KYC operator while the gate is armed: disarm the scope first")]
    KycOperatorRequiredWhileArmed,

    /// C-02, the arming invariant from the other side: revoking the last attestation while a side is
    /// gated leaves an armed gate nobody can pass. Disarm first, then revoke.
    #[msg(
        "cannot revoke the last KYC attestation while the gate is armed: disarm the scope first"
    )]
    KycLastAttestationWhileArmed,

    /// C-02: `Pubkey::default()` (the system program) can never present itself as a holder, so
    /// attesting it would fill the roster without admitting anybody. Narrower than proving the holder
    /// is real, which is the off-chain provider pipeline.
    #[msg("that wallet cannot be attested: it can never sign as a holder")]
    KycSubjectInvalid,

    /// Revoking this attestation would EMPTY the roster while the gate is armed, which DROPS the gate,
    /// so the admin has to ask for that explicitly with `allow_disarm = true`. The disarm is otherwise
    /// reachable by ORDERING rather than by authority: the attestor can revoke down to a roster of one,
    /// and the admin's next revocation, whatever it was for, un-gates both sides. Squads transactions
    /// execute later than they are approved, so the consent has to sit in the signed message.
    #[msg("this revocation would empty the roster and DISARM the KYC gate: pass allow_disarm to confirm")]
    KycRevokeWouldDisarm,

    /// The attestor is a hot server key that signs every approval; the admin is the Squads vault. If
    /// the two are ever equal, "admin only" stops meaning anything and a leaked attestor key silently
    /// becomes an admin key for this instruction.
    #[msg("the KYC attestor may not be the admin key: the whole hot/cold split depends on them differing")]
    KycOperatorMayNotBeAdmin,

    /// ROUND 5 P1-04. The operation is below `config.min_operation_usdc`: `amount_usdc` on the mint
    /// side, the gross USDC value of `amount_silv` on the redeem side. The floor is what stops a dust
    /// operation from consuming the single global Lazer high-water slot for essentially nothing; see
    /// `ConfigAccount::min_operation_usdc`. It names the field rather than a number, because the live
    /// floor is admin-settable and a hardcoded value here would be the next stale string.
    #[msg("operation is below config.min_operation_usdc: read the live floor before retrying")]
    OperationBelowMinimum,

    /// ROUND 5 P1-04. The requested floor exceeds `MIN_OPERATION_CEILING_USDC`. The floor bounds
    /// availability, not value, so the rail bounds how far it can be pushed toward locking users out.
    #[msg("the requested minimum operation size exceeds MIN_OPERATION_CEILING_USDC")]
    MinOperationTooHigh,

    /// ROUND 5 P1-04. Writing the value already stored. Refused for the same reason the other instant
    /// setters here refuse a no-op: a success in an audit log reads as a change that happened.
    #[msg("the minimum operation size already holds that value")]
    MinOperationUnchanged,

    /// ROUND 5, found while writing the P1-03 persistence tests. `LazerPolicyError::NonMonotonic` and
    /// `LazerPolicyError::CarriedForward` both used to surface as `LazerCarriedForward`, so the two
    /// most common refusals on the priced path were indistinguishable to a caller.
    ///
    /// That collapse was tolerable while the anti-replay was `<`, because a replay was rare. D2 made
    /// it `<=`, so ONE operation per Lazer print is now the normal steady state and losing the race is
    /// the single most likely thing a user hits. "Carried-forward oracle" tells them the feed is
    /// broken; this tells them to retry with a newer price, which is the truth and the fix.
    ///
    /// Appended at the END of the enum, so no existing error number moves.
    #[msg("this price envelope was already used: another operation consumed it, retry with a fresh price")]
    LazerReplayed,

    /// ROUND 7. `set_inventory_wallet` is instant ONLY for the first binding, when the field is still
    /// the default. Any CHANGE is a redirect of where pre-minted supply lands, and goes through the
    /// 24h timelock so a guardian can cancel it.
    #[msg("the inventory wallet is already set: changing it requires propose_set_inventory_wallet and the 24h timelock")]
    InventoryWalletChangeRequiresTimelock,

    /// Proposing the value already stored: a 24h window and a guardian's attention for a no-op.
    #[msg("the proposed inventory wallet is the one already configured")]
    InventoryWalletUnchanged,

    /// ROUND 8. Unpausing with no registered guardian would switch on every flow before the
    /// independent brake exists. Every timelock in this program assumes someone can cancel.
    #[msg("no active guardian is registered: unpause would enable every flow with no independent brake")]
    NoActiveGuardian,

    /// A guardian slot held by the current admin is a brake wired to the same lever.
    #[msg("the supplied guardian is the current admin, so it is not an independent brake")]
    GuardianNotIndependent,
}
