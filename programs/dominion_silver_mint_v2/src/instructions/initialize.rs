// Initialize the program: create ConfigAccount + treasury USDC ATA in one shot.
// Deployer signs. SILV mint must already be created off-chain (with PermanentDelegate + metadata extensions).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};
use anchor_spl::token_interface::{Mint as InterfaceMint, Token2022};

use crate::errors::DominionError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    // Authorities
    pub admin: Pubkey,                       // Ops Squads
    pub upgrade_authority_info: Pubkey,      // info-only: separate Upgrade Squads
    pub permanent_delegate_expected: Pubkey, // seize/clawback authority (Ops/compliance multisig)
    pub freeze_authority_expected: Pubkey, // freeze authority (Ops/compliance multisig), set at mint creation

    // Compliance off at launch
    pub compliance_mode: bool, // false at launch

    // Premium. Launch values 100 / 150 bps; ceilings PREMIUM_BPS_*_CEILING (config.rs).
    pub premium_bps_mint: u16,
    pub premium_bps_redeem: u16,

    // Oracle (Pyth Lazer). The program/storage/treasury are compile-time constants; only the numeric
    // feed id is an init arg. Feed 3154 (Metal.Index.SILVER/USD) is pure spot, no embedded premium.
    pub pyth_lazer_feed_id: u32,

    // Optional overrides (else defaults)
    pub admin_timelock_seconds: u32, // default 86400, bounds [86400, 604800] (24h..7d)
    pub max_guardian_count: u8,      // default 3

    /// option A. The pre-mint DESTINATION, bound ATOMICALLY with the rest of the
    /// configuration, and the instant setter that used to bind it is DELETED.
    /// The round-7 shape kept a one-shot instant binding on the argument that with the field unset
    /// there was "nothing to steal". That argument was wrong, and the refutation is clean: compromise
    /// the Ops key DURING the ceremony, BEFORE the legitimate binding. The attacker binds their own
    /// wallet, unpauses, and issues up to the whole hard cap into their ATA, with no delay and no
    /// guardian veto. It confused supply already minted with issuance power still available.
    /// Appended LAST, so the 142-byte prefix of the previous layout is untouched and the only
    /// difference on the wire is 32 more bytes.
    pub inventory_wallet: Pubkey,

    /// The FIRST guardian, appointed in this transaction.
    /// WHY IT IS AN ARGUMENT AND NOT A LATER CALL. `unpause` demands an active GuardianAccount whose
    /// key differs from the admin, and that closes the two syntactic holes (no guardian at all, and a
    /// guardian that IS the admin). It does not establish that an independent brake exists, because
    /// `add_guardian` was admin-only: a compromised Ops could mint its own guardian keys, fill the
    /// slots, present one to `unpause` and hold every power the timelocks assume somebody else holds.
    /// A second keypair created by Ops is not independence.
    /// No on-chain check can PROVE independence. What this moves is the trust boundary. Binding the
    /// first guardian here puts it in the same authenticated transaction as `config.admin`, under the
    /// chain, inside the ceremony artifact that is reviewed and diffed before it is signed.
    /// It becomes evidence somebody audits, instead of a call Ops can make later and alone. Every
    /// LATER appointment additionally requires the named key to sign (`add_guardian`), so the set can
    /// never grow without the consent of the key being added.
    /// Validated non-default and distinct from `admin`: a zero would leave `guardian_count = 1` with
    /// no usable brake, and an admin-held slot is a brake wired to the same lever.
    /// Appended LAST for the same reason as the field above.
    pub guardian: Pubkey,
}

/// EVERY LARGE ACCOUNT HERE IS BOXED, and that is load-bearing rather than stylistic.
/// Adding `first_guardian` pushed `try_accounts` past the 4KB BPF stack frame:
/// `Account<'info, T>` holds the deserialized `T` INLINE, and `ConfigAccount` alone is 800 bytes.
/// `cargo build-sbf` reported "Stack offset of 4112 exceeded max offset of 4096 by 16 bytes" and
/// then EXITED 0. The overflow silently zeroed 16 bytes of a neighbouring account, so the SILV mint
/// authority read back as the right key with a hole in the middle and `initialize` failed with
/// SilvMintAuthorityMismatch: a correct check reporting a corrupted input.
/// The 16 corrupted bytes and the "by 16 bytes" in the warning are the same 16 bytes. Boxing moves
/// the payloads to the heap. `tools/state-harness/run.sh` now FAILS on that message, because a
/// warning that exits 0 is a warning nobody reads.
#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = deployer,
        space = ConfigAccount::SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub deployer: Signer<'info>,

    // authenticate the initializer, who must be the program's UPGRADE AUTHORITY. `initialize`
    // is a separate transaction from `solana program deploy`, so an unconstrained Signer let ANY key
    // seize the single [CONFIG_SEED] PDA and make itself `config.admin`.
    // Every link is chained so a forged ProgramData cannot be substituted: `Program<..>` forces this
    // account to equal `crate::ID`; `programdata_address()` derives the expected ProgramData address
    // from the PROGRAM account's own state (Some only under bpf_loader_upgradeable); the constraint
    // pins the supplied `program_data` to it; `Account<ProgramData>` enforces the loader as owner and
    // the ProgramData variant; and the handler requires upgrade_authority_address == Some(deployer).
    // An immutable program (authority revoked) is REFUSED: initialize before revoking.
    #[account(
        constraint = dominion_program.programdata_address()?
            == Some(program_data.key()) @ DominionError::Unauthorized,
    )]
    pub dominion_program: Program<'info, crate::program::DominionSilverMint>,

    pub program_data: Box<Account<'info, ProgramData>>,

    // Treasury PDA (authority for the USDC ATA we create below).
    /// CHECK: derived deterministically; signs USDC transfer out via seeds.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    // USDC mint (classic SPL Token).
    #[account(mint::token_program = classic_token_program)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    // SILV mint (SPL Token-2022) - already created with PermanentDelegate + metadata.
    #[account(mint::token_program = token_2022_program)]
    pub silv_mint: Box<InterfaceAccount<'info, InterfaceMint>>,

    // Treasury USDC ATA, owned by treasury_pda.
    // `init_if_needed`, not `init`. Creating an ATA is permissionless, so with `init` a third
    // party could pre-create exactly this one and make `initialize` fail forever. An already-present
    // account is VALIDATED against the same three constraints below, so it is accepted only if it is
    // what we would have created. The usual `init_if_needed` hazard does not apply: there is no
    // per-account init logic beyond creation, and only the upgrade authority can call this.
    #[account(
        init_if_needed,
        payer = deployer,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    pub classic_token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The FIRST guardian's account, created here so the independent brake exists in
    /// the same authenticated transaction as `config.admin` rather than in a later admin-only call.
    /// The seed is `args.guardian`, so the account address is a function of the argument and cannot
    /// be pointed at some other key.
    #[account(
        init,
        payer = deployer,
        space = GuardianAccount::SIZE,
        seeds = [GUARDIAN_SEED, args.guardian.as_ref()],
        bump,
    )]
    pub first_guardian: Box<Account<'info, GuardianAccount>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    // the final link. Checked before any argument validation, so an unauthorized caller
    // learns nothing about the accepted parameters.
    let upgrade_authority = ctx
        .accounts
        .program_data
        .upgrade_authority_address
        // None = revoked upgrade authority, i.e. an immutable program. Refused by choice.
        .ok_or(error!(DominionError::ProgramNotUpgradeable))?;
    require_keys_eq!(
        upgrade_authority,
        ctx.accounts.deployer.key(),
        DominionError::DeployerNotUpgradeAuthority
    );

    require!(args.pyth_lazer_feed_id != 0, DominionError::InvalidFeedId);
    require!(args.admin != Pubkey::default(), DominionError::Unauthorized);
    require!(
        args.permanent_delegate_expected != Pubkey::default(),
        DominionError::PermanentDelegateMismatch
    );
    require!(
        args.premium_bps_mint <= PREMIUM_BPS_MINT_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        args.premium_bps_redeem <= PREMIUM_BPS_REDEEM_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (args.premium_bps_mint as u32) + (args.premium_bps_redeem as u32)
            >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );

    // SC-H1: the mint/redeem math hard-codes 6 decimals for both mints (math.rs). A SILV mint created
    // with the Token-2022 example default of 9 would silently produce 1000x-off outputs.
    require!(
        ctx.accounts.usdc_mint.decimals == 6,
        DominionError::WrongMint
    );
    require!(
        ctx.accounts.silv_mint.decimals == 6,
        DominionError::WrongMint
    );

    // hard-pin USDC to Circle's official mints. Without this the deployer could pass a fake
    // "USDC" with 6 decimals that they control, and mint SILV against worthless reserves.
    const USDC_MAINNET: Pubkey =
        anchor_lang::solana_program::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const USDC_DEVNET: Pubkey =
        anchor_lang::solana_program::pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const USDC_TESTNET: Pubkey =
        anchor_lang::solana_program::pubkey!("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");
    let usdc_key = ctx.accounts.usdc_mint.key();
    require!(
        usdc_key == USDC_MAINNET || usdc_key == USDC_DEVNET || usdc_key == USDC_TESTNET,
        DominionError::UsdcMintNotAllowed
    );

    // rug-by-init defense. SILV mint creation is a 2-phase off-chain script, and between the
    // phases the deployer could pre-mint tokens this program cannot tell from legitimate SILV.
    require!(
        ctx.accounts.silv_mint.supply == 0,
        DominionError::SilvMintHasPreexistingSupply
    );

    // mint_authority must be the silv_mint_authority PDA, so only mint_silv through this program
    // can produce SILV. Otherwise the deployer could keep it off-chain and mint at will.
    let (silv_mint_auth_pda, _) =
        Pubkey::find_program_address(&[SILV_MINT_AUTHORITY_SEED], ctx.program_id);
    let mint_authority_opt: Option<Pubkey> = ctx.accounts.silv_mint.mint_authority.into();
    require!(
        mint_authority_opt == Some(silv_mint_auth_pda),
        DominionError::SilvMintAuthorityMismatch
    );
    // The freeze authority is the compliance lever, alongside the PermanentDelegate (seize/clawback).
    // Pinned to the expected multisig from block 0, and it must be a real key, not None and not zero.
    let freeze_authority_opt: Option<Pubkey> = ctx.accounts.silv_mint.freeze_authority.into();
    require!(
        args.freeze_authority_expected != Pubkey::default(),
        DominionError::SilvFreezeAuthorityMismatch
    );
    require!(
        freeze_authority_opt == Some(args.freeze_authority_expected),
        DominionError::SilvFreezeAuthorityMismatch
    );

    // execute_update_metadata assumes the metadata update authority is the silv_metadata_authority
    // PDA. Without this pin the deployer could keep it off-chain and rename the token outside governance.
    {
        use spl_token_2022::extension::{
            metadata_pointer::MetadataPointer, permanent_delegate::PermanentDelegate,
            BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        };
        use spl_token_2022::state::Mint as Token2022Mint;
        use spl_token_metadata_interface::state::TokenMetadata;

        let mint_ai = ctx.accounts.silv_mint.to_account_info();
        let mint_data = mint_ai.try_borrow_data()?;
        let mint_with_ext = StateWithExtensions::<Token2022Mint>::unpack(&mint_data)
            .map_err(|_| error!(DominionError::WrongMint))?;

        // MetadataPointer: authority = the PDA, metadata_address = the mint itself (in-mint metadata, NOT
        // a separate account), or bootstrap could steer wallets toward metadata governance cannot change.
        let mp = mint_with_ext
            .get_extension::<MetadataPointer>()
            .map_err(|_| error!(DominionError::WrongMint))?;
        let (silv_metadata_auth_pda, _) =
            Pubkey::find_program_address(&[SILV_METADATA_AUTHORITY_SEED], ctx.program_id);
        let mp_authority_opt: Option<Pubkey> = Option::<Pubkey>::from(mp.authority);
        require!(
            mp_authority_opt == Some(silv_metadata_auth_pda),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );
        let mp_metadata_address_opt: Option<Pubkey> = Option::<Pubkey>::from(mp.metadata_address);
        require!(
            mp_metadata_address_opt == Some(ctx.accounts.silv_mint.key()),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );

        // TokenMetadata: update_authority = the same PDA, and the embedded `mint` field points back
        // to the mint (consistency with MetadataPointer.metadata_address above).
        let metadata: TokenMetadata = mint_with_ext
            .get_variable_len_extension::<TokenMetadata>()
            .map_err(|_| error!(DominionError::WrongMint))?;
        let md_update_auth_opt: Option<Pubkey> = Option::<Pubkey>::from(metadata.update_authority);
        require!(
            md_update_auth_opt == Some(silv_metadata_auth_pda),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );
        require!(
            metadata.mint == ctx.accounts.silv_mint.key(),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );

        // verify the PermanentDelegate AT INIT, not on the first user instruction. It is the one
        // privileged compliance capability (), so it must match the expected Ops vault from block 0.
        let pd = mint_with_ext
            .get_extension::<PermanentDelegate>()
            .map_err(|_| error!(DominionError::PermanentDelegateMismatch))?;
        let pd_opt: Option<Pubkey> = Option::<Pubkey>::from(pd.delegate);
        require!(
            pd_opt == Some(args.permanent_delegate_expected),
            DominionError::PermanentDelegateMismatch
        );

        // STRICT allowlist. Any other extension (MintCloseAuthority, DefaultAccountState,
        // NonTransferable, TransferHook, TransferFee, ...) can silently alter token behaviour.
        let ext_types = mint_with_ext
            .get_extension_types()
            .map_err(|_| error!(DominionError::WrongMint))?;
        for et in ext_types.iter() {
            require!(
                matches!(
                    et,
                    ExtensionType::MetadataPointer
                        | ExtensionType::TokenMetadata
                        | ExtensionType::PermanentDelegate
                ),
                DominionError::DisallowedMintExtension
            );
        }
    }

    let admin_timelock = if args.admin_timelock_seconds == 0 {
        DEFAULT_ADMIN_TIMELOCK_SECONDS
    } else {
        args.admin_timelock_seconds
    };
    require!(
        admin_timelock >= ADMIN_TIMELOCK_MIN_SECONDS,
        DominionError::TimelockTooShort
    );
    require!(
        admin_timelock <= ADMIN_TIMELOCK_MAX_SECONDS,
        DominionError::TimelockTooLong
    );

    let max_guardians = if args.max_guardian_count == 0 {
        MAX_GUARDIAN_COUNT_DEFAULT
    } else {
        args.max_guardian_count
    };

    let config = &mut ctx.accounts.config;
    config.admin = args.admin;
    config.pending_admin = None;
    config.pending_admin_expires_at = 0;
    config.upgrade_authority_info = args.upgrade_authority_info;

    config.permanent_delegate_expected = args.permanent_delegate_expected;
    config.freeze_authority_expected = args.freeze_authority_expected;
    config.compliance_mode = args.compliance_mode;

    config.premium_bps_mint = args.premium_bps_mint;
    config.premium_bps_redeem = args.premium_bps_redeem;
    // POST-WRITE invariant: the checks above validate a CANDIDATE value, this validates the STORED
    // pair, so a setter that forgets its inline check cannot leave the config out of bounds.
    config.assert_premium_within_bounds()?;

    config.pyth_lazer_feed_id = args.pyth_lazer_feed_id;
    config.min_publishers = DEFAULT_MIN_PUBLISHERS;
    config.last_used_feed_update_timestamp_us = 0;

    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.silv_mint = ctx.accounts.silv_mint.key();
    config.usdc_treasury = ctx.accounts.usdc_treasury.key();
    config.classic_token_program = ctx.accounts.classic_token_program.key();
    config.token_2022_program = ctx.accounts.token_2022_program.key();

    config.max_staleness_seconds = DEFAULT_MAX_STALENESS_SECONDS;
    config.max_confidence_bps = DEFAULT_MAX_CONFIDENCE_BPS;
    config.min_price_usd_scaled = DEFAULT_MIN_PRICE_USD_SCALED;
    config.max_price_usd_scaled = DEFAULT_MAX_PRICE_USD_SCALED;

    config.last_recorded_price_scaled = 0;
    config.last_price_update_at = 0;
    config.max_price_delta_bps = DEFAULT_MAX_PRICE_DELTA_BPS;
    config.price_delta_decay_seconds = DEFAULT_PRICE_DELTA_DECAY_SECONDS;
    config.price_update_min_amount_usdc = DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC;

    // Economic params: all default at init, admin-tunable post-deploy.
    config.max_silv_supply = DEFAULT_MAX_SILV_SUPPLY;
    config.treasury_min_float_usdc = DEFAULT_TREASURY_MIN_FLOAT_USDC;
    // Public direct redeem is CLOSED at launch: users exit by selling on the DEX.
    // launch posture decided by 2026-08-09: mint AND redeem OPEN at initialize, so
    // no base setting costs a 24h wait during the ceremony. Closing stays instant (the emergency
    // direction); re-opening after a close goes through the timelocked SetRedeemLimits, which is the
    // same asymmetry the public mint already has.
    config.redemptions_enabled = true;
    config.large_redeem_threshold_usdc = DEFAULT_LARGE_REDEEM_THRESHOLD_USDC;
    config.instant_redeem_budget_usdc = DEFAULT_INSTANT_REDEEM_BUDGET_USDC;
    config.instant_redeem_window_seconds = DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS;
    config.redeem_queue_delay_seconds = DEFAULT_REDEEM_QUEUE_DELAY_SECONDS;
    config.instant_window_start = 0; // bootstraps to `now` on the first redeem
    config.instant_used_usdc = 0;
    config.next_redeem_request_nonce = 0;

    config.admin_timelock_seconds = admin_timelock;
    config.max_guardian_count = max_guardians;
    // The first guardian is appointed HERE, in the -authenticated transaction,
    // so the independent brake exists before anything can be unpaused and lands in the ceremony
    // artifact that gets reviewed. It used to be 0, and `add_guardian` was admin-only, which let a
    // compromised Ops appoint its own keys later and satisfy `unpause` with a brake it controlled.
    require!(
        args.guardian != Pubkey::default(),
        DominionError::NoActiveGuardian
    );
    // The same independence rule `unpause` enforces, applied at the only moment the pair is chosen
    // together. Refusing it here means the state `unpause` rejects can never be reached at all.
    require!(
        args.guardian != args.admin,
        DominionError::GuardianNotIndependent
    );
    let now = Clock::get()?.unix_timestamp;
    let first_guardian = &mut ctx.accounts.first_guardian;
    first_guardian.guardian = args.guardian;
    first_guardian.added_at = now;
    first_guardian.cooldown_until = 0;
    first_guardian.pending_removal_at = 0;
    first_guardian.self_cancel_used = false;
    first_guardian.version = GUARDIAN_ACCOUNT_VERSION;
    config.guardian_count = 1;

    config.mint_paused_until = 0;
    // A fresh deploy starts PAUSED: the operating oracle bounds MUST be set from live SILV data and
    // signed off before the admin unpauses. No mint/redeem oracle read passes while paused.
    config.paused = true;

    config.next_timelock_nonce = 0;
    config.active_proposal_count = 0;

    config.pending_premium_mint_nonce = None;
    config.pending_premium_redeem_nonce = None;
    config.pending_withdraw_nonce = None;
    config.pending_treasury_float_nonce = None;
    config.pending_oracle_guards_nonce = None;
    config.pending_metadata_nonce = None;
    config.pending_compliance_nonce = None;
    config.pending_pyth_feed_nonce = None;
    config.pending_admin_timelock_nonce = None;

    config.pending_admin_eta = 0;
    config.pending_max_supply_nonce = None;
    config.pending_redeem_limits_nonce = None;
    // Bound here, once, atomically. There is no instruction that can set this from
    // the default afterwards: the only remaining writer is the 24h-timelocked change.
    require!(
        args.inventory_wallet != Pubkey::default(),
        DominionError::InventoryWalletNotSet
    );
    config.inventory_wallet = args.inventory_wallet;
    config.public_mint_enabled = true;
    // KYC gate: on-chain but DORMANT. `kyc_operator` unset is what BLOCKS enabling: set_kyc_scope
    // refuses to arm with no attestor, since a gate that can approve nobody locks out every holder.
    config.kyc_operator = Pubkey::default();
    config.kyc_enforced = false;
    config.pending_kyc_operator_nonce = None;
    // Phase 2 PoR hooks (launch backing is the manual max_silv_supply cap).
    config.por_feed = Pubkey::default();
    config.por_max_staleness_seconds = 0;
    config.por_enforced = false;
    config.pending_por_feed_nonce = None;
    // Phase 1 granular pauses (the global `paused` is used at launch).
    config.mint_paused = false;
    config.redeem_paused = false;

    config.pending_removal_count = 0;
    config.version = 2; // launch spec 2026-07 schema
    config.pending_public_mint_nonce = None;
    // 0 = KYC required nowhere. Must stay consistent with `kyc_enforced = false` above;
    // set_kyc_scope maintains that invariant thereafter.
    config.kyc_scope_flags = 0;
    // No prior bucket at genesis. See state/redeem_window.rs.
    config.instant_used_prev_usdc = 0;
    // Premium routing ON at launch (the field is NEGATED, so false = on). Written explicitly rather
    // than relying on zeroing for meaning.
    config.fee_routing_disabled = false;
    // no attestations exist on a fresh deployment, so the gate cannot be armed until the
    // attestor writes one. Explicit because this value is a SAFETY PRECONDITION.
    config.kyc_attestation_count = 0;
    // Written from the constant, NOT an InitializeArgs field: same treatment as
    // max_silv_supply, and for the same reason. An arg would put the availability floor in the hands
    // of whoever types the ceremony command, and the ceremony is exactly where a wrong number is
    // hardest to notice. Change it here, rebuild, re-audit. The instant setter tunes it afterwards.
    config.min_operation_usdc = DEFAULT_MIN_OPERATION_USDC;
    // No proposal can exist before the program does.
    config.pending_inventory_wallet_nonce = None;
    config.reserved = [0u8; 23];

    msg!("dominion_silver_mint initialized");
    Ok(())
}
