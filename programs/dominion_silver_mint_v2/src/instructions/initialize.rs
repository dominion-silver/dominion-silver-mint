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

    // Premium
    pub premium_bps_mint: u16, // e.g. 150 (1.5%); ceiling 300 (launch spec 2026-07)
    pub premium_bps_redeem: u16, // e.g. 200 (2%); ceiling 500 (launch spec 2026-07)

    // Oracle (Pyth Lazer). The program/storage/treasury are compile-time
    // constants; only the numeric feed id is an init arg.
    pub pyth_lazer_feed_id: u32, // SILV = 3304

    // Option B (CONFIRMED_SPEC.md): per-tx/daily/hourly caps + on-chain
    // reserve REMOVED. All Option B economic params default at init and are
    // admin-tunable from the panel post-deploy (CONFIRMED_SPEC.md Section 6).

    // Optional overrides (else defaults)
    pub admin_timelock_seconds: u32, // default 86400, bounds [86400, 604800] (24h..7d, launch spec 2026-07)
    pub max_guardian_count: u8,      // default 3
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = deployer,
        space = ConfigAccount::SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub deployer: Signer<'info>,

    // === AUDIT WAVE 0, finding DOM-001 (P0): authenticate the initializer. ===
    //
    // Before this, `deployer` was an unconstrained Signer: ANY key could call
    // initialize on a freshly deployed program id, seize the single [CONFIG_SEED]
    // PDA, set itself as `config.admin` (the handler writes args.admin verbatim),
    // then unpause, redirect the inventory and pre-mint the whole supply cap.
    // `initialize` is a separate transaction from `solana program deploy`, so the
    // window is real and observable on-chain.
    //
    // The fix binds the signer to the program's UPGRADE AUTHORITY, chaining every
    // link so a forged ProgramData cannot be substituted:
    //   1. `Program<'info, program::DominionSilverMint>` makes Anchor require this
    //      account to be executable AND to equal `crate::ID` (an attacker cannot
    //      point at their own program).
    //   2. `programdata_address()` reads the PROGRAM account's own state, so the
    //      expected ProgramData address is derived from chain data, not supplied.
    //      It returns Some only for a bpf_loader_upgradeable program.
    //   3. The constraint pins the supplied `program_data` to exactly that address,
    //      which is what stops an attacker passing the ProgramData of a program
    //      they control.
    //   4. `Account<'info, ProgramData>` enforces owner == bpf_loader_upgradeable
    //      and that the account really deserializes as the ProgramData variant
    //      (not a Buffer, not a Program).
    //   5. The handler then requires upgrade_authority_address == Some(deployer).
    //
    // Immutable-program case (decided, audit action 0.1): if the upgrade authority
    // has been revoked, `upgrade_authority_address` is None and initialize is
    // refused with ProgramNotUpgradeable. Initialization must therefore happen
    // BEFORE revoking the upgrade authority, which the launch gate already
    // requires (the authority is retained until the later phases ship). A
    // compile-time bootstrap key was rejected as a second privileged constant to
    // guard for no operational gain.
    #[account(
        constraint = dominion_program.programdata_address()?
            == Some(program_data.key()) @ DominionError::Unauthorized,
    )]
    pub dominion_program: Program<'info, crate::program::DominionSilverMint>,

    pub program_data: Account<'info, ProgramData>,

    // Treasury PDA (authority for the USDC ATA we create below).
    /// CHECK: derived deterministically; signs USDC transfer out via seeds.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury_pda: AccountInfo<'info>,

    // USDC mint (classic SPL Token).
    #[account(mint::token_program = classic_token_program)]
    pub usdc_mint: Account<'info, ClassicMint>,

    // SILV mint (SPL Token-2022) - already created with PermanentDelegate + metadata.
    #[account(mint::token_program = token_2022_program)]
    pub silv_mint: InterfaceAccount<'info, InterfaceMint>,

    // Treasury USDC ATA, owned by treasury_pda.
    //
    // AUDIT WAVE 0, finding DOM-002 (P1): this was `init`, which fails when the
    // account already exists. Creating an associated token account is
    // permissionless (anyone may create the ATA of any owner/mint pair), so a
    // third party could pre-create exactly this ATA and make `initialize` fail
    // forever, denying the launch until a tolerant program version is deployed.
    //
    // `init_if_needed` closes it: when the account is absent Anchor creates it,
    // and when it is already present Anchor VALIDATES it against the same three
    // constraints below (mint, authority, token program), so a pre-created
    // account is only accepted if it is byte-for-byte the account we would have
    // created ourselves. A wrong-mint or wrong-owner account still fails.
    //
    // The usual `init_if_needed` hazard (an attacker re-running an initializer to
    // reset state) does not apply here: there is no per-account initialization
    // logic beyond creation, and since DOM-001 this instruction can only be
    // called by the program's upgrade authority.
    #[account(
        init_if_needed,
        payer = deployer,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub usdc_treasury: Account<'info, TokenAccount>,

    pub classic_token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    // DOM-001 (P0): the signer must BE the program's upgrade authority. The
    // Accounts struct already proved that `program_data` is the genuine
    // ProgramData of THIS program (see the chain documented there); this is the
    // final link. Checked first, before any argument validation, so an
    // unauthorized caller learns nothing about the accepted parameters.
    let upgrade_authority = ctx
        .accounts
        .program_data
        .upgrade_authority_address
        // None means the upgrade authority was revoked and the program is
        // immutable. Decided in audit action 0.1: refuse, rather than fall back
        // to a second privileged constant. Initialize before revoking.
        .ok_or(error!(DominionError::ProgramNotUpgradeable))?;
    require_keys_eq!(
        upgrade_authority,
        ctx.accounts.deployer.key(),
        DominionError::DeployerNotUpgradeAuthority
    );

    // Validate args.
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

    // Option B: per-tx/daily/hourly/reserve cap sanity checks removed (those
    // params no longer exist; Option B uses a hard supply cap + rolling-window
    // instant budget + float, all defaulted here and admin-tuned post-deploy).

    // SC-H1: validate token decimals at init. The mint/redeem math hard-codes
    // 6 decimals for both USDC and SILV (see math.rs). If SILV is created
    // off-chain with the Token-2022 example default of 9, the program would
    // silently produce 1000x-off outputs (mint loss for users / treasury drain
    // on redeem). Pinning at init means the assumption is checked once and
    // never relaxed.
    require!(
        ctx.accounts.usdc_mint.decimals == 6,
        DominionError::WrongMint
    );
    require!(
        ctx.accounts.silv_mint.decimals == 6,
        DominionError::WrongMint
    );

    // CODEX M-02: hard-pin USDC mint to a known-good allowlist (Circle's
    // official mainnet/devnet/testnet mints). Without this, the deployer
    // could pass a fake "USDC" with 6 decimals that they fully control,
    // letting them mint SILV against worthless reserves.
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

    // Pyth Lazer migration: the receiver-program pin is gone (the Lazer program
    // is a compile-time constant in lazer_cpi.rs, validated on every verify
    // CPI). Only the numeric feed id is configurable.

    // CODEX C-01: rug-by-init defense. Off-chain SILV mint creation is a
    // 2-phase script (deployer creates with their authority, then transfers
    // authority to the silv_mint_authority PDA). Between phase 1 and 2, the
    // deployer COULD pre-mint X SILV to themselves, then call initialize.
    // The program would treat those pre-minted tokens as legitimate SILV
    // (no way to distinguish them from later-minted ones), and the deployer
    // could redeem them against the USDC reserve.
    //
    // Mitigation: require supply == 0 at init. Pre-minted tokens are now
    // detectable on-chain and reject the init.
    require!(
        ctx.accounts.silv_mint.supply == 0,
        DominionError::SilvMintHasPreexistingSupply
    );

    // CODEX C-02: enforce on-chain that the SILV mint authorities match the
    // documented invariants. Without this, the deployer could keep
    // mint_authority off-chain (silently mint SILV at will hors-program) or
    // set a freeze_authority that does not match the disclosed compliance multisig.
    //
    // The mint_authority must be the silv_mint_authority PDA (owned by this
    // program), so only mint_silv via this contract can produce SILV.
    // The freeze_authority must equal the expected compliance multisig (launch
    // spec 2026-07: Mark confirmed the freeze lever alongside the PermanentDelegate
    // seize/clawback). Both are permanent Token-2022 powers fixed here at creation.
    let (silv_mint_auth_pda, _) =
        Pubkey::find_program_address(&[SILV_MINT_AUTHORITY_SEED], ctx.program_id);
    let mint_authority_opt: Option<Pubkey> = ctx.accounts.silv_mint.mint_authority.into();
    require!(
        mint_authority_opt == Some(silv_mint_auth_pda),
        DominionError::SilvMintAuthorityMismatch
    );
    // Launch spec 2026-07 (Mark, freeze + seize confirmed): the SILV mint carries
    // a freeze authority (the compliance lever, e.g. OFAC/court order) in addition
    // to the PermanentDelegate (the seize/clawback lever). Both are locked at mint
    // creation. Pin the freeze authority to the expected compliance multisig from
    // block 0 (mirrors the PermanentDelegate pin below); it must be a real key, not
    // None and not the zero pubkey.
    let freeze_authority_opt: Option<Pubkey> = ctx.accounts.silv_mint.freeze_authority.into();
    require!(
        args.freeze_authority_expected != Pubkey::default(),
        DominionError::SilvFreezeAuthorityMismatch
    );
    require!(
        freeze_authority_opt == Some(args.freeze_authority_expected),
        DominionError::SilvFreezeAuthorityMismatch
    );

    // CODEX 2nd-pass M-01: pin the Token-2022 metadata extension's update
    // authority at init. The execute_update_metadata path assumes the update
    // authority is the silv_metadata_authority PDA; without on-chain
    // verification, the deployer could keep the metadata update authority
    // off-chain and change name/symbol/uri without going through governance.
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

        // MetadataPointer extension: assert (a) authority = silv_metadata_authority
        // PDA and (b) metadata_address points to the mint itself (in-mint metadata
        // pattern, NOT a separate metadata account).
        // CODEX 3rd-pass M-1: without metadata_address pinning, off-chain bootstrap
        // could steer wallets/indexers toward metadata that the on-chain governance
        // path (execute_update_metadata) does not actually control.
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

        // TokenMetadata extension: assert (a) update_authority = silv_metadata_authority
        // PDA and (b) the embedded `mint` field points back to the mint itself
        // (consistency with MetadataPointer.metadata_address above).
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

        // CODEX P1-03: verify the PermanentDelegate AT INIT (previously only
        // checked at runtime in assertions.rs). PermanentDelegate is the one
        // privileged compliance capability (D12); its delegate must equal the
        // expected Ops vault from block 0, not be discovered on the first user
        // instruction.
        let pd = mint_with_ext
            .get_extension::<PermanentDelegate>()
            .map_err(|_| error!(DominionError::PermanentDelegateMismatch))?;
        let pd_opt: Option<Pubkey> = Option::<Pubkey>::from(pd.delegate);
        require!(
            pd_opt == Some(args.permanent_delegate_expected),
            DominionError::PermanentDelegateMismatch
        );

        // CODEX P1-03: STRICT Token-2022 extension allowlist. The SILV mint may
        // carry ONLY MetadataPointer + TokenMetadata + PermanentDelegate. Any
        // other extension (MintCloseAuthority, DefaultAccountState,
        // NonTransferable, InterestBearingConfig, TransferHook, TransferFee,
        // ConfidentialTransfer, GroupPointer, ...) can silently alter token
        // behaviour or break future assumptions, and is rejected at bootstrap.
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

    // Option B economic params: all default at init, admin-tunable post-deploy
    // (CONFIRMED_SPEC.md Section 6). D2 cap, D7 float, D8/D10 redemption routing
    // + rolling-window instant budget, D11 manual redemptions switch.
    config.max_silv_supply = DEFAULT_MAX_SILV_SUPPLY;
    config.treasury_min_float_usdc = DEFAULT_TREASURY_MIN_FLOAT_USDC;
    // Launch spec 2026-07: public direct redeem is CLOSED at launch (users exit by
    // selling on the DEX; direct redeem needs KYC, which ships in Phase 1). Opened
    // by the admin switch once KYC is live.
    config.redemptions_enabled = false;
    config.large_redeem_threshold_usdc = DEFAULT_LARGE_REDEEM_THRESHOLD_USDC;
    config.instant_redeem_budget_usdc = DEFAULT_INSTANT_REDEEM_BUDGET_USDC;
    config.instant_redeem_window_seconds = DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS;
    config.redeem_queue_delay_seconds = DEFAULT_REDEEM_QUEUE_DELAY_SECONDS;
    config.instant_window_start = 0; // bootstraps to `now` on the first redeem
    config.instant_used_usdc = 0;
    config.next_redeem_request_nonce = 0;

    config.admin_timelock_seconds = admin_timelock;
    config.max_guardian_count = max_guardians;
    config.guardian_count = 0;

    config.mint_paused_until = 0;
    // Pyth Lazer migration (5.7): fresh deploy starts PAUSED. The operating
    // Tier B oracle bounds (max_staleness, max_confidence_bps, min/max price,
    // min_publishers) MUST be set from live SILV data + signed off BEFORE the
    // admin unpauses; no mint/redeem/claim oracle read passes while paused.
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

    // --- Launch spec 2026-07 additions (safe launch defaults) ---
    config.pending_admin_eta = 0;
    config.pending_max_supply_nonce = None;
    // FIX A: no redeem-limits change is pending at init.
    config.pending_redeem_limits_nonce = None;
    // Inventory wallet is set via set_inventory_wallet before the first pre-mint.
    config.inventory_wallet = Pubkey::default();
    // Public direct mint closed at launch (opens with KYC in Phase 1).
    config.public_mint_enabled = DEFAULT_PUBLIC_MINT_ENABLED;
    // Phase 1 KYC hooks (reserved, unused at launch).
    config.kyc_operator = Pubkey::default();
    config.kyc_enforced = false;
    config.pending_kyc_operator_nonce = None;
    // Phase 2 PoR hooks (reserved; launch backing is the manual max_silv_supply cap).
    config.por_feed = Pubkey::default();
    config.por_max_staleness_seconds = 0;
    config.por_enforced = false;
    config.pending_por_feed_nonce = None;
    // Phase 1 granular pauses (reserved; the global `paused` is used at launch).
    config.mint_paused = false;
    config.redeem_paused = false;

    config.pending_removal_count = 0;
    config.version = 2; // launch spec 2026-07 schema
    config.pending_public_mint_nonce = None;
    config.reserved = [0u8; 54];

    msg!("dominion_silver_mint initialized");
    Ok(())
}
