// On-chain tests for `initialize`. It is `init` on the single [CONFIG_SEED] PDA, so on a real cluster
// every one of these assertions is testable exactly once per program id and never again. The 158 unit
// tests call pure functions only: none of them can see which key landed in config.admin, whether the
// DOM-001 upgrade-authority chain still binds, or that a carved field was actually written.
//
// This file boots its own LiteSVM rather than using `Fixture`, because it must reach the state BEFORE
// initialize and vary the args, the ProgramData authority and the two mints.

mod common;

use borsh::BorshDeserialize;
use common::*;
use litesvm::LiteSVM;
use solana_sdk::account::Account;
#[allow(deprecated)]
use solana_sdk::bpf_loader_upgradeable;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- expected on-chain constants

const E_PREMIUM_TOO_HIGH: u32 = 12022;
const E_WRONG_MINT: u32 = 12026;
const E_PERMANENT_DELEGATE_MISMATCH: u32 = 12031;
const E_TIMELOCK_TOO_SHORT: u32 = 12037;
const E_TIMELOCK_TOO_LONG: u32 = 12038;
const E_INVALID_FEED_ID: u32 = 12047;
const E_SILV_MINT_HAS_PREEXISTING_SUPPLY: u32 = 12052;
const E_SILV_MINT_AUTHORITY_MISMATCH: u32 = 12053;
const E_USDC_MINT_NOT_ALLOWED: u32 = 12055;
const E_SILV_METADATA_UPDATE_AUTHORITY_MISMATCH: u32 = 12058;
const E_DISALLOWED_MINT_EXTENSION: u32 = 12066;
const E_SILV_FREEZE_AUTHORITY_MISMATCH: u32 = 12089;
const E_DEPLOYER_NOT_UPGRADE_AUTHORITY: u32 = 12092;
const E_PROGRAM_NOT_UPGRADEABLE: u32 = 12093;
const E_SYSTEM_ACCOUNT_ALREADY_IN_USE: u32 = 0;

const PREMIUM_BPS_MINT_CEILING: u16 = 500;
const PREMIUM_BPS_REDEEM_CEILING: u16 = 500;
const ADMIN_TIMELOCK_MIN_SECONDS: u32 = 86_400;
const ADMIN_TIMELOCK_MAX_SECONDS: u32 = 604_800;
const DEFAULT_MIN_PUBLISHERS: u16 = 2;
const DEFAULT_MAX_STALENESS_SECONDS: u32 = 15;
const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 100;
const DEFAULT_MIN_PRICE_USD_SCALED: u64 = 5_000_000_000;
const DEFAULT_MAX_PRICE_USD_SCALED: u64 = 200_000_000_000;
const DEFAULT_MAX_PRICE_DELTA_BPS: u16 = 500;
const DEFAULT_PRICE_DELTA_DECAY_SECONDS: u32 = 3_600;
const DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC: u64 = 1_000_000_000;
const DEFAULT_MAX_SILV_SUPPLY: u64 = 150_000_000_000;
const DEFAULT_TREASURY_MIN_FLOAT_USDC: u64 = 0;
const DEFAULT_LARGE_REDEEM_THRESHOLD_USDC: u64 = 5_000_000_000;
const DEFAULT_INSTANT_REDEEM_BUDGET_USDC: u64 = 20_000_000_000;
const DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS: u32 = 86_400;
const DEFAULT_REDEEM_QUEUE_DELAY_SECONDS: u32 = 259_200;
const CONFIG_SCHEMA_VERSION: u8 = 2;

const EXT_MINT_CLOSE_AUTHORITY: u16 = 3;
const EXT_PERMANENT_DELEGATE: u16 = 12;
const EXT_METADATA_POINTER: u16 = 18;
const EXT_TOKEN_METADATA: u16 = 19;

// ---------------------------------------------------------------- mint construction

fn mint_body(
    mint_authority: Option<Pubkey>,
    supply: u64,
    decimals: u8,
    freeze_authority: Option<Pubkey>,
) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    if let Some(a) = mint_authority {
        d[0..4].copy_from_slice(&1u32.to_le_bytes());
        d[4..36].copy_from_slice(a.as_ref());
    }
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1; // is_initialized
    if let Some(f) = freeze_authority {
        d[46..50].copy_from_slice(&1u32.to_le_bytes());
        d[50..82].copy_from_slice(f.as_ref());
    }
    d
}

fn borsh_string(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

fn tlv(ext_type: u16, value: &[u8]) -> Vec<u8> {
    let mut v = ext_type.to_le_bytes().to_vec();
    v.extend_from_slice(&(value.len() as u16).to_le_bytes());
    v.extend_from_slice(value);
    v
}

/// Every field of the SILV mint that `initialize` inspects, so each pin can be broken one at a time.
#[derive(Clone)]
struct SilvSpec {
    decimals: u8,
    supply: u64,
    mint_authority: Option<Pubkey>,
    freeze_authority: Option<Pubkey>,
    mp_authority: Option<Pubkey>,
    mp_metadata_address: Option<Pubkey>,
    md_update_authority: Option<Pubkey>,
    md_mint: Pubkey,
    permanent_delegate: Pubkey,
    extra_extension: bool,
}

impl SilvSpec {
    fn good(mint: Pubkey, freeze_authority: Pubkey, permanent_delegate: Pubkey) -> Self {
        let md_auth = silv_metadata_authority_pda();
        SilvSpec {
            decimals: 6,
            supply: 0,
            mint_authority: Some(silv_mint_authority_pda()),
            freeze_authority: Some(freeze_authority),
            mp_authority: Some(md_auth),
            mp_metadata_address: Some(mint),
            md_update_authority: Some(md_auth),
            md_mint: mint,
            permanent_delegate,
            extra_extension: false,
        }
    }

    fn encode(&self) -> Vec<u8> {
        let mut d = mint_body(
            self.mint_authority,
            self.supply,
            self.decimals,
            self.freeze_authority,
        );
        d.resize(165, 0); // BASE_ACCOUNT_LENGTH: the Mint/Account disambiguation region
        d.push(1); // AccountType::Mint

        let mut mp = self.mp_authority.unwrap_or_default().as_ref().to_vec();
        mp.extend_from_slice(self.mp_metadata_address.unwrap_or_default().as_ref());
        d.extend_from_slice(&tlv(EXT_METADATA_POINTER, &mp));

        d.extend_from_slice(&tlv(EXT_PERMANENT_DELEGATE, self.permanent_delegate.as_ref()));

        if self.extra_extension {
            d.extend_from_slice(&tlv(
                EXT_MINT_CLOSE_AUTHORITY,
                Pubkey::new_unique().as_ref(),
            ));
        }

        let mut md = self.md_update_authority.unwrap_or_default().as_ref().to_vec();
        md.extend_from_slice(self.md_mint.as_ref());
        md.extend_from_slice(&borsh_string("Dominion Silver"));
        md.extend_from_slice(&borsh_string("SILV"));
        md.extend_from_slice(&borsh_string("https://example.invalid/silv.json"));
        md.extend_from_slice(&0u32.to_le_bytes()); // additional_metadata: empty
        d.extend_from_slice(&tlv(EXT_TOKEN_METADATA, &md));
        d
    }
}

// ---------------------------------------------------------------- args

#[derive(Clone)]
struct Args {
    admin: Pubkey,
    upgrade_authority_info: Pubkey,
    permanent_delegate_expected: Pubkey,
    freeze_authority_expected: Pubkey,
    compliance_mode: bool,
    premium_bps_mint: u16,
    premium_bps_redeem: u16,
    pyth_lazer_feed_id: u32,
    admin_timelock_seconds: u32,
    max_guardian_count: u8,
}

impl Args {
    /// 142 bytes, the layout verified against a successful on-chain `initialize`.
    fn encode(&self) -> Vec<u8> {
        let mut a = Vec::with_capacity(142);
        a.extend_from_slice(self.admin.as_ref());
        a.extend_from_slice(self.upgrade_authority_info.as_ref());
        a.extend_from_slice(self.permanent_delegate_expected.as_ref());
        a.extend_from_slice(self.freeze_authority_expected.as_ref());
        a.push(self.compliance_mode as u8);
        a.extend_from_slice(&self.premium_bps_mint.to_le_bytes());
        a.extend_from_slice(&self.premium_bps_redeem.to_le_bytes());
        a.extend_from_slice(&self.pyth_lazer_feed_id.to_le_bytes());
        a.extend_from_slice(&self.admin_timelock_seconds.to_le_bytes());
        a.push(self.max_guardian_count);
        assert_eq!(a.len(), 142, "InitializeArgs is 142 bytes");
        a
    }
}

// ---------------------------------------------------------------- boot (pre-initialize)

/// The VM in the state that exists on a real cluster between `solana program deploy` and the one
/// `initialize` transaction. Nothing here calls the program.
struct Boot {
    svm: LiteSVM,
    elf: Vec<u8>,
    deployer: Keypair,
    usdc_mint: Pubkey,
    silv_mint: Pubkey,
    args: Args,
    silv: SilvSpec,
    usdc_decimals: u8,
}

impl Boot {
    fn new() -> Self {
        let pid = program_id();
        let mut svm = LiteSVM::new();
        let mut clock: solana_sdk::clock::Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW_SECS;
        svm.set_sysvar(&clock);

        let path = format!(
            "{}/../../target/deploy/dominion_silver_mint.so",
            env!("CARGO_MANIFEST_DIR")
        );
        let elf = std::fs::read(&path).unwrap_or_else(|e| {
            panic!("read {path}: {e}\nBuild it: cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked")
        });
        svm.add_program(pid, &elf).unwrap();

        let deployer = Keypair::new();
        svm.airdrop(&deployer.pubkey(), 100_000_000_000).unwrap();

        let admin = Pubkey::new_unique();
        let freeze_authority = Pubkey::new_unique();
        let permanent_delegate = Pubkey::new_unique();
        let usdc_mint = pk(USDC_DEVNET);
        let silv_mint = Pubkey::new_unique();

        let args = Args {
            admin,
            upgrade_authority_info: Pubkey::new_unique(),
            permanent_delegate_expected: permanent_delegate,
            freeze_authority_expected: freeze_authority,
            compliance_mode: false,
            premium_bps_mint: 100,
            premium_bps_redeem: 150,
            pyth_lazer_feed_id: 3154,
            admin_timelock_seconds: ADMIN_TIMELOCK_SECONDS,
            max_guardian_count: 3,
        };

        Boot {
            svm,
            elf,
            deployer,
            usdc_mint,
            silv_mint,
            silv: SilvSpec::good(silv_mint, freeze_authority, permanent_delegate),
            args,
            usdc_decimals: 6,
        }
    }

    fn program_data() -> Pubkey {
        Pubkey::find_program_address(&[program_id().as_ref()], &bpf_loader_upgradeable::ID).0
    }

    /// ProgramData bytes: variant tag 3 (u32 LE), slot, Option<Pubkey> authority, then the ELF, which
    /// litesvm re-reads at offset 45 when it installs an upgradeable-loader program account.
    fn program_data_bytes(&self, authority: Option<Pubkey>) -> Vec<u8> {
        let mut d = vec![3u8, 0, 0, 0];
        d.extend_from_slice(&0u64.to_le_bytes());
        match authority {
            Some(a) => {
                d.push(1);
                d.extend_from_slice(a.as_ref());
            }
            None => {
                d.push(0);
                d.extend_from_slice(&[0u8; 32]);
            }
        }
        d.extend_from_slice(&self.elf);
        d
    }

    /// `svm.add_program` installs the program under loader v2, where `programdata_address()` is None
    /// and the DOM-001 chain can never pass, so a negative test would pass for the wrong reason.
    /// Rewrite it into the upgradeable shape; programdata must exist first or `set_account` fails.
    fn install_loader_v3(&mut self, upgrade_authority: Option<Pubkey>) {
        let pid = program_id();
        let pd = Self::program_data();
        let pd_data = self.program_data_bytes(upgrade_authority);
        self.svm
            .set_account(
                pd,
                Account {
                    lamports: 1_000_000_000,
                    data: pd_data,
                    owner: bpf_loader_upgradeable::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let mut p_data = vec![2u8, 0, 0, 0]; // UpgradeableLoaderState::Program
        p_data.extend_from_slice(pd.as_ref());
        self.svm
            .set_account(
                pid,
                Account {
                    lamports: 1_000_000_000,
                    data: p_data,
                    owner: bpf_loader_upgradeable::ID,
                    executable: true,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// A second, unrelated account that also deserializes as ProgramData, with an attacker as the
    /// upgrade authority. This is what the `programdata_address()` constraint exists to reject.
    fn forge_program_data(&mut self, authority: Pubkey) -> Pubkey {
        let forged = Pubkey::new_unique();
        let data = self.program_data_bytes(Some(authority));
        self.svm
            .set_account(
                forged,
                Account {
                    lamports: 1_000_000_000,
                    data,
                    owner: bpf_loader_upgradeable::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        forged
    }

    fn write_mints(&mut self) {
        let usdc = mint_body(Some(Pubkey::new_unique()), 0, self.usdc_decimals, None);
        self.svm
            .set_account(
                self.usdc_mint,
                Account {
                    lamports: 1_000_000_000,
                    data: usdc,
                    owner: pk(CLASSIC_TOKEN_PROGRAM),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let silv = self.silv.encode();
        self.svm
            .set_account(
                self.silv_mint,
                Account {
                    lamports: 1_000_000_000,
                    data: silv,
                    owner: pk(TOKEN_2022_PROGRAM),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    fn initialize_ix(&self, program_data: Pubkey) -> Instruction {
        let pid = program_id();
        let usdc_treasury = ata(&self.usdc_mint, &treasury_pda(), &pk(CLASSIC_TOKEN_PROGRAM));
        Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(self.deployer.pubkey(), true),
                AccountMeta::new_readonly(pid, false),
                AccountMeta::new_readonly(program_data, false),
                AccountMeta::new_readonly(treasury_pda(), false),
                AccountMeta::new_readonly(self.usdc_mint, false),
                AccountMeta::new_readonly(self.silv_mint, false),
                AccountMeta::new(usdc_treasury, false),
                AccountMeta::new_readonly(pk(CLASSIC_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(pk(TOKEN_2022_PROGRAM), false),
                AccountMeta::new_readonly(pk(ASSOCIATED_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("initialize", &self.args.encode()),
        }
    }

    fn send(&mut self, ix: Instruction) -> TxOutcome {
        self.svm.expire_blockhash();
        let signers = [&self.deployer];
        let tx = solana_sdk::transaction::Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.deployer.pubkey()),
            &signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }

    /// Install the upgradeable program with `deployer` as the upgrade authority, write the mints, and
    /// call initialize once.
    fn run(&mut self) -> TxOutcome {
        let auth = Some(self.deployer.pubkey());
        self.run_with_authority(auth)
    }

    fn run_with_authority(&mut self, upgrade_authority: Option<Pubkey>) -> TxOutcome {
        self.install_loader_v3(upgrade_authority);
        self.write_mints();
        let pd = Self::program_data();
        let ix = self.initialize_ix(pd);
        self.send(ix)
    }

    fn config(&self) -> Config {
        let acc = self
            .svm
            .get_account(&config_pda())
            .expect("config PDA does not exist");
        assert_eq!(
            acc.data.len(),
            CONFIG_ACCOUNT_SIZE,
            "ConfigAccount::SIZE changed"
        );
        assert_eq!(
            &acc.data[..8],
            &anchor_disc("account:ConfigAccount"),
            "wrong account discriminator at the config PDA"
        );
        let mut slice: &[u8] = &acc.data[8..];
        Config::deserialize(&mut slice).expect("ConfigAccount borsh decode failed")
    }

    fn config_exists(&self) -> bool {
        match self.svm.get_account(&config_pda()) {
            Some(a) => a.lamports > 0 && !a.data.is_empty(),
            None => false,
        }
    }
}

fn key(raw: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(raw)
}

// ================================================================ happy path

#[test]
fn initialize_writes_every_config_field_and_the_values_read_back_on_chain() {
    let mut b = Boot::new();
    let (admin, uai, pd_expected, fa_expected) = (
        b.args.admin,
        b.args.upgrade_authority_info,
        b.args.permanent_delegate_expected,
        b.args.freeze_authority_expected,
    );
    let (usdc, silv) = (b.usdc_mint, b.silv_mint);
    let treasury_ata = ata(&usdc, &treasury_pda(), &pk(CLASSIC_TOKEN_PROGRAM));
    expect_ok(b.run(), "initialize");

    let c = b.config();

    // Args-derived fields. A handler that dropped any of these assignment lines still returns Ok and
    // still logs success, so only a readback can tell.
    assert_eq!(key(c.admin), admin, "config.admin");
    assert_eq!(key(c.upgrade_authority_info), uai, "upgrade_authority_info");
    assert_eq!(
        key(c.permanent_delegate_expected),
        pd_expected,
        "permanent_delegate_expected"
    );
    assert_eq!(
        key(c.freeze_authority_expected),
        fa_expected,
        "freeze_authority_expected"
    );
    assert!(!c.compliance_mode, "compliance_mode is off at launch");
    assert_eq!(c.premium_bps_mint, 100, "premium_bps_mint");
    assert_eq!(c.premium_bps_redeem, 150, "premium_bps_redeem");
    assert_eq!(c.pyth_lazer_feed_id, 3154, "pyth_lazer_feed_id");
    assert_eq!(
        c.admin_timelock_seconds, ADMIN_TIMELOCK_SECONDS,
        "admin_timelock_seconds"
    );
    assert_eq!(c.max_guardian_count, 3, "max_guardian_count");

    // Account-derived fields.
    assert_eq!(key(c.usdc_mint), usdc, "config.usdc_mint");
    assert_eq!(key(c.silv_mint), silv, "config.silv_mint");
    assert_eq!(key(c.usdc_treasury), treasury_ata, "config.usdc_treasury");
    assert_eq!(
        key(c.classic_token_program),
        pk(CLASSIC_TOKEN_PROGRAM),
        "classic_token_program"
    );
    assert_eq!(
        key(c.token_2022_program),
        pk(TOKEN_2022_PROGRAM),
        "token_2022_program"
    );

    // Oracle guard defaults. min_publishers is the one that matters most: the timelocked setter
    // refuses anything below the hard floor, so a weakened launch value never surfaces later.
    assert_eq!(c.min_publishers, DEFAULT_MIN_PUBLISHERS, "min_publishers");
    assert_eq!(
        c.max_staleness_seconds, DEFAULT_MAX_STALENESS_SECONDS,
        "max_staleness_seconds"
    );
    assert_eq!(
        c.max_confidence_bps, DEFAULT_MAX_CONFIDENCE_BPS,
        "max_confidence_bps"
    );
    assert_eq!(
        c.min_price_usd_scaled, DEFAULT_MIN_PRICE_USD_SCALED,
        "min_price_usd_scaled"
    );
    assert_eq!(
        c.max_price_usd_scaled, DEFAULT_MAX_PRICE_USD_SCALED,
        "max_price_usd_scaled"
    );
    assert_eq!(
        c.max_price_delta_bps, DEFAULT_MAX_PRICE_DELTA_BPS,
        "max_price_delta_bps"
    );
    assert_eq!(
        c.price_delta_decay_seconds, DEFAULT_PRICE_DELTA_DECAY_SECONDS,
        "price_delta_decay_seconds"
    );
    assert_eq!(
        c.price_update_min_amount_usdc, DEFAULT_PRICE_UPDATE_MIN_AMOUNT_USDC,
        "price_update_min_amount_usdc"
    );
    assert_eq!(c.last_recorded_price_scaled, 0, "last_recorded_price_scaled");
    assert_eq!(c.last_price_update_at, 0, "last_price_update_at");
    assert_eq!(
        c.last_used_feed_update_timestamp_us, 0,
        "last_used_feed_update_timestamp_us"
    );

    // Economic defaults. The supply cap is tighten-only, so a launch value above the physical
    // allocation can never be corrected upward and nothing else would ever flag it.
    assert_eq!(c.max_silv_supply, DEFAULT_MAX_SILV_SUPPLY, "max_silv_supply");
    assert_eq!(
        c.treasury_min_float_usdc, DEFAULT_TREASURY_MIN_FLOAT_USDC,
        "treasury_min_float_usdc"
    );
    assert_eq!(
        c.large_redeem_threshold_usdc, DEFAULT_LARGE_REDEEM_THRESHOLD_USDC,
        "large_redeem_threshold_usdc"
    );
    assert_eq!(
        c.instant_redeem_budget_usdc, DEFAULT_INSTANT_REDEEM_BUDGET_USDC,
        "instant_redeem_budget_usdc"
    );
    assert_eq!(
        c.instant_redeem_window_seconds, DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS,
        "instant_redeem_window_seconds"
    );
    assert_eq!(
        c.redeem_queue_delay_seconds, DEFAULT_REDEEM_QUEUE_DELAY_SECONDS,
        "redeem_queue_delay_seconds"
    );
    assert_eq!(c.instant_window_start, 0, "instant_window_start");
    assert_eq!(c.instant_used_usdc, 0, "instant_used_usdc");
    assert_eq!(c.next_redeem_request_nonce, 0, "next_redeem_request_nonce");

    // Governance slots: everything empty, nothing pre-armed.
    assert_eq!(c.guardian_count, 0, "guardian_count");
    assert_eq!(c.pending_removal_count, 0, "pending_removal_count");
    assert_eq!(c.next_timelock_nonce, 0, "next_timelock_nonce");
    assert_eq!(c.active_proposal_count, 0, "active_proposal_count");
    assert_eq!(c.mint_paused_until, 0, "mint_paused_until");
    assert!(c.pending_admin.is_none(), "pending_admin");
    assert_eq!(c.pending_admin_expires_at, 0, "pending_admin_expires_at");
    assert_eq!(c.pending_admin_eta, 0, "pending_admin_eta");
    for (name, slot) in [
        ("premium_mint", c.pending_premium_mint_nonce),
        ("premium_redeem", c.pending_premium_redeem_nonce),
        ("withdraw", c.pending_withdraw_nonce),
        ("treasury_float", c.pending_treasury_float_nonce),
        ("oracle_guards", c.pending_oracle_guards_nonce),
        ("metadata", c.pending_metadata_nonce),
        ("compliance", c.pending_compliance_nonce),
        ("pyth_feed", c.pending_pyth_feed_nonce),
        ("admin_timelock", c.pending_admin_timelock_nonce),
        ("max_supply", c.pending_max_supply_nonce),
        ("redeem_limits", c.pending_redeem_limits_nonce),
        ("kyc_operator", c.pending_kyc_operator_nonce),
        ("por_feed", c.pending_por_feed_nonce),
        ("public_mint", c.pending_public_mint_nonce),
    ] {
        assert!(slot.is_none(), "pending_{name}_nonce must be None at launch");
    }

    // Phase-2 hooks and granular pauses.
    assert_eq!(key(c.inventory_wallet), Pubkey::default(), "inventory_wallet");
    assert_eq!(key(c.por_feed), Pubkey::default(), "por_feed");
    assert_eq!(c.por_max_staleness_seconds, 0, "por_max_staleness_seconds");
    assert!(!c.por_enforced, "por_enforced");
    assert!(!c.mint_paused, "mint_paused");
    assert!(!c.redeem_paused, "redeem_paused");
    assert_eq!(c.version, CONFIG_SCHEMA_VERSION, "config.version");
    assert_eq!(c.reserved, [0u8; 40], "config.reserved");
}

#[test]
fn a_fresh_deploy_is_paused_with_mint_and_redemptions_closed() {
    let mut b = Boot::new();
    expect_ok(b.run(), "initialize");
    let c = b.config();

    // Each of these is a one-line assignment whose inversion is invisible to a unit test and would
    // put the protocol LIVE at block zero against oracle bounds nobody validated.
    assert!(c.paused, "a fresh deploy must be PAUSED");
    assert!(
        !c.redemptions_enabled,
        "public direct redeem must be CLOSED at launch"
    );
    assert!(
        !c.public_mint_enabled,
        "the public mint must be CLOSED at launch"
    );
}

#[test]
fn the_carved_fields_read_as_their_intended_at_zero_values() {
    let mut b = Boot::new();
    expect_ok(b.run(), "initialize");
    let c = b.config();

    // These four are written explicitly BECAUSE zero is their intended meaning, so a reader cannot
    // tell an intended zero from a forgotten write. Only fee_routing_disabled and kyc_scope_flags are
    // observable through behaviour; the other two are only observable here.
    assert!(
        !c.fee_routing_disabled,
        "premium routing must be ON at launch (the field is negated)"
    );
    assert_eq!(c.kyc_scope_flags, 0, "the KYC gate must be DORMANT at launch");
    assert!(!c.kyc_enforced, "kyc_enforced must agree with the flags");
    assert_eq!(
        key(c.kyc_operator),
        Pubkey::default(),
        "no attestor may be configured at launch: an unset operator is what BLOCKS arming"
    );
    assert_eq!(
        c.kyc_attestation_count, 0,
        "the roster must be empty at launch"
    );
    assert_eq!(
        c.instant_used_prev_usdc, 0,
        "no prior redeem bucket exists at genesis"
    );
}

// ================================================================ DOM-001

#[test]
fn dom001_a_signer_who_is_not_the_upgrade_authority_is_refused() {
    let mut b = Boot::new();
    let attacker = Keypair::new();
    b.svm.airdrop(&attacker.pubkey(), 100_000_000_000).unwrap();

    // The upgrade authority is somebody else, so the deployer signing here is a front-runner racing
    // the real deploy for the single [CONFIG_SEED] PDA. Asserting the exact code matters: with the
    // program left in loader-v2 shape this transaction fails anyway, for the wrong reason.
    let auth = Some(attacker.pubkey());
    expect_error(
        b.run_with_authority(auth),
        E_DEPLOYER_NOT_UPGRADE_AUTHORITY,
        "initialize by a non-upgrade-authority signer",
    );
    assert!(
        !b.config_exists(),
        "the config PDA must not exist after a refused initialize"
    );
}

#[test]
fn dom001_an_immutable_program_cannot_be_initialized_by_anyone() {
    let mut b = Boot::new();
    // upgrade_authority_address = None, i.e. the authority was revoked. Refused by choice: a missing
    // authority must never be read as "whoever signed".
    expect_error(
        b.run_with_authority(None),
        E_PROGRAM_NOT_UPGRADEABLE,
        "initialize against an immutable program",
    );
    assert!(!b.config_exists(), "the config PDA must not exist");
}

#[test]
fn dom001_the_positive_case_succeeds_so_the_negatives_mean_something() {
    let mut b = Boot::new();
    let deployer = b.deployer.pubkey();
    expect_ok(b.run_with_authority(Some(deployer)), "initialize");
    assert!(b.config_exists(), "initialize must create the config PDA");
}

#[test]
fn dom001_a_forged_program_data_account_is_rejected() {
    let mut b = Boot::new();
    let attacker = b.deployer.pubkey();
    // A real, loader-owned account that deserializes as ProgramData and names the caller as the
    // upgrade authority. Only the `programdata_address()` binding to the PROGRAM account's own state
    // stops it, and the handler's authority check would otherwise pass.
    let forged = b.forge_program_data(attacker);
    let real_auth = Some(Pubkey::new_unique());
    b.install_loader_v3(real_auth);
    b.write_mints();
    let ix = b.initialize_ix(forged);
    expect_error(
        b.send(ix),
        E_UNAUTHORIZED,
        "initialize with a forged ProgramData",
    );
    assert!(!b.config_exists(), "the config PDA must not exist");
}

// ================================================================ one-shot

#[test]
fn initialize_twice_is_refused() {
    let mut b = Boot::new();
    expect_ok(b.run(), "first initialize");
    let admin_after_first = b.config().admin;

    // `init`, not `init_if_needed`: the second call must not be able to re-seat config.admin.
    let pd = Boot::program_data();
    let mut second = b.args.clone();
    second.admin = Pubkey::new_unique();
    b.args = second;
    let ix = b.initialize_ix(pd);
    // Custom(0) is the system program's AccountAlreadyInUse, raised by the create_account CPI that
    // `init` performs. Pinned rather than "any error": an `init_if_needed` regression would still
    // fail here, but with an Anchor code, and the point is that no second write happens at all.
    expect_error(
        b.send(ix),
        E_SYSTEM_ACCOUNT_ALREADY_IN_USE,
        "a second initialize",
    );
    assert_eq!(
        b.config().admin, admin_after_first,
        "the second initialize changed config.admin"
    );
}

// ================================================================ T1: which key becomes admin

#[test]
fn the_admin_written_to_config_is_the_arg_not_the_signer() {
    let mut b = Boot::new();
    // T1's hostile shape: the deployer is a single hot key that legitimately holds the upgrade
    // authority, while `admin` must be the Ops multisig passed as an argument. If the handler used
    // the signer instead, the deploy script's own admin argument would be silently ignored and one
    // hot key would own the protocol.
    let arg_admin = Pubkey::new_unique();
    b.args.admin = arg_admin;
    let deployer = b.deployer.pubkey();
    assert_ne!(arg_admin, deployer, "the fixture must distinguish the two");

    expect_ok(b.run(), "initialize");
    let c = b.config();
    assert_eq!(key(c.admin), arg_admin, "config.admin must be the ARG");
    assert_ne!(
        key(c.admin),
        deployer,
        "config.admin must NOT be the deployer signer"
    );
}

#[test]
fn a_zero_admin_arg_is_refused() {
    let mut b = Boot::new();
    // No private key exists for the zero pubkey, so this would make every admin-gated instruction
    // permanently unreachable with no admin-transfer path out.
    b.args.admin = Pubkey::default();
    expect_error(b.run(), E_UNAUTHORIZED, "initialize with a zero admin arg");
}

// ================================================================ premium bounds

#[test]
fn a_mint_premium_above_the_ceiling_is_refused() {
    let mut b = Boot::new();
    b.args.premium_bps_mint = PREMIUM_BPS_MINT_CEILING + 1;
    expect_error(b.run(), E_PREMIUM_TOO_HIGH, "premium_bps_mint over ceiling");
}

#[test]
fn a_redeem_premium_above_the_ceiling_is_refused() {
    let mut b = Boot::new();
    b.args.premium_bps_redeem = PREMIUM_BPS_REDEEM_CEILING + 1;
    expect_error(
        b.run(),
        E_PREMIUM_TOO_HIGH,
        "premium_bps_redeem over ceiling",
    );
}

#[test]
fn the_premium_ceilings_bind_exactly_at_the_boundary() {
    let mut b = Boot::new();
    b.args.premium_bps_mint = PREMIUM_BPS_MINT_CEILING;
    b.args.premium_bps_redeem = PREMIUM_BPS_REDEEM_CEILING;
    expect_ok(b.run(), "initialize at the ceilings");
    let c = b.config();
    assert_eq!(c.premium_bps_mint, PREMIUM_BPS_MINT_CEILING);
    assert_eq!(c.premium_bps_redeem, PREMIUM_BPS_REDEEM_CEILING);
}

#[test]
fn the_combined_premium_floor_is_currently_a_no_op() {
    let mut b = Boot::new();
    b.args.premium_bps_mint = 0;
    b.args.premium_bps_redeem = 0;
    // PREMIUM_BPS_COMBINED_FLOOR is 0, so `sum >= FLOOR` cannot reject anything. Recorded as the
    // characterisation it is: this goes red the day the floor is raised without a spec change.
    expect_ok(b.run(), "initialize with a zero spread");
    let c = b.config();
    assert_eq!(c.premium_bps_mint, 0);
    assert_eq!(c.premium_bps_redeem, 0);
}

// ================================================================ timelock bounds

#[test]
fn a_sub_minimum_admin_timelock_is_refused() {
    let mut b = Boot::new();
    b.args.admin_timelock_seconds = ADMIN_TIMELOCK_MIN_SECONDS - 1;
    expect_error(b.run(), E_TIMELOCK_TOO_SHORT, "1s governance timelock");
}

#[test]
fn an_over_maximum_admin_timelock_is_refused() {
    let mut b = Boot::new();
    b.args.admin_timelock_seconds = ADMIN_TIMELOCK_MAX_SECONDS + 1;
    expect_error(b.run(), E_TIMELOCK_TOO_LONG, "over-7d governance timelock");
}

#[test]
fn zero_admin_timelock_and_zero_max_guardians_mean_use_the_defaults() {
    let mut b = Boot::new();
    b.args.admin_timelock_seconds = 0;
    b.args.max_guardian_count = 0;
    expect_ok(b.run(), "initialize with the sentinel zeros");
    let c = b.config();
    assert_eq!(
        c.admin_timelock_seconds, ADMIN_TIMELOCK_MIN_SECONDS,
        "0 must expand to DEFAULT_ADMIN_TIMELOCK_SECONDS, not be stored as 0"
    );
    assert_eq!(c.max_guardian_count, 3, "0 must expand to the default 3");
}

// ================================================================ feed id

#[test]
fn a_zero_pyth_feed_id_is_refused() {
    let mut b = Boot::new();
    // Feed 0 makes every oracle read fail WrongOracleFeed, and the only exit is a 24h proposal.
    b.args.pyth_lazer_feed_id = 0;
    expect_error(b.run(), E_INVALID_FEED_ID, "initialize with feed id 0");
}

// ================================================================ the two mints

#[test]
fn a_usdc_mint_outside_circles_three_is_refused() {
    let mut b = Boot::new();
    // M-02: without the allowlist the deployer passes a fake 6-decimal "USDC" they control and mints
    // SILV against worthless reserves.
    b.usdc_mint = Pubkey::new_unique();
    expect_error(b.run(), E_USDC_MINT_NOT_ALLOWED, "a fake USDC mint");
}

#[test]
fn a_usdc_mint_with_the_wrong_decimals_is_refused() {
    let mut b = Boot::new();
    // SC-H1: the mint/redeem math hard-codes 6 decimals on both sides.
    b.usdc_decimals = 9;
    expect_error(b.run(), E_WRONG_MINT, "a 9-decimal USDC mint");
}

#[test]
fn a_silv_mint_with_the_token2022_default_nine_decimals_is_refused() {
    let mut b = Boot::new();
    b.silv.decimals = 9;
    expect_error(b.run(), E_WRONG_MINT, "a 9-decimal SILV mint");
}

#[test]
fn a_silv_mint_with_preexisting_supply_is_refused() {
    let mut b = Boot::new();
    // C-01: SILV pre-minted between the two off-chain mint-creation phases is indistinguishable from
    // legitimate supply once initialize has accepted it.
    b.silv.supply = 1;
    expect_error(
        b.run(),
        E_SILV_MINT_HAS_PREEXISTING_SUPPLY,
        "a pre-minted SILV mint",
    );
}

#[test]
fn a_silv_mint_authority_outside_the_program_pda_is_refused() {
    let mut b = Boot::new();
    // C-02: an off-chain mint authority lets the deployer mint unbacked SILV outside every cap and
    // pause in this program.
    b.silv.mint_authority = Some(Pubkey::new_unique());
    expect_error(
        b.run(),
        E_SILV_MINT_AUTHORITY_MISMATCH,
        "an off-chain SILV mint authority",
    );
}

#[test]
fn a_silv_freeze_authority_that_disagrees_with_the_arg_is_refused() {
    let mut b = Boot::new();
    // The compliance freeze lever must be pinned at init, or config.freeze_authority_expected
    // describes an authority nobody holds.
    b.silv.freeze_authority = Some(Pubkey::new_unique());
    expect_error(
        b.run(),
        E_SILV_FREEZE_AUTHORITY_MISMATCH,
        "a SILV freeze authority outside the Ops multisig",
    );
}

#[test]
fn a_silv_mint_with_no_freeze_authority_is_refused() {
    let mut b = Boot::new();
    b.silv.freeze_authority = None;
    expect_error(
        b.run(),
        E_SILV_FREEZE_AUTHORITY_MISMATCH,
        "a SILV mint with the freeze authority unset",
    );
}

#[test]
fn a_zero_freeze_authority_arg_is_refused() {
    let mut b = Boot::new();
    b.args.freeze_authority_expected = Pubkey::default();
    expect_error(
        b.run(),
        E_SILV_FREEZE_AUTHORITY_MISMATCH,
        "a zero freeze_authority_expected arg",
    );
}

#[test]
fn a_permanent_delegate_that_disagrees_with_the_arg_is_refused() {
    let mut b = Boot::new();
    // P1-03: the one privileged clawback capability on SILV must not belong to an arbitrary key while
    // config claims the Ops vault holds it.
    b.silv.permanent_delegate = Pubkey::new_unique();
    expect_error(
        b.run(),
        E_PERMANENT_DELEGATE_MISMATCH,
        "a PermanentDelegate outside the Ops vault",
    );
}

#[test]
fn a_zero_permanent_delegate_arg_is_refused() {
    let mut b = Boot::new();
    b.args.permanent_delegate_expected = Pubkey::default();
    b.silv.permanent_delegate = Pubkey::default();
    expect_error(
        b.run(),
        E_PERMANENT_DELEGATE_MISMATCH,
        "a zero permanent_delegate_expected arg",
    );
}

#[test]
fn a_fourth_mint_extension_is_refused() {
    let mut b = Boot::new();
    // P1-03: TransferHook, TransferFee, DefaultAccountState(Frozen) or NonTransferable would alter
    // token behaviour underneath every mint and redeem, so the allowlist is exactly three.
    b.silv.extra_extension = true;
    expect_error(
        b.run(),
        E_DISALLOWED_MINT_EXTENSION,
        "a SILV mint carrying a fourth extension",
    );
}

#[test]
fn a_metadata_pointer_authority_outside_the_program_pda_is_refused() {
    let mut b = Boot::new();
    b.silv.mp_authority = Some(Pubkey::new_unique());
    expect_error(
        b.run(),
        E_SILV_METADATA_UPDATE_AUTHORITY_MISMATCH,
        "an off-chain MetadataPointer authority",
    );
}

#[test]
fn a_metadata_pointer_aimed_at_a_separate_account_is_refused() {
    let mut b = Boot::new();
    // A pointer at a separate metadata account steers wallets at a name/symbol/URI that
    // execute_update_metadata cannot reach.
    b.silv.mp_metadata_address = Some(Pubkey::new_unique());
    expect_error(
        b.run(),
        E_SILV_METADATA_UPDATE_AUTHORITY_MISMATCH,
        "a MetadataPointer aimed off-mint",
    );
}

#[test]
fn a_token_metadata_update_authority_outside_the_program_pda_is_refused() {
    let mut b = Boot::new();
    // M-01: an off-chain update authority lets the deployer rename the token outside the 24h
    // timelocked metadata action.
    b.silv.md_update_authority = Some(Pubkey::new_unique());
    expect_error(
        b.run(),
        E_SILV_METADATA_UPDATE_AUTHORITY_MISMATCH,
        "an off-chain TokenMetadata update authority",
    );
}

#[test]
fn token_metadata_pointing_at_a_different_mint_is_refused() {
    let mut b = Boot::new();
    b.silv.md_mint = Pubkey::new_unique();
    expect_error(
        b.run(),
        E_SILV_METADATA_UPDATE_AUTHORITY_MISMATCH,
        "TokenMetadata naming a different mint",
    );
}
