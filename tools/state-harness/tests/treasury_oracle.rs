// On-chain tests for the timelocked treasury withdraw and the three oracle-parameter handlers that
// auto-pause. Every assertion reads the config or a token account back OUT of the VM after a real
// transaction, so a discarded write, a deleted require or a dropped account constraint is visible.

mod common;

use common::*;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- constants

const E_CONSTRAINT_ADDRESS: u32 = 2012;
const E_ABOVE_MAXIMUM: u32 = 12003;
const E_PRICE_OUT_OF_BOUNDS: u32 = 12006;
const E_INSUFFICIENT_TREASURY: u32 = 12014;
const E_WITHDRAW_BLOCKED_WHILE_PAUSED: u32 = 12036;
const E_WITHDRAW_RECIPIENT_MISMATCH: u32 = 12048;
const E_FLOOR_BREACHED: u32 = 12062;

/// Launch defaults from state/config.rs, the values the fixture initializes with.
const DEFAULT_STALENESS: u32 = 15;
const DEFAULT_MAX_PRICE_SCALED: u64 = 200_000_000_000;
const DEFAULT_FEED_ID: u32 = 3154;
/// Structural ceilings the propose and execute sides both re-validate against.
const MAX_STALENESS_CEILING_SECONDS: u32 = 30;
const PRICE_FATFINGER_MAX_SCALED: u64 = 200_000_000_000;

/// The treasury floor these tests install. The launch default is 0, so the D7 check would never
/// bind and a deleted float require would be invisible.
const FLOOR: u64 = 5_000_000;
const TREASURY_START: u64 = 10_000_000;

/// `action_data` bytes start after the 8-byte discriminator, the u64 nonce, the u8 action_disc and
/// the 4-byte Vec length.
const ACTION_DATA_OFFSET: usize = 8 + 8 + 1 + 4;

// ---------------------------------------------------------------- oracle guard args

/// Borsh mirror of `execute::OracleGuardsArgs`, in declaration order. Only the fields these tests
/// move are modelled as setters; the rest serialize as the `None` tag.
#[derive(Default, Clone)]
struct Guards {
    staleness: Option<u32>,
    conf_bps: Option<u16>,
    min_price_scaled: Option<u64>,
    max_price_scaled: Option<u64>,
    max_delta_bps: Option<u16>,
    decay_seconds: Option<u32>,
    dust_filter_min_usdc: Option<u64>,
    min_publishers: Option<u16>,
}

fn opt(v: Option<&[u8]>) -> Vec<u8> {
    match v {
        None => vec![0],
        Some(b) => {
            let mut d = vec![1];
            d.extend_from_slice(b);
            d
        }
    }
}

impl Guards {
    fn encode(&self) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend(opt(self.staleness.map(u32::to_le_bytes).as_ref().map(|b| &b[..])));
        d.extend(opt(self.conf_bps.map(u16::to_le_bytes).as_ref().map(|b| &b[..])));
        d.extend(opt(self
            .min_price_scaled
            .map(u64::to_le_bytes)
            .as_ref()
            .map(|b| &b[..])));
        d.extend(opt(self
            .max_price_scaled
            .map(u64::to_le_bytes)
            .as_ref()
            .map(|b| &b[..])));
        d.extend(opt(self
            .max_delta_bps
            .map(u16::to_le_bytes)
            .as_ref()
            .map(|b| &b[..])));
        d.extend(opt(self
            .decay_seconds
            .map(u32::to_le_bytes)
            .as_ref()
            .map(|b| &b[..])));
        d.extend(opt(self
            .dust_filter_min_usdc
            .map(u64::to_le_bytes)
            .as_ref()
            .map(|b| &b[..])));
        d.extend(opt(self
            .min_publishers
            .map(u16::to_le_bytes)
            .as_ref()
            .map(|b| &b[..])));
        d
    }
}

// ---------------------------------------------------------------- generic helpers

/// ROUND 8: `unpause` demands an active guardian distinct from the admin, so the seven copies of
/// this helper now all route through the one in common, which installs that guardian on demand.
fn unpause(f: &mut Fixture) {
    expect_ok(f.unpause(), "unpause");
    assert!(!f.config().paused, "unpause did not clear config.paused");
}

fn pause(f: &mut Fixture) {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new_readonly(program_id(), false), // guardian: None
        ],
        data: ix_data("pause", &[]),
    };
    expect_ok(f.send(&[ix], &[&admin]), "pause");
    assert!(f.config().paused, "pause did not set config.paused");
}

/// Propose an admin action, returning the nonce the timelock account was created under.
fn propose(f: &mut Fixture, name: &str, args: &[u8]) -> u64 {
    let admin = f.admin.insecure_clone();
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data(name, args),
    };
    expect_ok(f.send(&[ix], &[&admin]), name);
    nonce
}

/// The same propose, expected to fail before any timelock account exists.
fn try_propose(f: &mut Fixture, name: &str, args: &[u8]) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data(name, args),
    };
    f.send(&[ix], &[&admin])
}

/// The four-account execute shape shared by compliance, oracle guards, pyth feed and float.
fn try_execute(f: &mut Fixture, name: &str, nonce: u64, signer: &Keypair) -> TxOutcome {
    let rent_recipient = f.admin.pubkey();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(rent_recipient, false),
        ],
        data: ix_data(name, &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

/// Overwrite a queued proposal's `action_data` in place, keeping its length so the borsh fields
/// after the Vec stay where Anchor wrote them. The only way to reach the execute-side re-validation:
/// propose refuses the out-of-bounds value, which is exactly the 24h-window attacker execute guards
/// against.
fn patch_action_data(f: &mut Fixture, nonce: u64, new_bytes: &[u8]) {
    let addr = timelock_pda(nonce);
    let mut acc = f.svm.get_account(&addr).expect("timelock account is missing");
    let len = u32::from_le_bytes(
        acc.data[ACTION_DATA_OFFSET - 4..ACTION_DATA_OFFSET]
            .try_into()
            .unwrap(),
    ) as usize;
    assert_eq!(
        len,
        new_bytes.len(),
        "the patched action_data must keep the stored length"
    );
    acc.data[ACTION_DATA_OFFSET..ACTION_DATA_OFFSET + len].copy_from_slice(new_bytes);
    f.svm.set_account(addr, acc).unwrap();
}

// ---------------------------------------------------------------- token helpers

fn token_amount(f: &Fixture, addr: &Pubkey) -> u64 {
    let acc = f.svm.get_account(addr).expect("token account does not exist");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/// Patch a live SPL token account's `amount` (offset 64). Funding through a mint CPI would need a
/// mint authority these tests do not hold, and the balance is all the withdraw path reads.
fn set_token_amount(f: &mut Fixture, addr: &Pubkey, amount: u64) {
    let mut acc = f.svm.get_account(addr).expect("token account does not exist");
    acc.data[64..72].copy_from_slice(&amount.to_le_bytes());
    f.svm.set_account(*addr, acc).unwrap();
}

/// A raw 165-byte classic token account at a fresh address, so it can carry an arbitrary OWNER.
fn make_token_account(f: &mut Fixture, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let addr = Pubkey::new_unique();
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    f.svm
        .set_account(
            addr,
            Account {
                lamports: 10_000_000,
                data,
                owner: pk(CLASSIC_TOKEN_PROGRAM),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    addr
}

// ---------------------------------------------------------------- withdraw fixture

struct Wd {
    treasury: Pubkey,
    recipient: Pubkey,
    recipient_ata: Pubkey,
}

/// `treasury_min_float_usdc` through its only path, the 24h timelock.
fn set_treasury_floor(f: &mut Fixture, value: u64) {
    let nonce = propose(f, "propose_set_treasury_min_float", &value.to_le_bytes());
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    let admin = f.admin.insecure_clone();
    expect_ok(
        try_execute(f, "execute_set_treasury_min_float", nonce, &admin),
        "execute_set_treasury_min_float",
    );
    assert_eq!(
        f.config().treasury_min_float_usdc,
        value,
        "the treasury floor did not persist"
    );
}

/// An unpaused program with a non-zero treasury floor, a funded treasury USDC ATA and a recipient
/// USDC ATA owned by `holder`.
fn withdraw_fixture() -> (Fixture, Wd) {
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    set_treasury_floor(&mut f, FLOOR);

    let admin = f.admin.insecure_clone();
    let holder = f.holder.pubkey();
    let classic = pk(CLASSIC_TOKEN_PROGRAM);
    let ix = create_ata_ix(&admin.pubkey(), &holder, &f.usdc_mint, &classic);
    expect_ok(f.send(&[ix], &[&admin]), "create the recipient USDC ATA");

    let w = Wd {
        treasury: ata(&f.usdc_mint, &treasury_pda(), &classic),
        recipient: holder,
        recipient_ata: ata(&f.usdc_mint, &holder, &classic),
    };
    set_token_amount(&mut f, &w.treasury, TREASURY_START);
    assert_eq!(token_amount(&f, &w.recipient_ata), 0, "recipient starts empty");
    (f, w)
}

fn propose_withdraw(f: &mut Fixture, amount: u64, recipient: &Pubkey) -> u64 {
    let mut args = amount.to_le_bytes().to_vec();
    args.extend_from_slice(recipient.as_ref());
    propose(f, "propose_withdraw_usdc", &args)
}

/// `execute_withdraw_usdc` with every account overridable, so a test can substitute a decoy
/// treasury, a foreign recipient ATA or a non-admin signer.
#[allow(clippy::too_many_arguments)]
fn try_execute_withdraw(
    f: &mut Fixture,
    nonce: u64,
    signer: &Keypair,
    usdc_treasury: Pubkey,
    recipient_ata: Pubkey,
) -> TxOutcome {
    let rent_recipient = f.admin.pubkey();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(rent_recipient, false),
            AccountMeta::new(f.usdc_mint, false),
            AccountMeta::new(usdc_treasury, false),
            AccountMeta::new(recipient_ata, false),
            AccountMeta::new_readonly(treasury_pda(), false),
            AccountMeta::new_readonly(pk(CLASSIC_TOKEN_PROGRAM), false),
        ],
        data: ix_data("execute_withdraw_usdc", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

// ---------------------------------------------------------------- withdraw: the float

#[test]
fn execute_withdraw_moves_the_usdc_and_stops_exactly_at_the_treasury_float() {
    // D7: a withdraw down TO the float is allowed and the USDC really moves; one atom below it is
    // refused, and the refused proposal stays armed rather than being consumed.
    let (mut f, w) = withdraw_fixture();
    let admin = f.admin.insecure_clone();

    let to_floor = TREASURY_START - FLOOR;
    let n1 = propose_withdraw(&mut f, to_floor, &w.recipient);
    assert_eq!(f.config().pending_withdraw_nonce, Some(n1));
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(
        try_execute_withdraw(&mut f, n1, &admin, w.treasury, w.recipient_ata),
        "withdraw down to the float",
    );

    assert_eq!(token_amount(&f, &w.treasury), FLOOR, "treasury after withdraw");
    assert_eq!(
        token_amount(&f, &w.recipient_ata),
        to_floor,
        "the recipient did not receive the USDC"
    );
    let c = f.config();
    assert_eq!(c.pending_withdraw_nonce, None, "the withdraw slot must clear");
    assert_eq!(c.active_proposal_count, 0, "active_proposal_count must decrement");

    let n2 = propose_withdraw(&mut f, 1, &w.recipient);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute_withdraw(&mut f, n2, &admin, w.treasury, w.recipient_ata),
        E_FLOOR_BREACHED,
        "one atom below the float",
    );
    assert_eq!(token_amount(&f, &w.treasury), FLOOR, "the treasury must not move");
    assert_eq!(
        token_amount(&f, &w.recipient_ata),
        to_floor,
        "the recipient must not move"
    );
    assert_eq!(
        f.config().pending_withdraw_nonce,
        Some(n2),
        "a refused execute must leave the proposal armed"
    );
}

#[test]
fn execute_withdraw_refuses_more_than_the_treasury_holds() {
    // InsufficientTreasury fires before the float check, so an over-withdraw cannot underflow into
    // a passing treasury_post.
    let (mut f, w) = withdraw_fixture();
    let admin = f.admin.insecure_clone();

    let n = propose_withdraw(&mut f, TREASURY_START + 1, &w.recipient);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute_withdraw(&mut f, n, &admin, w.treasury, w.recipient_ata),
        E_INSUFFICIENT_TREASURY,
        "withdraw over the treasury balance",
    );
    assert_eq!(token_amount(&f, &w.treasury), TREASURY_START);
    assert_eq!(token_amount(&f, &w.recipient_ata), 0);
}

// ---------------------------------------------------------------- withdraw: the accounts

#[test]
fn execute_withdraw_refuses_a_treasury_account_the_config_does_not_name() {
    // Without the `address = config.usdc_treasury` pin, any token account the treasury PDA can sign
    // for is drainable and the float check applies to whatever balance was passed.
    let (mut f, w) = withdraw_fixture();
    let admin = f.admin.insecure_clone();
    let usdc_mint = f.usdc_mint;
    let decoy = make_token_account(&mut f, &usdc_mint, &treasury_pda(), 50_000_000);

    let n = propose_withdraw(&mut f, 40_000_000, &w.recipient);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute_withdraw(&mut f, n, &admin, decoy, w.recipient_ata),
        E_CONSTRAINT_ADDRESS,
        "a decoy treasury the PDA owns",
    );
    assert_eq!(token_amount(&f, &decoy), 50_000_000, "the decoy must not move");
    assert_eq!(token_amount(&f, &w.treasury), TREASURY_START);
    assert_eq!(token_amount(&f, &w.recipient_ata), 0);
}

#[test]
fn execute_withdraw_binds_the_recipient_announced_24h_earlier() {
    // The recipient in action_data must still own the ATA at execute time, otherwise the announced
    // destination stops binding once the window matures.
    let (mut f, w) = withdraw_fixture();
    let admin = f.admin.insecure_clone();
    let usdc_mint = f.usdc_mint;
    let stranger = f.stranger.pubkey();
    let foreign_ata = make_token_account(&mut f, &usdc_mint, &stranger, 0);

    let n = propose_withdraw(&mut f, 1_000_000, &w.recipient);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute_withdraw(&mut f, n, &admin, w.treasury, foreign_ata),
        E_WITHDRAW_RECIPIENT_MISMATCH,
        "an ATA owned by somebody other than the announced recipient",
    );
    assert_eq!(token_amount(&f, &foreign_ata), 0, "the stranger must receive nothing");
    assert_eq!(token_amount(&f, &w.treasury), TREASURY_START);

    // The same matured proposal still pays the announced recipient.
    expect_ok(
        try_execute_withdraw(&mut f, n, &admin, w.treasury, w.recipient_ata),
        "the announced recipient",
    );
    assert_eq!(token_amount(&f, &w.recipient_ata), 1_000_000);
}

#[test]
fn execute_withdraw_is_admin_gated() {
    // Without `has_one = admin`, anyone triggers a matured treasury withdrawal.
    let (mut f, w) = withdraw_fixture();
    let stranger = f.stranger.insecure_clone();

    let n = propose_withdraw(&mut f, 1_000_000, &w.recipient);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute_withdraw(&mut f, n, &stranger, w.treasury, w.recipient_ata),
        E_CONSTRAINT_HAS_ONE,
        "a stranger executing the withdrawal",
    );
    assert_eq!(token_amount(&f, &w.treasury), TREASURY_START);
    assert_eq!(token_amount(&f, &w.recipient_ata), 0);
    assert_eq!(f.config().pending_withdraw_nonce, Some(n));
}

#[test]
fn a_matured_withdrawal_cannot_land_mid_incident() {
    // D31: pausing must hold a matured withdrawal, and unpausing must let the same proposal through.
    let (mut f, w) = withdraw_fixture();
    let admin = f.admin.insecure_clone();

    let n = propose_withdraw(&mut f, 1_000_000, &w.recipient);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    pause(&mut f);
    expect_error(
        try_execute_withdraw(&mut f, n, &admin, w.treasury, w.recipient_ata),
        E_WITHDRAW_BLOCKED_WHILE_PAUSED,
        "a withdrawal executed while paused",
    );
    assert_eq!(token_amount(&f, &w.treasury), TREASURY_START);
    assert_eq!(token_amount(&f, &w.recipient_ata), 0);

    unpause(&mut f);
    expect_ok(
        try_execute_withdraw(&mut f, n, &admin, w.treasury, w.recipient_ata),
        "the same withdrawal once unpaused",
    );
    assert_eq!(token_amount(&f, &w.treasury), TREASURY_START - 1_000_000);
    assert_eq!(token_amount(&f, &w.recipient_ata), 1_000_000);
}

// ---------------------------------------------------------------- the three auto-pauses

#[test]
fn execute_set_oracle_guards_writes_the_guards_and_auto_pauses() {
    // The new guard value must persist AND the protocol must be paused in the same transaction, so
    // a re-validated feed cannot go live silently after the window.
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    let admin = f.admin.insecure_clone();

    let g = Guards {
        staleness: Some(25),
        ..Default::default()
    };
    let n = propose(&mut f, "propose_set_oracle_guards", &g.encode());
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(
        try_execute(&mut f, "execute_set_oracle_guards", n, &admin),
        "execute_set_oracle_guards",
    );

    let c = f.config();
    assert_eq!(c.max_staleness_seconds, 25, "the new staleness did not persist");
    assert!(c.paused, "an oracle-guard change must auto-pause");
    assert_eq!(c.pending_oracle_guards_nonce, None, "the guards slot must clear");
    assert_eq!(c.active_proposal_count, 0, "active_proposal_count must decrement");
}

#[test]
fn execute_set_pyth_feed_writes_the_feed_and_auto_pauses() {
    // The SILV feed id must not change while mint and redeem keep running against it unreviewed.
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    let admin = f.admin.insecure_clone();
    assert_eq!(f.config().pyth_lazer_feed_id, DEFAULT_FEED_ID);

    let n = propose(&mut f, "propose_set_pyth_feed", &9_999u32.to_le_bytes());
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(
        try_execute(&mut f, "execute_set_pyth_feed", n, &admin),
        "execute_set_pyth_feed",
    );

    let c = f.config();
    assert_eq!(c.pyth_lazer_feed_id, 9_999, "the new feed id did not persist");
    assert!(c.paused, "a feed change must auto-pause");
    assert_eq!(c.pending_pyth_feed_nonce, None, "the feed slot must clear");
}

#[test]
fn execute_set_compliance_mode_flips_the_mode_and_auto_pauses() {
    // M4: the third instance of the same shape. A compliance flip must never leave the protocol
    // running before off-chain governance is confirmed ready.
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    let admin = f.admin.insecure_clone();
    assert!(!f.config().compliance_mode);

    let n = propose(&mut f, "propose_set_compliance_mode", &[1]);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(
        try_execute(&mut f, "execute_set_compliance_mode", n, &admin),
        "execute_set_compliance_mode",
    );

    let c = f.config();
    assert!(c.compliance_mode, "the compliance flip did not persist");
    assert!(c.paused, "a compliance flip must auto-pause");
    assert_eq!(c.pending_compliance_nonce, None, "the compliance slot must clear");
}

#[test]
fn execute_set_oracle_guards_is_admin_gated() {
    // Without `has_one = admin`, a third party controls when the guards flip and the protocol
    // auto-pauses.
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    let stranger = f.stranger.insecure_clone();

    let g = Guards {
        staleness: Some(25),
        ..Default::default()
    };
    let n = propose(&mut f, "propose_set_oracle_guards", &g.encode());
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute(&mut f, "execute_set_oracle_guards", n, &stranger),
        E_CONSTRAINT_HAS_ONE,
        "a stranger executing the oracle guards",
    );

    let c = f.config();
    assert_eq!(c.max_staleness_seconds, DEFAULT_STALENESS, "guards must not move");
    assert!(!c.paused, "a refused execute must not auto-pause");
    assert_eq!(c.pending_oracle_guards_nonce, Some(n), "the proposal stays armed");
}

// ---------------------------------------------------------------- the fat-finger rails

#[test]
fn the_staleness_ceiling_binds_at_propose_and_again_at_execute() {
    // Both sides re-validate: propose fails fast, and execute refuses a payload that was tampered
    // with during the 24h window. A frozen price must never be acceptable indefinitely.
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    let admin = f.admin.insecure_clone();

    let over = Guards {
        staleness: Some(MAX_STALENESS_CEILING_SECONDS + 1),
        ..Default::default()
    };
    let before = f.config().next_timelock_nonce;
    expect_error(
        try_propose(&mut f, "propose_set_oracle_guards", &over.encode()),
        E_ABOVE_MAXIMUM,
        "propose a staleness above the ceiling",
    );
    let c = f.config();
    assert_eq!(c.next_timelock_nonce, before, "no nonce may be consumed");
    assert_eq!(c.pending_oracle_guards_nonce, None, "no proposal may be armed");
    assert_eq!(c.max_staleness_seconds, DEFAULT_STALENESS);

    let ok = Guards {
        staleness: Some(25),
        ..Default::default()
    };
    let n = propose(&mut f, "propose_set_oracle_guards", &ok.encode());
    patch_action_data(&mut f, n, &over.encode());
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute(&mut f, "execute_set_oracle_guards", n, &admin),
        E_ABOVE_MAXIMUM,
        "execute a staleness above the ceiling",
    );
    let c = f.config();
    assert_eq!(c.max_staleness_seconds, DEFAULT_STALENESS, "guards must not move");
    assert!(!c.paused, "a refused execute must not auto-pause");
}

#[test]
fn the_max_price_fat_finger_rail_binds_at_propose_and_again_at_execute() {
    // max_price_usd_scaled = 0 bricks every oracle read until another 24h window, and a value over
    // the absolute rail widens the sanity band. Both sides must refuse.
    let mut f = Fixture::new_bare();
    unpause(&mut f);
    let admin = f.admin.insecure_clone();

    let over = Guards {
        max_price_scaled: Some(PRICE_FATFINGER_MAX_SCALED + 1),
        ..Default::default()
    };
    let before = f.config().next_timelock_nonce;
    expect_error(
        try_propose(&mut f, "propose_set_oracle_guards", &over.encode()),
        E_PRICE_OUT_OF_BOUNDS,
        "propose a max price above the absolute rail",
    );
    assert_eq!(f.config().next_timelock_nonce, before, "no nonce may be consumed");

    let zero = Guards {
        max_price_scaled: Some(0),
        ..Default::default()
    };
    expect_error(
        try_propose(&mut f, "propose_set_oracle_guards", &zero.encode()),
        E_PRICE_OUT_OF_BOUNDS,
        "propose a zero max price",
    );

    // The execute side is probed with the over-the-rail value, not zero: a zero upper bound is also
    // caught by the cross-field `min < max` require, so only this value isolates the rail itself.
    let ok = Guards {
        max_price_scaled: Some(150_000_000_000),
        ..Default::default()
    };
    let n = propose(&mut f, "propose_set_oracle_guards", &ok.encode());
    patch_action_data(&mut f, n, &over.encode());
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        try_execute(&mut f, "execute_set_oracle_guards", n, &admin),
        E_PRICE_OUT_OF_BOUNDS,
        "execute a max price above the absolute rail",
    );
    let c = f.config();
    assert_eq!(
        c.max_price_usd_scaled, DEFAULT_MAX_PRICE_SCALED,
        "the price band must not move"
    );
    assert!(!c.paused, "a refused execute must not auto-pause");
}
