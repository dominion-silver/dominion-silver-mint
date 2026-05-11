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
    pub permanent_delegate_expected: Pubkey, // Ops Squads vault PDA, derived off-chain

    // Compliance off at launch
    pub compliance_mode: bool, // false at launch

    // Premium
    pub premium_bps_mint: u16,   // e.g. 1000 (10%)
    pub premium_bps_redeem: u16, // e.g. 200 (2%)

    // Oracle
    pub pyth_feed_id: [u8; 32], // raw 32 bytes
    pub pyth_receiver_program: Pubkey,

    // Per-tx and daily caps (USDC equivalent, 6dec atomic)
    pub min_mint_amount_usdc: u64,
    pub max_mint_amount_per_tx_usdc: u64,
    pub min_redeem_amount_usdc: u64,
    pub max_redeem_amount_per_tx_usdc: u64,
    pub daily_mint_cap_usdc: u64,
    pub daily_redeem_cap_usdc: u64,

    // Hourly cap and reserve
    pub hourly_redeem_cap_bps_of_snapshot: u16,
    pub treasury_min_reserve_bps: u16, // launch 2000 (20%)

    // Optional overrides (else defaults)
    pub admin_timelock_seconds: u32, // default 86400, bounds [3600, 30d]
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

    // Treasury USDC ATA: created here, owned by treasury_pda.
    #[account(
        init,
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
    // Validate args.
    require!(args.pyth_feed_id != [0u8; 32], DominionError::InvalidFeedId);
    require!(args.admin != Pubkey::default(), DominionError::Unauthorized);
    require!(
        args.permanent_delegate_expected != Pubkey::default(),
        DominionError::PermanentDelegateMismatch
    );
    require!(
        args.pyth_receiver_program != Pubkey::default(),
        DominionError::WrongOracleOwner
    );
    require!(
        args.premium_bps_mint <= PREMIUM_BPS_HARD_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        args.premium_bps_redeem <= PREMIUM_BPS_HARD_CEILING,
        DominionError::PremiumTooHigh
    );
    require!(
        (args.premium_bps_mint as u32) + (args.premium_bps_redeem as u32)
            >= PREMIUM_BPS_COMBINED_FLOOR as u32,
        DominionError::PremiumSpreadTooLow
    );

    // Sanity: min <= max for both per-tx caps.
    require!(
        args.max_mint_amount_per_tx_usdc >= args.min_mint_amount_usdc,
        DominionError::AboveMaximum
    );
    require!(
        args.max_redeem_amount_per_tx_usdc >= args.min_redeem_amount_usdc,
        DominionError::AboveMaximum
    );
    require!(
        args.daily_mint_cap_usdc >= args.max_mint_amount_per_tx_usdc,
        DominionError::AboveMaximum
    );
    require!(
        args.daily_redeem_cap_usdc >= args.max_redeem_amount_per_tx_usdc,
        DominionError::AboveMaximum
    );
    require!(
        args.treasury_min_reserve_bps <= 10_000,
        DominionError::AboveMaximum
    );
    require!(
        args.hourly_redeem_cap_bps_of_snapshot <= 10_000,
        DominionError::AboveMaximum
    );

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
    const USDC_MAINNET: Pubkey = anchor_lang::solana_program::pubkey!(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    const USDC_DEVNET: Pubkey = anchor_lang::solana_program::pubkey!(
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
    );
    const USDC_TESTNET: Pubkey = anchor_lang::solana_program::pubkey!(
        "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
    );
    let usdc_key = ctx.accounts.usdc_mint.key();
    require!(
        usdc_key == USDC_MAINNET || usdc_key == USDC_DEVNET || usdc_key == USDC_TESTNET,
        DominionError::UsdcMintNotAllowed
    );

    // CODEX M-02: hard-pin Pyth receiver program to the official deployment.
    // Was loose (accepted anything != default()).
    const PYTH_RECEIVER_OFFICIAL: Pubkey = anchor_lang::solana_program::pubkey!(
        "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
    );
    require!(
        args.pyth_receiver_program == PYTH_RECEIVER_OFFICIAL,
        DominionError::WrongPythReceiver
    );

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
    // keep a freeze_authority (centralized seize/freeze hors-governance).
    //
    // The mint_authority must be the silv_mint_authority PDA (owned by this
    // program), so only mint_silv via this contract can produce SILV.
    // The freeze_authority must be None: PermanentDelegate is the only
    // optional admin-side capability (see CODEX H-01 for honest docs on
    // its semantics).
    let (silv_mint_auth_pda, _) = Pubkey::find_program_address(
        &[SILV_MINT_AUTHORITY_SEED],
        ctx.program_id,
    );
    let mint_authority_opt: Option<Pubkey> = ctx.accounts.silv_mint.mint_authority.into();
    require!(
        mint_authority_opt == Some(silv_mint_auth_pda),
        DominionError::SilvMintAuthorityMismatch
    );
    let freeze_authority_opt: Option<Pubkey> =
        ctx.accounts.silv_mint.freeze_authority.into();
    require!(
        freeze_authority_opt.is_none(),
        DominionError::SilvFreezeAuthorityMustBeNone
    );

    // CODEX 2nd-pass M-01: pin the Token-2022 metadata extension's update
    // authority at init. The execute_update_metadata path assumes the update
    // authority is the silv_metadata_authority PDA; without on-chain
    // verification, the deployer could keep the metadata update authority
    // off-chain and change name/symbol/uri without going through governance.
    {
        use spl_token_2022::extension::{
            metadata_pointer::MetadataPointer,
            BaseStateWithExtensions, StateWithExtensions,
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
        let (silv_metadata_auth_pda, _) = Pubkey::find_program_address(
            &[SILV_METADATA_AUTHORITY_SEED],
            ctx.program_id,
        );
        let mp_authority_opt: Option<Pubkey> = Option::<Pubkey>::from(mp.authority);
        require!(
            mp_authority_opt == Some(silv_metadata_auth_pda),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );
        let mp_metadata_address_opt: Option<Pubkey> =
            Option::<Pubkey>::from(mp.metadata_address);
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
        let md_update_auth_opt: Option<Pubkey> =
            Option::<Pubkey>::from(metadata.update_authority);
        require!(
            md_update_auth_opt == Some(silv_metadata_auth_pda),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );
        require!(
            metadata.mint == ctx.accounts.silv_mint.key(),
            DominionError::SilvMetadataUpdateAuthorityMismatch
        );
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
    config.compliance_mode = args.compliance_mode;

    config.premium_bps_mint = args.premium_bps_mint;
    config.premium_bps_redeem = args.premium_bps_redeem;

    config.pyth_feed_id = args.pyth_feed_id;
    config.pyth_receiver_program = args.pyth_receiver_program;

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

    config.reserve_check_price_scaled = 0;
    config.reserve_check_price_max_increase_per_hour_bps = DEFAULT_RESERVE_PRICE_RAMP_BPS;
    config.reserve_check_price_last_update_at = 0;

    config.min_mint_amount_usdc = args.min_mint_amount_usdc;
    config.max_mint_amount_per_tx_usdc = args.max_mint_amount_per_tx_usdc;
    config.min_redeem_amount_usdc = args.min_redeem_amount_usdc;
    config.max_redeem_amount_per_tx_usdc = args.max_redeem_amount_per_tx_usdc;
    config.daily_mint_cap_usdc = args.daily_mint_cap_usdc;
    config.daily_redeem_cap_usdc = args.daily_redeem_cap_usdc;

    config.hourly_redeem_cap_bps_of_snapshot = if args.hourly_redeem_cap_bps_of_snapshot == 0 {
        DEFAULT_HOURLY_REDEEM_CAP_BPS
    } else {
        args.hourly_redeem_cap_bps_of_snapshot
    };

    config.treasury_min_reserve_bps = if args.treasury_min_reserve_bps == 0 {
        DEFAULT_TREASURY_MIN_RESERVE_BPS
    } else {
        args.treasury_min_reserve_bps
    };

    config.admin_timelock_seconds = admin_timelock;
    config.max_guardian_count = max_guardians;
    config.guardian_count = 0;

    config.mint_paused_until = 0;
    config.paused = false;

    config.next_timelock_nonce = 0;
    config.active_proposal_count = 0;

    config.pending_premium_mint_nonce = None;
    config.pending_premium_redeem_nonce = None;
    config.pending_withdraw_nonce = None;
    config.pending_min_reserve_nonce = None;
    config.pending_oracle_guards_nonce = None;
    config.pending_metadata_nonce = None;
    config.pending_compliance_nonce = None;
    config.pending_pyth_feed_nonce = None;
    config.pending_admin_timelock_nonce = None;

    config.version = 1;
    config.reserved = [0u8; 64];

    msg!("dominion_silver_mint initialized");
    Ok(())
}
