// Shared litesvm fixture for the on-chain state tests. Everything here exists to make ONE thing
// possible: read a real account back out of the VM after a real transaction, and assert its FIELD
// VALUES. A unit test on a pure function can never observe a write that Anchor discarded.

#![allow(dead_code)]

use borsh::{BorshDeserialize, BorshSerialize};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::account::Account;
#[allow(deprecated)]
use solana_sdk::bpf_loader_upgradeable;
use solana_sdk::instruction::{AccountMeta, Instruction, InstructionError};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::{Transaction, TransactionError};
use std::str::FromStr;

// ---------------------------------------------------------------- program id

// The program id is parsed out of the source that produced the .so we load, never hardcoded: a
// hardcoded id in tools/lazer-harness drifted four times and turned every test into
// DeclaredProgramIdMismatch, which reads as "the program is broken" rather than "the harness is stale".
const DOMINION_SRC: &str = include_str!("../../../../programs/dominion_silver_mint_v2/src/lib.rs");

pub fn program_id() -> Pubkey {
    const NEEDLE: &str = "declare_id!(\"";
    let start = DOMINION_SRC
        .find(NEEDLE)
        .expect("declare_id! not found in the program source")
        + NEEDLE.len();
    let end = start
        + DOMINION_SRC[start..]
            .find('"')
            .expect("unterminated declare_id! literal");
    Pubkey::from_str(&DOMINION_SRC[start..end]).expect("declare_id! is not a valid pubkey")
}

fn deploy_artifact_path() -> String {
    format!(
        "{}/../../target/deploy/dominion_silver_mint.so",
        env!("CARGO_MANIFEST_DIR")
    )
}

// ---------------------------------------------------------------- seeds, ids

pub const CONFIG_SEED: &[u8] = b"config";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const TIMELOCK_SEED: &[u8] = b"timelock";
pub const GUARDIAN_SEED: &[u8] = b"guardian";
pub const KYC_SEED: &[u8] = b"kyc";
pub const FEE_EXEMPT_SEED: &[u8] = b"fee_exempt";
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const SILV_MINT_AUTHORITY_SEED: &[u8] = b"silv_mint_authority";
pub const SILV_METADATA_AUTHORITY_SEED: &[u8] = b"silv_metadata_authority";
pub const LAZER_FEE_PAYER_SEED: &[u8] = b"lazer_fee_payer";

pub const CLASSIC_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const USDC_DEVNET: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
pub const LAZER_PROGRAM_ID: &str = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
pub const LAZER_STORAGE: &str = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";

// Anchor framework codes worth naming, because a test that accepts any error passes for the wrong
// reason: 2003 is a failed `constraint`, 2006 a seeds mismatch, 3012 an uninitialized account.
pub const E_CONSTRAINT_HAS_ONE: u32 = 2001;
pub const E_CONSTRAINT_RAW: u32 = 2003;
pub const E_CONSTRAINT_SEEDS: u32 = 2006;
pub const E_ACCOUNT_NOT_INITIALIZED: u32 = 3012;

// DominionError codes (12000 + variant index), cross-checked against target/idl.
pub const E_PAUSED: u32 = 12000;
pub const E_UNAUTHORIZED: u32 = 12013;
pub const E_LAZER_PROGRAM_NOT_EXECUTABLE: u32 = 12072;
pub const E_PUBLIC_MINT_DISABLED: u32 = 12085;
pub const E_KYC_REQUIRED: u32 = 12104;
pub const E_KYC_ATTESTOR_NOT_SET: u32 = 12105;
pub const E_KYC_SCOPE_INVALID: u32 = 12106;
pub const E_ATTESTATION_WALLET_MISMATCH: u32 = 12109;
pub const E_KYC_NO_ATTESTATIONS_YET: u32 = 12112;
pub const E_KYC_OPERATOR_REQUIRED_WHILE_ARMED: u32 = 12113;
pub const E_KYC_LAST_ATTESTATION_WHILE_ARMED: u32 = 12114;
pub const E_KYC_SUBJECT_INVALID: u32 = 12115;
pub const E_KYC_REVOKE_WOULD_DISARM: u32 = 12116;
pub const E_KYC_OPERATOR_MAY_NOT_BE_ADMIN: u32 = 12117;

pub const SIDE_MINT_BIT: u8 = 1;
pub const SIDE_REDEEM_BIT: u8 = 2;
pub const SIDE_ALL_BITS: u8 = 3;

pub const NOW_SECS: i64 = 1_700_000_000;
pub const ADMIN_TIMELOCK_SECONDS: u32 = 86_400;
pub const KYC_ACCOUNT_SIZE: usize = 145;
pub const CONFIG_ACCOUNT_SIZE: usize = 800;

pub fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

// ---------------------------------------------------------------- encoding

pub fn anchor_disc(preimage: &str) -> [u8; 8] {
    let mut h = Sha256::new();
    h.update(preimage.as_bytes());
    h.finalize()[..8].try_into().unwrap()
}

/// Anchor instruction data: sha256("global:<snake_case_name>")[..8] then borsh(args) in order.
pub fn ix_data(name: &str, args: &[u8]) -> Vec<u8> {
    let mut d = anchor_disc(&format!("global:{name}")).to_vec();
    d.extend_from_slice(args);
    d
}

// ---------------------------------------------------------------- PDAs

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &program_id()).0
}

pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn treasury_pda() -> Pubkey {
    pda(&[TREASURY_SEED])
}
pub fn fee_vault_pda() -> Pubkey {
    pda(&[FEE_VAULT_SEED])
}
pub fn silv_mint_authority_pda() -> Pubkey {
    pda(&[SILV_MINT_AUTHORITY_SEED])
}
pub fn silv_metadata_authority_pda() -> Pubkey {
    pda(&[SILV_METADATA_AUTHORITY_SEED])
}
pub fn lazer_fee_payer_pda() -> Pubkey {
    pda(&[LAZER_FEE_PAYER_SEED])
}
pub fn kyc_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[KYC_SEED, wallet.as_ref()])
}
pub fn fee_exempt_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[FEE_EXEMPT_SEED, wallet.as_ref()])
}
pub fn guardian_pda(key: &Pubkey) -> Pubkey {
    pda(&[GUARDIAN_SEED, key.as_ref()])
}
pub fn timelock_pda(nonce: u64) -> Pubkey {
    pda(&[TIMELOCK_SEED, &nonce.to_le_bytes()])
}

/// The classic/2022 associated token account address.
pub fn ata(mint: &Pubkey, owner: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &pk(ASSOCIATED_TOKEN_PROGRAM),
    )
    .0
}

// ---------------------------------------------------------------- account mirrors

/// Field-for-field mirror of `state::config::ConfigAccount`, in declaration order. `Pubkey` is
/// mirrored as `[u8; 32]` so this file needs no borsh impl from solana-sdk. `read_config` asserts a
/// byte-exact re-serialization, so a layout drift fails loudly instead of mis-decoding silently
/// (the lazer harness shipped a missing field that shifted every later value by 32 bytes).
#[derive(BorshDeserialize, BorshSerialize, Debug, Clone)]
pub struct Config {
    pub admin: [u8; 32],
    pub pending_admin: Option<[u8; 32]>,
    pub pending_admin_expires_at: i64,
    pub upgrade_authority_info: [u8; 32],
    pub permanent_delegate_expected: [u8; 32],
    pub freeze_authority_expected: [u8; 32],
    pub compliance_mode: bool,
    pub premium_bps_mint: u16,
    pub premium_bps_redeem: u16,
    pub pyth_lazer_feed_id: u32,
    pub min_publishers: u16,
    pub last_used_feed_update_timestamp_us: u64,
    pub usdc_mint: [u8; 32],
    pub silv_mint: [u8; 32],
    pub usdc_treasury: [u8; 32],
    pub classic_token_program: [u8; 32],
    pub token_2022_program: [u8; 32],
    pub max_staleness_seconds: u32,
    pub max_confidence_bps: u16,
    pub min_price_usd_scaled: u64,
    pub max_price_usd_scaled: u64,
    pub last_recorded_price_scaled: u128,
    pub last_price_update_at: i64,
    pub max_price_delta_bps: u16,
    pub price_delta_decay_seconds: u32,
    pub price_update_min_amount_usdc: u64,
    pub max_silv_supply: u64,
    pub treasury_min_float_usdc: u64,
    pub redemptions_enabled: bool,
    pub large_redeem_threshold_usdc: u64,
    pub instant_redeem_budget_usdc: u64,
    pub instant_redeem_window_seconds: u32,
    pub redeem_queue_delay_seconds: u32,
    pub instant_window_start: i64,
    pub instant_used_usdc: u64,
    pub next_redeem_request_nonce: u64,
    pub admin_timelock_seconds: u32,
    pub max_guardian_count: u8,
    pub guardian_count: u8,
    pub mint_paused_until: i64,
    pub paused: bool,
    pub next_timelock_nonce: u64,
    pub active_proposal_count: u8,
    pub pending_premium_mint_nonce: Option<u64>,
    pub pending_premium_redeem_nonce: Option<u64>,
    pub pending_withdraw_nonce: Option<u64>,
    pub pending_treasury_float_nonce: Option<u64>,
    pub pending_oracle_guards_nonce: Option<u64>,
    pub pending_metadata_nonce: Option<u64>,
    pub pending_compliance_nonce: Option<u64>,
    pub pending_pyth_feed_nonce: Option<u64>,
    pub pending_admin_timelock_nonce: Option<u64>,
    pub pending_admin_eta: i64,
    pub pending_max_supply_nonce: Option<u64>,
    pub pending_redeem_limits_nonce: Option<u64>,
    pub inventory_wallet: [u8; 32],
    pub public_mint_enabled: bool,
    pub kyc_operator: [u8; 32],
    pub kyc_enforced: bool,
    pub pending_kyc_operator_nonce: Option<u64>,
    pub por_feed: [u8; 32],
    pub por_max_staleness_seconds: u32,
    pub por_enforced: bool,
    pub pending_por_feed_nonce: Option<u64>,
    pub mint_paused: bool,
    pub redeem_paused: bool,
    pub pending_removal_count: u8,
    pub version: u8,
    pub pending_public_mint_nonce: Option<u64>,
    pub kyc_scope_flags: u8,
    pub instant_used_prev_usdc: u64,
    pub fee_routing_disabled: bool,
    pub kyc_attestation_count: u32,
    pub reserved: [u8; 40],
}

impl Config {
    pub fn admin_key(&self) -> Pubkey {
        Pubkey::new_from_array(self.admin)
    }
    pub fn kyc_operator_key(&self) -> Pubkey {
        Pubkey::new_from_array(self.kyc_operator)
    }
}

/// Mirror of `state::kyc::KycAccount`. The account EXISTING is the approval, so tests assert both
/// its presence and its `wallet`: a row whose wallet is zero admits nobody yet inflates the roster.
#[derive(BorshDeserialize, BorshSerialize, Debug, Clone)]
pub struct Kyc {
    pub wallet: [u8; 32],
    pub approved_at: i64,
    pub attestor: [u8; 32],
    pub reference: [u8; 32],
    pub version: u8,
    pub reserved: [u8; 32],
}

impl Kyc {
    pub fn wallet_key(&self) -> Pubkey {
        Pubkey::new_from_array(self.wallet)
    }
    pub fn attestor_key(&self) -> Pubkey {
        Pubkey::new_from_array(self.attestor)
    }
}

fn decode_account<T: BorshDeserialize + BorshSerialize>(
    data: &[u8],
    disc_preimage: &str,
    what: &str,
) -> T {
    assert!(
        data.len() >= 8,
        "{what}: account is too short to hold a discriminator"
    );
    assert_eq!(
        &data[..8],
        &anchor_disc(disc_preimage),
        "{what}: wrong account discriminator (is this the account you think it is?)"
    );
    let mut slice: &[u8] = &data[8..];
    let before = slice.len();
    let decoded = T::deserialize(&mut slice)
        .unwrap_or_else(|e| panic!("{what}: borsh decode failed ({e}); the on-chain layout drifted from the mirror struct in tests/common/mod.rs"));
    let consumed = before - slice.len();
    let re = borsh::to_vec(&decoded).unwrap();
    assert_eq!(
        re.as_slice(),
        &data[8..8 + consumed],
        "{what}: re-serializing the decoded value did not reproduce the on-chain bytes, so the \
         mirror struct is out of sync with the program"
    );
    decoded
}

// ---------------------------------------------------------------- token accounts

/// A classic 82-byte SPL mint body. COption is a 4-byte LE tag then 32 bytes.
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

/// The SILV mint exactly as `initialize` demands it: 6 decimals, supply 0, mint authority the
/// program's PDA, and EXACTLY the three allowed Token-2022 extensions.
fn silv_mint_data(mint: &Pubkey, freeze_authority: &Pubkey, permanent_delegate: &Pubkey) -> Vec<u8> {
    let md_auth = silv_metadata_authority_pda();
    let mut d = mint_body(
        Some(silv_mint_authority_pda()),
        0,
        6,
        Some(*freeze_authority),
    );
    d.resize(165, 0); // BASE_ACCOUNT_LENGTH: the Mint/Account disambiguation region
    d.push(1); // AccountType::Mint

    let mut mp = md_auth.as_ref().to_vec();
    mp.extend_from_slice(mint.as_ref());
    d.extend_from_slice(&tlv(18, &mp)); // MetadataPointer

    d.extend_from_slice(&tlv(12, permanent_delegate.as_ref())); // PermanentDelegate

    let mut md = md_auth.as_ref().to_vec();
    md.extend_from_slice(mint.as_ref());
    md.extend_from_slice(&borsh_string("Dominion Silver"));
    md.extend_from_slice(&borsh_string("SILV"));
    md.extend_from_slice(&borsh_string("https://example.invalid/silv.json"));
    md.extend_from_slice(&0u32.to_le_bytes()); // additional_metadata: empty
    d.extend_from_slice(&tlv(19, &md)); // TokenMetadata
    d
}

/// A `create_idempotent` instruction for the real Associated Token program, which LiteSVM loads.
pub fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    Instruction {
        program_id: pk(ASSOCIATED_TOKEN_PROGRAM),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(mint, owner, token_program), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1], // CreateIdempotent
    }
}

// ---------------------------------------------------------------- assertions

pub type TxOutcome = Result<TransactionMetadata, FailedTransactionMetadata>;

fn custom_code(err: &TransactionError) -> Option<u32> {
    match err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

/// Assert the transaction failed with a SPECIFIC error code. A test that accepts any error is a
/// test that passes for the wrong reason: Anchor deserializes every account before evaluating any
/// constraint, so a malformed LATER account masks the EARLIER failure the test means to observe.
pub fn expect_error(outcome: TxOutcome, expected: u32, context: &str) {
    match outcome {
        Ok(_) => panic!("{context}: expected error {expected}, but the transaction SUCCEEDED"),
        Err(f) => {
            let got = custom_code(&f.err);
            assert_eq!(
                got,
                Some(expected),
                "{context}: expected custom error {expected}, got {:?}\nlogs:\n{}",
                f.err,
                f.meta.logs.join("\n")
            );
        }
    }
}

pub fn expect_ok(outcome: TxOutcome, context: &str) -> TransactionMetadata {
    match outcome {
        Ok(m) => m,
        Err(f) => panic!(
            "{context}: expected success, got {:?}\nlogs:\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

// ---------------------------------------------------------------- fixture

pub struct Fixture {
    pub svm: LiteSVM,
    pub deployer: Keypair,
    pub admin: Keypair,
    pub attestor: Keypair,
    pub holder: Keypair,
    pub holder2: Keypair,
    pub stranger: Keypair,
    pub freeze_authority: Pubkey,
    pub permanent_delegate: Pubkey,
    pub usdc_mint: Pubkey,
    pub silv_mint: Pubkey,
}

impl Fixture {
    /// An initialized program with NO KYC attestor configured (the launch state).
    pub fn new_bare() -> Self {
        let pid = program_id();
        let mut svm = LiteSVM::new();
        let mut clock: solana_sdk::clock::Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW_SECS;
        svm.set_sysvar(&clock);

        let path = deploy_artifact_path();
        let elf = std::fs::read(&path).unwrap_or_else(|e| {
            panic!("read {path}: {e}\nBuild it: cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked")
        });
        svm.add_program(pid, &elf).unwrap();

        let deployer = Keypair::new();
        let admin = Keypair::new();
        let attestor = Keypair::new();
        let holder = Keypair::new();
        let holder2 = Keypair::new();
        let stranger = Keypair::new();
        for k in [&deployer, &admin, &attestor, &holder, &holder2, &stranger] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }

        // `svm.add_program` installs the program under loader v2, for which `programdata_address()`
        // returns None and the DOM-001 chain in `initialize` can never pass. Rewrite it into the
        // upgradeable shape. Order matters: litesvm re-loads the ELF out of the programdata account
        // (offset 45) for any executable account owned by the upgradeable loader, so programdata
        // must exist first or `set_account` itself returns MissingAccount.
        let (pd, _) = Pubkey::find_program_address(&[pid.as_ref()], &bpf_loader_upgradeable::ID);
        let mut pd_data = vec![3u8, 0, 0, 0]; // UpgradeableLoaderState::ProgramData
        pd_data.extend_from_slice(&0u64.to_le_bytes()); // slot
        pd_data.push(1); // Some(upgrade_authority)
        pd_data.extend_from_slice(deployer.pubkey().as_ref());
        pd_data.extend_from_slice(&elf);
        svm.set_account(
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
        svm.set_account(
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

        let freeze_authority = Pubkey::new_unique();
        let permanent_delegate = Pubkey::new_unique();
        let usdc_mint = pk(USDC_DEVNET);
        let silv_mint = Pubkey::new_unique();
        svm.set_account(
            usdc_mint,
            Account {
                lamports: 1_000_000_000,
                data: mint_body(Some(Pubkey::new_unique()), 0, 6, None),
                owner: pk(CLASSIC_TOKEN_PROGRAM),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        svm.set_account(
            silv_mint,
            Account {
                lamports: 1_000_000_000,
                data: silv_mint_data(&silv_mint, &freeze_authority, &permanent_delegate),
                owner: pk(TOKEN_2022_PROGRAM),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let mut f = Fixture {
            svm,
            deployer,
            admin,
            attestor,
            holder,
            holder2,
            stranger,
            freeze_authority,
            permanent_delegate,
            usdc_mint,
            silv_mint,
        };
        f.initialize();
        f
    }

    /// The usual starting point: initialized, with `kyc_operator` set to the attestor keypair.
    pub fn new() -> Self {
        let mut f = Self::new_bare();
        let attestor = f.attestor.pubkey();
        expect_ok(f.set_kyc_operator(attestor), "fixture: set_kyc_operator");
        f
    }

    fn initialize(&mut self) {
        let pid = program_id();
        let (pd, _) = Pubkey::find_program_address(&[pid.as_ref()], &bpf_loader_upgradeable::ID);
        let mut args = Vec::new();
        args.extend_from_slice(self.admin.pubkey().as_ref());
        args.extend_from_slice(Pubkey::new_unique().as_ref()); // upgrade_authority_info
        args.extend_from_slice(self.permanent_delegate.as_ref());
        args.extend_from_slice(self.freeze_authority.as_ref());
        args.push(0); // compliance_mode
        args.extend_from_slice(&100u16.to_le_bytes()); // premium_bps_mint
        args.extend_from_slice(&150u16.to_le_bytes()); // premium_bps_redeem
        args.extend_from_slice(&3154u32.to_le_bytes()); // pyth_lazer_feed_id
        args.extend_from_slice(&ADMIN_TIMELOCK_SECONDS.to_le_bytes());
        args.push(3); // max_guardian_count

        let usdc_treasury = ata(
            &self.usdc_mint,
            &treasury_pda(),
            &pk(CLASSIC_TOKEN_PROGRAM),
        );
        let ix = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(self.deployer.pubkey(), true),
                AccountMeta::new_readonly(pid, false),
                AccountMeta::new_readonly(pd, false),
                AccountMeta::new_readonly(treasury_pda(), false),
                AccountMeta::new_readonly(self.usdc_mint, false),
                AccountMeta::new_readonly(self.silv_mint, false),
                AccountMeta::new(usdc_treasury, false),
                AccountMeta::new_readonly(pk(CLASSIC_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(pk(TOKEN_2022_PROGRAM), false),
                AccountMeta::new_readonly(pk(ASSOCIATED_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("initialize", &args),
        };
        let deployer = self.deployer.insecure_clone();
        expect_ok(self.send(&[ix], &[&deployer]), "fixture: initialize");

        // Drift guard for the whole suite: if the mirror struct in this file were out of step with
        // ConfigAccount, these values would land on the wrong fields and every later assertion
        // would be meaningless. Checked once here rather than in each test.
        let c = self.config();
        assert_eq!(c.admin_key(), self.admin.pubkey(), "config.admin");
        assert_eq!(c.premium_bps_mint, 100, "config.premium_bps_mint");
        assert_eq!(c.premium_bps_redeem, 150, "config.premium_bps_redeem");
        assert_eq!(c.pyth_lazer_feed_id, 3154, "config.pyth_lazer_feed_id");
        assert_eq!(
            c.admin_timelock_seconds, ADMIN_TIMELOCK_SECONDS,
            "config.admin_timelock_seconds"
        );
        assert_eq!(c.max_guardian_count, 3, "config.max_guardian_count");
        assert!(c.paused, "a fresh deploy must be PAUSED");
        assert!(!c.redemptions_enabled, "redemptions must be CLOSED at launch");
        assert!(!c.public_mint_enabled, "public mint must be CLOSED at launch");
        assert_eq!(c.kyc_scope_flags, 0, "the KYC gate must be DORMANT at launch");
        assert!(!c.kyc_enforced, "kyc_enforced must be false at launch");
        assert_eq!(c.kyc_attestation_count, 0, "the roster must be empty at launch");
        assert_eq!(
            c.kyc_operator_key(),
            Pubkey::default(),
            "no attestor may be configured at launch"
        );
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxOutcome {
        // A fresh blockhash per transaction: two identical instructions (re-attesting the same
        // wallet, say) would otherwise produce the same signature and be rejected as a duplicate.
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&signers[0].pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }

    pub fn warp(&mut self, secs: i64) {
        let mut clock: solana_sdk::clock::Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    /// Read and decode the live ConfigAccount. THE point of this harness: it is what proves a write
    /// actually persisted, which no unit test on a pure function can observe.
    pub fn config(&self) -> Config {
        let acc = self
            .svm
            .get_account(&config_pda())
            .expect("config PDA does not exist");
        assert_eq!(
            acc.data.len(),
            CONFIG_ACCOUNT_SIZE,
            "ConfigAccount::SIZE changed"
        );
        decode_account(&acc.data, "account:ConfigAccount", "ConfigAccount")
    }

    /// `None` when no KycAccount exists for that wallet (revoked, or never attested).
    pub fn kyc(&self, wallet: &Pubkey) -> Option<Kyc> {
        let acc = self.svm.get_account(&kyc_pda(wallet))?;
        if acc.data.is_empty() || acc.lamports == 0 {
            return None;
        }
        assert_eq!(acc.data.len(), KYC_ACCOUNT_SIZE, "KycAccount::SIZE changed");
        Some(decode_account(&acc.data, "account:KycAccount", "KycAccount"))
    }

    // ------------------------------------------------------------ KYC instructions

    pub fn set_kyc_operator(&mut self, operator: Pubkey) -> TxOutcome {
        self.set_kyc_operator_as(&self.admin.insecure_clone(), operator)
    }

    pub fn set_kyc_operator_as(&mut self, signer: &Keypair, operator: Pubkey) -> TxOutcome {
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(signer.pubkey(), true),
            ],
            data: ix_data("set_kyc_operator", operator.as_ref()),
        };
        self.send(&[ix], &[signer])
    }

    pub fn set_kyc_scope(&mut self, flags: u8) -> TxOutcome {
        self.set_kyc_scope_as(&self.admin.insecure_clone(), flags)
    }

    pub fn set_kyc_scope_as(&mut self, signer: &Keypair, flags: u8) -> TxOutcome {
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(signer.pubkey(), true),
            ],
            data: ix_data("set_kyc_scope", &[flags]),
        };
        self.send(&[ix], &[signer])
    }

    pub fn attest(&mut self, wallet: Pubkey) -> TxOutcome {
        self.attest_as(&self.attestor.insecure_clone(), wallet, [0u8; 32])
    }

    pub fn attest_as(&mut self, signer: &Keypair, wallet: Pubkey, reference: [u8; 32]) -> TxOutcome {
        let mut args = wallet.as_ref().to_vec();
        args.extend_from_slice(&reference);
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new(kyc_pda(&wallet), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("attest_kyc", &args),
        };
        self.send(&[ix], &[signer])
    }

    pub fn revoke_as(&mut self, signer: &Keypair, wallet: Pubkey, allow_disarm: bool) -> TxOutcome {
        let mut args = wallet.as_ref().to_vec();
        args.push(allow_disarm as u8);
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new(kyc_pda(&wallet), false),
            ],
            data: ix_data("revoke_kyc", &args),
        };
        self.send(&[ix], &[signer])
    }

    // ------------------------------------------------------------ the mint call site

    /// Unpause and open the public mint through the 24h timelock, which is the ONLY path that can
    /// open it: `set_public_mint_enabled` refuses to enable instantly.
    pub fn open_public_mint(&mut self) {
        let admin = self.admin.insecure_clone();
        let pid = program_id();
        let unpause = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(admin.pubkey(), true),
            ],
            data: ix_data("unpause", &[]),
        };
        expect_ok(self.send(&[unpause], &[&admin]), "open_public_mint: unpause");

        let nonce = self.config().next_timelock_nonce;
        let propose = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(timelock_pda(nonce), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("propose_set_public_mint", &[1]),
        };
        expect_ok(self.send(&[propose], &[&admin]), "open_public_mint: propose");

        self.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
        let execute = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new(timelock_pda(nonce), false),
                AccountMeta::new(admin.pubkey(), false),
            ],
            data: ix_data("execute_set_public_mint", &nonce.to_le_bytes()),
        };
        expect_ok(self.send(&[execute], &[&admin]), "open_public_mint: execute");
        assert!(
            self.config().public_mint_enabled,
            "open_public_mint left the public mint closed"
        );
    }

    /// Create the two token accounts `mint_silv` requires to exist (its own SILV ATA is
    /// `init_if_needed`, so Anchor creates that one).
    pub fn prepare_mint_accounts(&mut self, user: &Keypair) {
        let classic = pk(CLASSIC_TOKEN_PROGRAM);
        let ixs = [
            create_ata_ix(&user.pubkey(), &fee_vault_pda(), &self.usdc_mint, &classic),
            create_ata_ix(&user.pubkey(), &user.pubkey(), &self.usdc_mint, &classic),
        ];
        expect_ok(self.send(&ixs, &[user]), "prepare_mint_accounts");
    }

    /// `mint_silv`, deliberately with a Lazer program account that is not executable: the oracle
    /// read then fails with LazerProgramNotExecutable, which is the marker that the KYC gate at step
    /// 2b LET THE CALL THROUGH. `supply_kyc = false` presents the program id in the optional slot,
    /// Anchor's encoding for None.
    pub fn try_mint(&mut self, user: &Keypair, supply_kyc: bool) -> TxOutcome {
        let pid = program_id();
        let classic = pk(CLASSIC_TOKEN_PROGRAM);
        let t22 = pk(TOKEN_2022_PROGRAM);
        let kyc_slot = if supply_kyc {
            kyc_pda(&user.pubkey())
        } else {
            pid
        };
        let mut args = 1_000_000u64.to_le_bytes().to_vec(); // amount_usdc
        args.extend_from_slice(&0u64.to_le_bytes()); // min_silv_out
        args.extend_from_slice(&0u32.to_le_bytes()); // message_data: empty Vec<u8>
        args.extend_from_slice(&0u16.to_le_bytes()); // ed25519_instruction_index
        args.push(0); // signature_index
        let ix = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(self.usdc_mint, false),
                AccountMeta::new(self.silv_mint, false),
                AccountMeta::new(ata(&self.usdc_mint, &treasury_pda(), &classic), false),
                AccountMeta::new_readonly(fee_vault_pda(), false),
                AccountMeta::new(ata(&self.usdc_mint, &fee_vault_pda(), &classic), false),
                AccountMeta::new(ata(&self.usdc_mint, &user.pubkey(), &classic), false),
                AccountMeta::new(ata(&self.silv_mint, &user.pubkey(), &t22), false),
                AccountMeta::new_readonly(silv_mint_authority_pda(), false),
                AccountMeta::new_readonly(pk(LAZER_PROGRAM_ID), false),
                AccountMeta::new_readonly(pk(LAZER_STORAGE), false),
                AccountMeta::new(Pubkey::new_unique(), false), // lazer treasury
                AccountMeta::new(lazer_fee_payer_pda(), false),
                AccountMeta::new_readonly(solana_sdk::sysvar::instructions::ID, false),
                AccountMeta::new_readonly(pid, false), // fee_exempt: None
                AccountMeta::new_readonly(kyc_slot, false),
                AccountMeta::new_readonly(classic, false),
                AccountMeta::new_readonly(t22, false),
                AccountMeta::new_readonly(pk(ASSOCIATED_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("mint_silv", &args),
        };
        self.send(&[ix], &[user])
    }
}
