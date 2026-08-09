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
// ROUND 5 P1-04. Verified against target/idl/dominion_silver_mint.json, not counted by hand.
pub const E_OPERATION_BELOW_MINIMUM: u32 = 12118;
pub const E_MIN_OPERATION_TOO_HIGH: u32 = 12119;
pub const E_MIN_OPERATION_UNCHANGED: u32 = 12120;

pub const SIDE_MINT_BIT: u8 = 1;
pub const SIDE_REDEEM_BIT: u8 = 2;
pub const SIDE_ALL_BITS: u8 = 3;

pub const NOW_SECS: i64 = 1_700_000_000;
pub const ADMIN_TIMELOCK_SECONDS: u32 = 86_400;
/// ROUND 5 P1-04. Mirrors `DEFAULT_MIN_OPERATION_USDC` in state/config.rs; `initialize` writes it,
/// so the fixture and the tests must agree with the program or every mint here reverts.
pub const DEFAULT_MIN_OPERATION_USDC: u64 = 10_000_000; // $10
// MIRROR of state::config::MIN_OPERATION_CEILING_USDC. Nothing enforces that these agree, so the
// test that reads it is the enforcement: it asserts the boundary on both sides, and it went red
// the moment the program's ceiling moved. Keep them in the same commit.
pub const MIN_OPERATION_CEILING_USDC: u64 = 100_000_000; // $100
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
    /// ROUND 5 P1-04, carved out of `reserved` per THE RULE in state/config.rs. This mirror is what
    /// caught the layout change when the field was added: the harness read 10_000_000 LE bleeding
    /// into `reserved` and the initialize test failed rather than silently mis-decoding.
    pub min_operation_usdc: u64,
    /// ROUND 7, carved out of `reserved` per THE RULE. Same story as the field above: if the program
    /// and this mirror disagree, the initialize test fails on a decoded value rather than passing on a
    /// silently mis-parsed one.
    pub pending_inventory_wallet_nonce: Option<u64>,
    pub reserved: [u8; 23],
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
    /// ROUND 8. `unpause` now demands an ACTIVE guardian distinct from the admin, so a running
    /// protocol is no longer one admin signature away. This is the key `ensure_unpause_guardian`
    /// installs on demand, kept OUT of `initialize` on purpose: a fresh deploy must still read
    /// `guardian_count = 0`, and the guardian-budget tests need all three slots free.
    pub guardian: Keypair,
    pub freeze_authority: Pubkey,
    pub permanent_delegate: Pubkey,
    pub usdc_mint: Pubkey,
    pub silv_mint: Pubkey,
    /// ROUND 8 T8-03. Bound at `initialize` and never settable afterwards, so the fixture has to
    /// carry it: tests that assert on the pre-mint destination read this rather than a default.
    pub inventory_wallet: Pubkey,
    /// ROUND 8 L1-02 / the P1 custody finding. The KEY behind `inventory_wallet`, because the
    /// conditional P1 is precisely that its holder can sign `redeem_silv` itself, with no admin
    /// instruction and no timelock. A test that could not sign as this key could not demonstrate it.
    pub inventory: Keypair,
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
        let guardian = Keypair::new();
        let inventory = Keypair::new();
        let inventory_wallet = inventory.pubkey();
        for k in [
            &deployer,
            &admin,
            &attestor,
            &holder,
            &holder2,
            &stranger,
            &guardian,
            &inventory,
        ] {
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
            guardian,
            freeze_authority,
            permanent_delegate,
            usdc_mint,
            silv_mint,
            inventory_wallet,
            inventory,
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
        // ROUND 8 T8-03: the pre-mint destination is now bound ATOMICALLY here. There is no
        // instruction that can set it afterwards, only the 24h-timelocked change.
        args.extend_from_slice(self.inventory_wallet.as_ref());
        // ROUND 8 L1-02: the FIRST guardian, appointed in this same transaction. The fixture
        // therefore starts with guardian_count = 1 and an active brake, which is the state a real
        // deployment is in the instant `initialize` returns.
        args.extend_from_slice(self.guardian.pubkey().as_ref());

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
                AccountMeta::new(guardian_pda(&self.guardian.pubkey()), false),
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
        // ROUND 8, launch posture decided 2026-08-09. Mint and redeem are OPEN in the initial
        // configuration so that no base setting costs a 24h wait during the ceremony. What still
        // guards the launch is the PAUSE: nothing flows until somebody unpauses, and `unpause` now
        // demands an active guardian distinct from the admin. The two flags being open is not the
        // same thing as the protocol being live, and this trio asserts exactly that distinction.
        assert!(c.paused, "a fresh deploy must be PAUSED");
        assert!(
            c.redemptions_enabled,
            "redemptions must be OPEN at initialize (round 8 posture)"
        );
        assert!(
            c.public_mint_enabled,
            "public mint must be OPEN at initialize (round 8 posture)"
        );
        assert_ne!(
            Pubkey::new_from_array(c.inventory_wallet),
            Pubkey::default(),
            "T8-03: initialize must bind the inventory wallet atomically"
        );
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

    // ------------------------------------------------------------ guardian and unpause

    /// `add_guardian`, signed by `signer` in BOTH the admin and the payer slot, AND by the appointee.
    ///
    /// ROUND 8 L1-02: the named key signs its own appointment, so the set cannot grow without the
    /// consent of the key being added. That is why this takes a Keypair and not a Pubkey.
    pub fn add_guardian_as(&mut self, signer: &Keypair, guardian: &Keypair) -> TxOutcome {
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new_readonly(guardian.pubkey(), true),
                AccountMeta::new(guardian_pda(&guardian.pubkey()), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("add_guardian", guardian.pubkey().as_ref()),
        };
        self.send(&[ix], &[signer, guardian])
    }

    pub fn add_guardian(&mut self, guardian: &Keypair) -> TxOutcome {
        let admin = self.admin.insecure_clone();
        self.add_guardian_as(&admin, guardian)
    }

    /// True when a GuardianAccount exists at that PDA. Mirrors the emptiness test `kyc` uses:
    /// litesvm answers a never-created PDA with a zero-lamport, zero-length account rather than None.
    pub fn guardian_registered(&self, guardian: &Pubkey) -> bool {
        self.svm
            .get_account(&guardian_pda(guardian))
            .map(|a| !a.data.is_empty() && a.lamports > 0)
            .unwrap_or(false)
    }

    /// Install `self.guardian` if it is not already registered, and return its key. Idempotent, so a
    /// test may call it directly (to control WHEN the appointment happens, which matters before an
    /// admin transfer) or let `unpause_as` call it.
    ///
    /// `signer` is the CURRENT admin: `add_guardian` is `has_one = admin`, and `self.admin` goes
    /// stale the moment a test moves admin-ship.
    pub fn ensure_unpause_guardian_as(&mut self, signer: &Keypair) -> Pubkey {
        let g = self.guardian.insecure_clone();
        if !self.guardian_registered(&g.pubkey()) {
            expect_ok(
                self.add_guardian_as(signer, &g),
                "ensure_unpause_guardian: add_guardian",
            );
        }
        g.pubkey()
    }

    pub fn ensure_unpause_guardian(&mut self) -> Pubkey {
        let admin = self.admin.insecure_clone();
        self.ensure_unpause_guardian_as(&admin)
    }

    /// `unpause` presenting an EXPLICIT guardian slot. The primitive, because the negative cases are
    /// exactly about which account lands in that slot: a guardian that is the admin, a guardian in
    /// cooldown, another guardian's PDA.
    pub fn unpause_with(&mut self, signer: &Keypair, guardian_slot: Pubkey) -> TxOutcome {
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new_readonly(guardian_slot, false),
            ],
            data: ix_data("unpause", &[]),
        };
        self.send(&[ix], &[signer])
    }

    /// `unpause` signed by `signer`, presenting the fixture's own guardian, installed on demand.
    pub fn unpause_as(&mut self, signer: &Keypair) -> TxOutcome {
        let g = self.ensure_unpause_guardian();
        self.unpause_with(signer, guardian_pda(&g))
    }

    /// `unpause` signed by the admin. The one every fixture helper wants.
    pub fn unpause(&mut self) -> TxOutcome {
        let admin = self.admin.insecure_clone();
        self.unpause_as(&admin)
    }

    // ------------------------------------------------------------ the mint call site

    /// Bring the protocol to the state where a public mint can land. ROUND 8: `initialize` already
    /// leaves `public_mint_enabled = true`, so the only remaining step is the unpause, and the
    /// unpause is now what carries the guardian requirement. The 24h path that OPENS a closed public
    /// mint still exists and is still the only opener; it is exercised in caps.rs, from a state this
    /// helper no longer has to manufacture.
    pub fn open_public_mint(&mut self) {
        expect_ok(self.unpause(), "open_public_mint: unpause");
        assert!(
            self.config().public_mint_enabled,
            "round 8 posture: initialize must leave the public mint OPEN"
        );
        assert!(!self.config().paused, "open_public_mint left the protocol paused");
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
    ///
    /// The amount is `DEFAULT_MIN_OPERATION_USDC` and NOT the 1 USDC it used to be: round 5 P1-04
    /// added an availability floor at step 3b, which sits BEFORE the oracle read, so a 1 USDC call
    /// now stops at OperationBelowMinimum and never reaches the marker these tests read. Use
    /// `try_mint_amount` to exercise the floor itself.
    pub fn try_mint(&mut self, user: &Keypair, supply_kyc: bool) -> TxOutcome {
        self.try_mint_amount(user, supply_kyc, DEFAULT_MIN_OPERATION_USDC)
    }

    /// `try_mint` with an explicit `amount_usdc`, so a test can drive the round 5 P1-04 floor from
    /// both sides without every other caller having to carry the amount.
    pub fn try_mint_amount(
        &mut self,
        user: &Keypair,
        supply_kyc: bool,
        amount_usdc: u64,
    ) -> TxOutcome {
        let pid = program_id();
        let classic = pk(CLASSIC_TOKEN_PROGRAM);
        let t22 = pk(TOKEN_2022_PROGRAM);
        let kyc_slot = if supply_kyc {
            kyc_pda(&user.pubkey())
        } else {
            pid
        };
        let mut args = amount_usdc.to_le_bytes().to_vec(); // amount_usdc
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

// ===================================================================================================
// ROUND 5 P1-03: a Lazer that actually EXECUTES, so the anti-replay high-water mark can be observed
// being written and then enforced.
//
// The finding: `tools/lazer-harness` names a test `the_same_envelope_cannot_be_consumed_twice`, but
// it PRE-WRITES `last_used_feed_ts_us` into a hand-built config and calls `probe_oracle_price` once.
// The probe is read-only by construction (its own module header says so), so that test never exercises
// a write. The only two writes in the program are `mint_silv.rs` and `redeem_silv.rs`, and deleting
// either one left the reassuringly-named test green.
//
// Everything below exists to close that: a mock Lazer program installed as EXECUTABLE, a real signed
// envelope, funded token accounts, and mint/redeem calls that succeed. The base fixture deliberately
// keeps the Lazer account NON-executable (several tests read LazerProgramNotExecutable as the marker
// that an earlier gate let the call through), so installing the mock is opt-in per test.
// ===================================================================================================

pub const LAZER_TREASURY: &str = "Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak";
/// Offset of the fee field inside the Lazer storage account, mirroring tools/lazer-harness.
const STORAGE_FEE_OFFSET: usize = 72;
const LAZER_CHANNEL_ID: u8 = 4; // the subscribed channel: fixed_rate@1000ms
const SILV_FEED_ID: u32 = 3154; // Metal.Index.SILVER/USD
/// The fee the mock drains from the isolated fee-payer PDA. 1 lamport keeps the arithmetic visible.
const LAZER_FEE_LAMPORTS: u64 = 1;

/// A price inside every default oracle guard: $58.34 at exponent -5, 3 publishers, 1bp of confidence.
/// Chosen to be the same figure the round 5 finding was measured at, so the two read as one story.
pub const SILV_PRICE_MANTISSA: i64 = 5_834_000;
pub const SILV_PRICE_EXPONENT: i16 = -5;

fn mock_lazer_path() -> String {
    format!("{}/../../target/harness/mock_lazer.so", env!("CARGO_MANIFEST_DIR"))
}

/// SPL Token account body (165 bytes), written directly rather than minted: the fixture's USDC mint
/// authority is a key nobody holds, so there is no `mint_to` path, and fabricating the balance is
/// both shorter and independent of the token program's own behaviour.
fn token_account_body(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

impl Fixture {
    /// Current on-chain time in microseconds. Read from the sysvar rather than from NOW_SECS: the
    /// timelock helpers WARP, so a payload stamped with the constant would be stale by a day and the
    /// call would fail on staleness instead of on the thing under test.
    pub fn now_us(&self) -> u64 {
        let clock: solana_sdk::clock::Clock = self.svm.get_sysvar();
        (clock.unix_timestamp as u64) * 1_000_000
    }

    /// Replace the deliberately non-executable Lazer account with the mock program, and stand up the
    /// storage and treasury accounts its CPI reads. Opt-in, per test.
    pub fn install_mock_lazer(&mut self) {
        let path = mock_lazer_path();
        let elf = std::fs::read(&path).unwrap_or_else(|e| {
            panic!("read {path}: {e}\nBuild it: bash tools/state-harness/run.sh (it builds mock-lazer into target/harness)")
        });
        self.svm.add_program(pk(LAZER_PROGRAM_ID), &elf).unwrap();

        // storage: treasury pubkey at [40..72], fee at [72..80]. `read_treasury` validates the
        // treasury account passed to the CPI against this field, so the two must agree.
        let mut storage = vec![0u8; STORAGE_FEE_OFFSET + 16];
        storage[40..72].copy_from_slice(pk(LAZER_TREASURY).as_ref());
        storage[STORAGE_FEE_OFFSET..STORAGE_FEE_OFFSET + 8]
            .copy_from_slice(&LAZER_FEE_LAMPORTS.to_le_bytes());
        self.svm
            .set_account(
                pk(LAZER_STORAGE),
                Account {
                    lamports: 5_000_000,
                    data: storage,
                    owner: pk(LAZER_PROGRAM_ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        self.svm
            .set_account(
                pk(LAZER_TREASURY),
                Account {
                    lamports: 5_000_000,
                    data: vec![],
                    owner: solana_sdk::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// Give an existing SPL token account a balance by writing its body. Used for the user's USDC and
    /// for the treasury that a redemption pays out of.
    pub fn fund_token_account(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) {
        let token_program = pk(CLASSIC_TOKEN_PROGRAM);
        let addr = ata(mint, owner, &token_program);
        self.svm
            .set_account(
                addr,
                Account {
                    lamports: 2_039_280, // rent-exempt minimum for a 165-byte account
                    data: token_account_body(mint, owner, amount),
                    owner: token_program,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// Balance of an SPL token account, or 0 if it does not exist.
    pub fn token_balance(&self, mint: &Pubkey, owner: &Pubkey, token_program: &str) -> u64 {
        let addr = ata(mint, owner, &pk(token_program));
        self.svm
            .get_account(&addr)
            .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
            .unwrap_or(0)
    }
}

/// A canonical Lazer payload, LE-serialized, exactly as tools/lazer-harness builds it. `feed_ts_us`
/// is the field the anti-replay high-water mark is compared against, so it is the only knob these
/// tests turn.
pub fn lazer_payload(feed_ts_us: u64) -> Vec<u8> {
    lazer_payload_at(feed_ts_us, feed_ts_us)
}

/// `global_ts` and `feed_ts` separately, because the program rejects a carried-forward print (the two
/// disagreeing). Every test here passes them equal; the split exists so a future test can drive that.
pub fn lazer_payload_at(global_ts_us: u64, feed_ts_us: u64) -> Vec<u8> {
    use byteorder::LittleEndian;
    use pyth_lazer_protocol::payload::{AggregatedPriceFeedData, PayloadData};
    use pyth_lazer_protocol::time::TimestampUs;
    use pyth_lazer_protocol::{ChannelId, Price, PriceFeedId, PriceFeedProperty};

    let mut agg = AggregatedPriceFeedData::empty(
        SILV_PRICE_EXPONENT,
        pyth_lazer_protocol::api::MarketSession::Regular,
        TimestampUs::from_micros(feed_ts_us),
    );
    agg.price = Some(Price::from_mantissa(SILV_PRICE_MANTISSA).unwrap());
    agg.confidence = Some(Price::from_mantissa(100).unwrap());
    agg.publisher_count = 3;
    let payload = PayloadData::new(
        TimestampUs::from_micros(global_ts_us),
        ChannelId(LAZER_CHANNEL_ID),
        &[(PriceFeedId(SILV_FEED_ID), agg)],
        &[
            PriceFeedProperty::Price,
            PriceFeedProperty::PublisherCount,
            PriceFeedProperty::Exponent,
            PriceFeedProperty::Confidence,
            PriceFeedProperty::FeedUpdateTimestamp,
        ],
    );
    let mut buf = Vec::new();
    payload.serialize::<LittleEndian>(&mut buf).unwrap();
    buf
}

/// The trailing three args every priced instruction takes: `message_data: Vec<u8>` (4-byte length
/// prefix), `ed25519_instruction_index: u16`, `signature_index: u8`. The mock ignores the last two.
pub fn envelope_args(message_data: &[u8]) -> Vec<u8> {
    let mut d = Vec::with_capacity(message_data.len() + 7);
    d.extend_from_slice(&(message_data.len() as u32).to_le_bytes());
    d.extend_from_slice(message_data);
    d.extend_from_slice(&0u16.to_le_bytes());
    d.push(0);
    d
}

impl Fixture {
    /// `mint_silv` with a REAL envelope and the REAL Lazer treasury, so the call can succeed. This is
    /// the difference from `try_mint_amount`, which passes a random treasury and a non-executable
    /// Lazer on purpose and can therefore never reach a write.
    pub fn mint_priced(&mut self, user: &Keypair, amount_usdc: u64, message_data: &[u8]) -> TxOutcome {
        let pid = program_id();
        let classic = pk(CLASSIC_TOKEN_PROGRAM);
        let t22 = pk(TOKEN_2022_PROGRAM);
        let mut args = amount_usdc.to_le_bytes().to_vec();
        args.extend_from_slice(&0u64.to_le_bytes()); // min_silv_out
        args.extend_from_slice(&envelope_args(message_data));
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
                AccountMeta::new(pk(LAZER_TREASURY), false),
                AccountMeta::new(lazer_fee_payer_pda(), false),
                AccountMeta::new_readonly(solana_sdk::sysvar::instructions::ID, false),
                AccountMeta::new_readonly(pid, false), // fee_exempt: None
                AccountMeta::new_readonly(pid, false), // kyc: None
                AccountMeta::new_readonly(classic, false),
                AccountMeta::new_readonly(t22, false),
                AccountMeta::new_readonly(pk(ASSOCIATED_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("mint_silv", &args),
        };
        self.send(&[ix], &[user])
    }

    /// `redeem_silv` with a REAL envelope. Same account order as `RedeemSilv` in the program, which
    /// differs from mint: it carries `treasury_pda` (the signer of the payout) and no mint authority.
    pub fn redeem_priced(&mut self, user: &Keypair, amount_silv: u64, message_data: &[u8]) -> TxOutcome {
        let pid = program_id();
        let classic = pk(CLASSIC_TOKEN_PROGRAM);
        let t22 = pk(TOKEN_2022_PROGRAM);
        let mut args = amount_silv.to_le_bytes().to_vec();
        args.extend_from_slice(&0u64.to_le_bytes()); // min_usdc_out
        args.extend_from_slice(&envelope_args(message_data));
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
                AccountMeta::new_readonly(treasury_pda(), false),
                AccountMeta::new_readonly(pk(LAZER_PROGRAM_ID), false),
                AccountMeta::new_readonly(pk(LAZER_STORAGE), false),
                AccountMeta::new(pk(LAZER_TREASURY), false),
                AccountMeta::new(lazer_fee_payer_pda(), false),
                AccountMeta::new_readonly(solana_sdk::sysvar::instructions::ID, false),
                AccountMeta::new_readonly(pid, false), // fee_exempt: None
                AccountMeta::new_readonly(pid, false), // kyc: None
                AccountMeta::new_readonly(classic, false),
                AccountMeta::new_readonly(t22, false),
                AccountMeta::new_readonly(pk(ASSOCIATED_TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("redeem_silv", &args),
        };
        self.send(&[ix], &[user])
    }

    /// How much SILV is worth `usdc` at the harness price, so a test can express "an operation at the
    /// floor" without hardcoding a number that goes stale with the price constant.
    pub fn silv_for_usdc(&self, usdc: u64) -> u64 {
        // gross = amount_silv * price / 1e9, so amount_silv = ceil(usdc * 1e9 / price). Ceil, because
        // the caller wants to be AT OR ABOVE the floor and flooring would land one atom under it.
        let price = (SILV_PRICE_MANTISSA as u128) * 10u128.pow((9 + SILV_PRICE_EXPONENT) as u32);
        let num = (usdc as u128) * 1_000_000_000u128;
        (num.div_ceil(price)) as u64
    }

    /// `set_min_operation_usdc`, the instant setter, for tests that need the floor out of the way.
    pub fn set_min_operation_usdc(&mut self, new_min: u64) {
        let admin = self.admin.insecure_clone();
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(admin.pubkey(), true),
            ],
            data: ix_data("set_min_operation_usdc", &new_min.to_le_bytes()),
        };
        expect_ok(self.send(&[ix], &[&admin]), "set_min_operation_usdc");
    }

    /// Reopen redemptions the ONLY way the program allows: the 24h-timelocked SetRedeemLimits action
    /// carrying `redemptions_enabled = Some(true)`. Both instant setters refuse `true` by
    /// construction, so a test that needs to go from CLOSED to OPEN has to go the long way, and going
    /// the long way is also what proves the path exists.
    ///
    /// ROUND 8: `initialize` now leaves redemptions OPEN, so this is a REOPENER and it asserts that.
    /// Calling it on the launch state would be a 24h warp that proves nothing; `require_redemptions_open`
    /// is what a test that merely needs an open redeem path should call.
    pub fn reopen_redemptions(&mut self) {
        assert!(
            !self.config().redemptions_enabled,
            "reopen_redemptions was called on an already-open protocol, so it would have proved \
             nothing; close redemptions first, or call require_redemptions_open"
        );
        let admin = self.admin.insecure_clone();
        let pid = program_id();
        // Borsh of RedeemLimitsArgs: four None tags then Some(true).
        let args = vec![0u8, 0, 0, 0, 1, 1];
        let nonce = self.config().next_timelock_nonce;
        let propose = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(timelock_pda(nonce), false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("propose_set_redeem_limits", &args),
        };
        expect_ok(self.send(&[propose], &[&admin]), "reopen_redemptions: propose");

        self.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
        let execute = Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(config_pda(), false),
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new(timelock_pda(nonce), false),
                AccountMeta::new(admin.pubkey(), false),
            ],
            data: ix_data("execute_set_redeem_limits", &nonce.to_le_bytes()),
        };
        expect_ok(self.send(&[execute], &[&admin]), "reopen_redemptions: execute");
        assert!(
            self.config().redemptions_enabled,
            "reopen_redemptions left redemptions closed"
        );
    }

    /// ROUND 8 posture: assert the redeem path is open rather than manufacture it. This is the
    /// replacement for the old `open_redemptions()` at call sites that only wanted a live redeem
    /// path; it deliberately does NOT warp, and several oracle tests stamp envelopes right after it.
    pub fn require_redemptions_open(&self) {
        assert!(
            self.config().redemptions_enabled,
            "round 8 posture: initialize must leave redemptions OPEN"
        );
    }
}
