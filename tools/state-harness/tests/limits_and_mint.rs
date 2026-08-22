// On-chain tests for the redeem-limit and public-mint timelock paths in instructions/admin/execute.rs.
// Every assertion reads the ConfigAccount back OUT of the VM after a real transaction: a discarded
// write, a dropped signer constraint or a re-validation that no longer runs is invisible to any unit
// test on the pure helpers.

mod common;

use borsh::{BorshDeserialize, BorshSerialize};
use common::*;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- codes and constants

const E_UNPAUSE_WITH_ARMED_PROPOSAL: u32 = 12126;
const E_TIMELOCK_TOO_SHORT: u32 = 12037;
const E_TIMELOCK_TOO_LONG: u32 = 12038;
const E_NONCE_MISMATCH: u32 = 12042;
const E_QUEUE_DELAY_TOO_SHORT: u32 = 12094;
const E_ABOVE_MAXIMUM: u32 = 12003;

const INSTANT_BUDGET_CEILING_USDC: u64 = 100_000_000_000_000;
const INSTANT_WINDOW_MIN_SECONDS: u32 = 60;
const INSTANT_WINDOW_MAX_SECONDS: u32 = 604_800;
const REDEEM_QUEUE_DELAY_MIN_SECONDS: u32 = 3_600;
const REDEEM_QUEUE_DELAY_MAX_SECONDS: u32 = 2_592_000;
const TREASURY_FLOAT_CEILING_USDC: u64 = 100_000_000_000_000;
const ADMIN_TIMELOCK_MAX_SECONDS: u32 = 604_800;

const DEFAULT_INSTANT_REDEEM_BUDGET_USDC: u64 = 20_000_000_000;
const DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS: u32 = 86_400;
const DEFAULT_LARGE_REDEEM_THRESHOLD_USDC: u64 = 5_000_000_000;
const DEFAULT_REDEEM_QUEUE_DELAY_SECONDS: u32 = 259_200;

const TL_DISC: &str = "account:TimelockQueueAccount";

// ---------------------------------------------------------------- timelock mirror

/// Mirror of `state::timelock::TimelockQueueAccount`, needed only to TAMPER with a queued payload
/// (see `overwrite_action_data`). The account is allocated at a fixed SIZE and the borsh body is
/// shorter, so the tail is padding and is not compared.
#[derive(BorshDeserialize, BorshSerialize, Debug, Clone)]
struct Timelock {
    nonce: u64,
    action_disc: u8,
    action_data: Vec<u8>,
    scheduled_at: i64,
    executable_at: i64,
    executed_at: Option<i64>,
    cancelled: bool,
    proposer: [u8; 32],
    rent_payer: [u8; 32],
}

fn read_timelock(f: &Fixture, nonce: u64) -> Option<Timelock> {
    let acc = f.svm.get_account(&timelock_pda(nonce))?;
    if acc.lamports == 0 || acc.data.len() < 8 {
        return None;
    }
    assert_eq!(
        &acc.data[..8],
        &anchor_disc(TL_DISC),
        "timelock: wrong account discriminator"
    );
    Some(
        Timelock::deserialize(&mut &acc.data[8..])
            .expect("timelock: borsh decode failed; the mirror struct drifted from the program"),
    )
}

/// Replace a QUEUED proposal's `action_data` in place, leaving every other field and the account
/// length untouched. The propose handlers pre-validate their payloads, so this is the only way to
/// reach the execute-side re-validation of the same bound.
fn overwrite_action_data(f: &mut Fixture, nonce: u64, action_data: Vec<u8>) {
    let src = f
        .svm
        .get_account(&timelock_pda(nonce))
        .expect("the timelock account does not exist");
    let mut tl = read_timelock(f, nonce).expect("the timelock account does not decode");
    tl.action_data = action_data;
    let mut data = anchor_disc(TL_DISC).to_vec();
    data.extend_from_slice(&borsh::to_vec(&tl).unwrap());
    assert!(
        data.len() <= src.data.len(),
        "the edited body outgrew the account"
    );
    data.resize(src.data.len(), 0);
    f.svm
        .set_account(
            timelock_pda(nonce),
            Account {
                lamports: src.lamports,
                data,
                owner: src.owner,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

// ---------------------------------------------------------------- RedeemLimitsArgs encoding

/// Borsh of `execute::RedeemLimitsArgs`: five `Option<T>` in declaration order, each a 1-byte tag
/// then the little-endian value.
#[derive(Default, Clone, Copy)]
struct Limits {
    budget: Option<u64>,
    window: Option<u32>,
    threshold: Option<u64>,
    delay: Option<u32>,
    enabled: Option<bool>,
}

fn push_opt(d: &mut Vec<u8>, v: Option<&[u8]>) {
    match v {
        Some(b) => {
            d.push(1);
            d.extend_from_slice(b);
        }
        None => d.push(0),
    }
}

impl Limits {
    fn encode(&self) -> Vec<u8> {
        let mut d = Vec::new();
        push_opt(&mut d, self.budget.map(u64::to_le_bytes).as_ref().map(|b| &b[..]));
        push_opt(&mut d, self.window.map(u32::to_le_bytes).as_ref().map(|b| &b[..]));
        push_opt(&mut d, self.threshold.map(u64::to_le_bytes).as_ref().map(|b| &b[..]));
        push_opt(&mut d, self.delay.map(u32::to_le_bytes).as_ref().map(|b| &b[..]));
        push_opt(&mut d, self.enabled.map(|v| [v as u8]).as_ref().map(|b| &b[..]));
        d
    }
}

// ---------------------------------------------------------------- instructions

fn propose_ix(name: &str, f: &Fixture, signer: &Keypair, args: &[u8]) -> (Instruction, u64) {
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data(name, args),
    };
    (ix, nonce)
}

fn execute_ix(name: &str, signer: &Keypair, nonce: u64, rent_recipient: Pubkey) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(rent_recipient, false),
        ],
        data: ix_data(name, &nonce.to_le_bytes()),
    }
}

fn propose_as(f: &mut Fixture, signer: &Keypair, name: &str, args: &[u8]) -> (TxOutcome, u64) {
    let (ix, nonce) = propose_ix(name, f, signer, args);
    (f.send(&[ix], &[signer]), nonce)
}

fn propose(f: &mut Fixture, name: &str, args: &[u8]) -> (TxOutcome, u64) {
    let admin = f.admin.insecure_clone();
    propose_as(f, &admin, name, args)
}

fn execute_as(f: &mut Fixture, signer: &Keypair, name: &str, nonce: u64) -> TxOutcome {
    let rent_recipient = f.admin.pubkey();
    let ix = execute_ix(name, signer, nonce, rent_recipient);
    f.send(&[ix], &[signer])
}

fn execute(f: &mut Fixture, name: &str, nonce: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    execute_as(f, &admin, name, nonce)
}

fn propose_limits(f: &mut Fixture, l: Limits) -> (TxOutcome, u64) {
    propose(f, "propose_set_redeem_limits", &l.encode())
}

fn pause(f: &mut Fixture) -> TxOutcome {
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
    f.send(&[ix], &[&admin])
}

/// routed through the common helper, which installs the independent guardian that
/// `unpause` now demands.
/// Cancel a queued action as the admin, so a test can reach the state the new
/// `unpause` requires: no armed slot. The instruction is `cancel_timelocked_action(nonce)`.
fn cancel_as_admin(f: &mut Fixture, nonce: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let tl = timelock_pda(nonce);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(tl, false),
            AccountMeta::new(admin.pubkey(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            // The guardian slot is optional; Anchor 0.31 expects the PROGRAM ID in the position of
            // an absent optional account, not an omitted key. Admin-signed cancels pass no guardian.
            AccountMeta::new_readonly(program_id(), false),
        ],
        data: ix_data("cancel_timelocked_action", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[&admin])
}

fn unpause(f: &mut Fixture) -> TxOutcome {
    f.unpause()
}

fn set_redemptions_enabled(f: &mut Fixture, enabled: bool) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: ix_data("set_redemptions_enabled", &[enabled as u8]),
    };
    f.send(&[ix], &[&admin])
}

/// An unpaused, initialized program. Every execute path below refuses to land while paused.
fn live() -> Fixture {
    let mut f = Fixture::new_bare();
    expect_ok(unpause(&mut f), "fixture: unpause");
    f
}

/// `live()`, then both switches CLOSED through their instant setters.
/// flipped the launch posture: `initialize` now ships `redemptions_enabled` and
/// `public_mint_enabled` open, so a proposal to open them is a ProposalNoOp and the timelocked OPEN
/// path becomes untestable from the launch state. The property under test never changed. Only the
/// starting point did, so these tests close first and then prove the open still costs 24 hours, is
/// still admin-only, still refuses to land while paused, and is still cancellable.
/// Closing is itself the permitted direction of both setters, and this helper asserts both landed:
/// if a close silently no-opped, every test built on it would be starting from an OPEN state and
/// proving nothing.
fn live_closed() -> Fixture {
    let mut f = live();
    expect_ok(set_redemptions_enabled(&mut f, false), "fixture: close redemptions");
    let admin = f.admin.insecure_clone();
    let close_mint = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: ix_data("set_public_mint_enabled", &[0]),
    };
    expect_ok(f.send(&[close_mint], &[&admin]), "fixture: close the public mint");
    let c = f.config();
    assert!(!c.redemptions_enabled, "fixture: redemptions did not close");
    assert!(!c.public_mint_enabled, "fixture: the public mint did not close");
    f
}

fn warp_past_the_window(f: &mut Fixture) {
    let secs = f.config().admin_timelock_seconds as i64;
    f.warp(secs + 1);
}

/// The four throttles are still at their launch values and the redeem switch is still CLOSED.
/// Every caller starts from `live_closed()`, so an open switch here means a proposal that was
/// refused, pending or disarmed applied itself anyway.
fn assert_throttles_untouched(f: &Fixture, what: &str) {
    let c = f.config();
    assert_eq!(
        c.instant_redeem_budget_usdc, DEFAULT_INSTANT_REDEEM_BUDGET_USDC,
        "{what}: instant_redeem_budget_usdc moved"
    );
    assert_eq!(
        c.instant_redeem_window_seconds, DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS,
        "{what}: instant_redeem_window_seconds moved"
    );
    assert_eq!(
        c.large_redeem_threshold_usdc, DEFAULT_LARGE_REDEEM_THRESHOLD_USDC,
        "{what}: large_redeem_threshold_usdc moved"
    );
    assert_eq!(
        c.redeem_queue_delay_seconds, DEFAULT_REDEEM_QUEUE_DELAY_SECONDS,
        "{what}: redeem_queue_delay_seconds moved"
    );
    assert!(!c.redemptions_enabled, "{what}: redemptions were opened");
}

/// Nothing was queued: no timelock account, no armed slot, no consumed nonce.
fn assert_nothing_queued(f: &Fixture, nonce: u64, what: &str) {
    let c = f.config();
    assert!(
        read_timelock(f, nonce).is_none(),
        "{what}: a timelock account was created"
    );
    assert_eq!(c.next_timelock_nonce, nonce, "{what}: a nonce was consumed");
    assert_eq!(
        c.active_proposal_count, 0,
        "{what}: active_proposal_count moved"
    );
}

// ---------------------------------------------------------------- execute_set_redeem_limits

#[test]
fn execute_set_redeem_limits_writes_every_field_including_the_redeem_switch() {
    // The only path that can OPEN redemptions. Proves the write reaches the account: the values are
    // read back from the VM, and each is at its fat-finger ceiling so the bounds are inclusive.
    let mut f = live_closed();
    let l = Limits {
        budget: Some(INSTANT_BUDGET_CEILING_USDC),
        window: Some(INSTANT_WINDOW_MAX_SECONDS),
        threshold: Some(9_000_000_000),
        delay: Some(REDEEM_QUEUE_DELAY_MAX_SECONDS),
        enabled: Some(true),
    };
    let (r, nonce) = propose_limits(&mut f, l);
    expect_ok(r, "propose_set_redeem_limits");
    let c = f.config();
    assert_eq!(c.pending_redeem_limits_nonce, Some(nonce), "slot not armed");
    assert_eq!(c.active_proposal_count, 1, "active_proposal_count");
    assert_throttles_untouched(&f, "before the window elapses");

    warp_past_the_window(&mut f);
    expect_ok(
        execute(&mut f, "execute_set_redeem_limits", nonce),
        "execute_set_redeem_limits",
    );

    let c = f.config();
    assert_eq!(
        c.instant_redeem_budget_usdc, INSTANT_BUDGET_CEILING_USDC,
        "instant_redeem_budget_usdc"
    );
    assert_eq!(
        c.instant_redeem_window_seconds, INSTANT_WINDOW_MAX_SECONDS,
        "instant_redeem_window_seconds"
    );
    assert_eq!(
        c.large_redeem_threshold_usdc, 9_000_000_000,
        "large_redeem_threshold_usdc"
    );
    assert_eq!(
        c.redeem_queue_delay_seconds, REDEEM_QUEUE_DELAY_MAX_SECONDS,
        "redeem_queue_delay_seconds"
    );
    assert!(
        c.redemptions_enabled,
        "the redeem switch did not open: the execute handler reported success and applied nothing"
    );
    assert_eq!(c.pending_redeem_limits_nonce, None, "slot not disarmed");
    assert_eq!(c.active_proposal_count, 0, "active_proposal_count");
    assert!(
        read_timelock(&f, nonce).is_none(),
        "the timelock account survived execute"
    );
}

#[test]
fn execute_set_redeem_limits_refuses_a_non_admin_executor() {
    // A matured loosening must not be triggerable by a third party.
    let mut f = live_closed();
    let l = Limits {
        enabled: Some(true),
        ..Default::default()
    };
    let (r, nonce) = propose_limits(&mut f, l);
    expect_ok(r, "propose_set_redeem_limits");
    warp_past_the_window(&mut f);

    let stranger = f.stranger.insecure_clone();
    expect_error(
        execute_as(&mut f, &stranger, "execute_set_redeem_limits", nonce),
        E_CONSTRAINT_HAS_ONE,
        "execute_set_redeem_limits signed by a stranger",
    );
    assert_throttles_untouched(&f, "after the stranger's execute");
    assert_eq!(
        f.config().pending_redeem_limits_nonce,
        Some(nonce),
        "the slot was disarmed by the refused execute"
    );
    assert!(
        read_timelock(&f, nonce).is_some(),
        "the refused execute closed the timelock account"
    );

    expect_ok(
        execute(&mut f, "execute_set_redeem_limits", nonce),
        "the admin's own execute",
    );
    assert!(f.config().redemptions_enabled, "the admin's execute applied nothing");
}

#[test]
fn execute_set_redeem_limits_refuses_to_land_while_paused() {
    // A queued open must not sit armed through an incident and take effect the moment somebody
    // unpauses, which is exactly when nobody is re-evaluating it.
    let mut f = live_closed();
    let l = Limits {
        enabled: Some(true),
        ..Default::default()
    };
    let (r, nonce) = propose_limits(&mut f, l);
    expect_ok(r, "propose_set_redeem_limits");
    warp_past_the_window(&mut f);
    expect_ok(pause(&mut f), "pause");

    expect_error(
        execute(&mut f, "execute_set_redeem_limits", nonce),
        E_PAUSED,
        "execute_set_redeem_limits while paused",
    );
    assert_throttles_untouched(&f, "after the paused execute");
    assert_eq!(
        f.config().pending_redeem_limits_nonce,
        Some(nonce),
        "the slot was disarmed by the refused execute"
    );

    expect_ok(unpause(&mut f), "unpause");
    expect_ok(
        execute(&mut f, "execute_set_redeem_limits", nonce),
        "execute after unpausing",
    );
    assert!(f.config().redemptions_enabled, "the execute applied nothing");
}

#[test]
fn a_disarmed_redeem_limits_proposal_can_no_longer_be_executed() {
    // The A7 bind. `set_redemptions_enabled(false)` clears `pending_redeem_limits_nonce` but leaves
    // the timelock account alive; without the bind the disarm is decorative and the proposal lands.
    let mut f = live_closed();
    let (r, open_nonce) = propose_limits(
        &mut f,
        Limits {
            enabled: Some(true),
            ..Default::default()
        },
    );
    expect_ok(r, "propose the open");
    warp_past_the_window(&mut f);
    expect_ok(
        execute(&mut f, "execute_set_redeem_limits", open_nonce),
        "execute the open",
    );
    assert!(f.config().redemptions_enabled, "redemptions did not open");

    let (r, nonce) = propose_limits(
        &mut f,
        Limits {
            budget: Some(DEFAULT_INSTANT_REDEEM_BUDGET_USDC * 3),
            ..Default::default()
        },
    );
    expect_ok(r, "propose the budget raise");
    assert_eq!(
        f.config().pending_redeem_limits_nonce,
        Some(nonce),
        "the raise did not arm the slot"
    );

    expect_ok(set_redemptions_enabled(&mut f, false), "instant redemptions close");
    let c = f.config();
    assert!(!c.redemptions_enabled, "the instant close did not shut redemptions");
    assert_eq!(
        c.pending_redeem_limits_nonce, None,
        "the instant close did not disarm the pending raise"
    );
    assert!(
        read_timelock(&f, nonce).is_some(),
        "the instant close closed the timelock account, so the bind is not what is under test"
    );

    warp_past_the_window(&mut f);
    expect_error(
        execute(&mut f, "execute_set_redeem_limits", nonce),
        E_NONCE_MISMATCH,
        "executing a disarmed proposal",
    );
    assert_eq!(
        f.config().instant_redeem_budget_usdc,
        DEFAULT_INSTANT_REDEEM_BUDGET_USDC,
        "the disarmed proposal applied its budget raise anyway"
    );
}

// ---------------------------------------------------------------- redeem-limit fat-finger rails

#[test]
fn propose_set_redeem_limits_refuses_every_value_past_its_fat_finger_rail() {
    // The propose-side half of the ceilings. Each case pins its own code, and each is followed by a
    // read of the config: a rejected proposal must leave no armed slot and no consumed nonce.
    let mut f = live_closed();
    let live_window = Some(DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS / 2);
    let cases: [(Limits, u32, &str); 5] = [
        (
            Limits {
                budget: Some(INSTANT_BUDGET_CEILING_USDC + 1),
                ..Default::default()
            },
            E_ABOVE_MAXIMUM,
            "budget one atom over the ceiling",
        ),
        (
            Limits {
                window: Some(INSTANT_WINDOW_MIN_SECONDS - 1),
                ..Default::default()
            },
            E_ABOVE_MAXIMUM,
            "window one second under the floor",
        ),
        (
            Limits {
                window: Some(INSTANT_WINDOW_MAX_SECONDS + 1),
                ..Default::default()
            },
            E_ABOVE_MAXIMUM,
            "window one second over the ceiling",
        ),
        (
            Limits {
                window: live_window,
                delay: Some(REDEEM_QUEUE_DELAY_MIN_SECONDS - 1),
                ..Default::default()
            },
            E_QUEUE_DELAY_TOO_SHORT,
            "queue delay one second under the floor",
        ),
        (
            Limits {
                window: live_window,
                delay: Some(REDEEM_QUEUE_DELAY_MAX_SECONDS + 1),
                ..Default::default()
            },
            E_ABOVE_MAXIMUM,
            "queue delay one second over the ceiling",
        ),
    ];
    for (l, code, what) in cases {
        let (r, nonce) = propose_limits(&mut f, l);
        expect_error(r, code, what);
        assert_nothing_queued(&f, nonce, what);
        assert_throttles_untouched(&f, what);
    }
}

#[test]
fn execute_set_redeem_limits_re_validates_the_rails_on_a_tampered_payload() {
    // The execute-side half of the same ceilings. The propose handler pre-validates, so the only way
    // to reach this re-validation is a payload that changed after it was queued.
    let mut f = live_closed();
    let (r, nonce) = propose_limits(
        &mut f,
        Limits {
            budget: Some(DEFAULT_INSTANT_REDEEM_BUDGET_USDC * 2),
            ..Default::default()
        },
    );
    expect_ok(r, "propose_set_redeem_limits");
    overwrite_action_data(
        &mut f,
        nonce,
        Limits {
            budget: Some(INSTANT_BUDGET_CEILING_USDC + 1),
            ..Default::default()
        }
        .encode(),
    );
    warp_past_the_window(&mut f);

    expect_error(
        execute(&mut f, "execute_set_redeem_limits", nonce),
        E_ABOVE_MAXIMUM,
        "executing a payload rewritten past the budget ceiling",
    );
    assert_throttles_untouched(&f, "after the tampered execute");
    assert_eq!(
        f.config().pending_redeem_limits_nonce,
        Some(nonce),
        "the refused execute disarmed the slot"
    );
}

// ---------------------------------------------------------------- admin timelock bounds

#[test]
fn propose_set_admin_timelock_refuses_a_delay_outside_its_bounds() {
    // Below the floor every governance action becomes near-instant after one window; the exact
    // ceiling must still be accepted and must reach the account.
    let mut f = live();
    let base = f.config().admin_timelock_seconds;

    let (r, nonce) = propose(&mut f, "propose_set_admin_timelock", &(base - 1).to_le_bytes());
    expect_error(r, E_TIMELOCK_TOO_SHORT, "one second under the floor");
    assert_nothing_queued(&f, nonce, "one second under the floor");

    let (r, nonce) = propose(
        &mut f,
        "propose_set_admin_timelock",
        &(ADMIN_TIMELOCK_MAX_SECONDS + 1).to_le_bytes(),
    );
    expect_error(r, E_TIMELOCK_TOO_LONG, "one second over the ceiling");
    assert_nothing_queued(&f, nonce, "one second over the ceiling");
    assert_eq!(
        f.config().admin_timelock_seconds,
        base,
        "a refused proposal moved the delay"
    );

    let (r, nonce) = propose(
        &mut f,
        "propose_set_admin_timelock",
        &ADMIN_TIMELOCK_MAX_SECONDS.to_le_bytes(),
    );
    expect_ok(r, "propose the exact ceiling");
    warp_past_the_window(&mut f);
    expect_ok(
        execute(&mut f, "execute_set_admin_timelock", nonce),
        "execute_set_admin_timelock",
    );
    let c = f.config();
    assert_eq!(
        c.admin_timelock_seconds, ADMIN_TIMELOCK_MAX_SECONDS,
        "the new delay did not reach the account"
    );
    assert_eq!(c.pending_admin_timelock_nonce, None, "slot not disarmed");
}

#[test]
fn execute_set_admin_timelock_re_validates_the_bounds_on_a_tampered_payload() {
    // The execute-side half. Reachable only through a payload rewritten after it was queued.
    let mut f = live();
    let (r, nonce) = propose(
        &mut f,
        "propose_set_admin_timelock",
        &ADMIN_TIMELOCK_MAX_SECONDS.to_le_bytes(),
    );
    expect_ok(r, "propose_set_admin_timelock");
    overwrite_action_data(&mut f, nonce, 1u32.to_le_bytes().to_vec());
    warp_past_the_window(&mut f);

    expect_error(
        execute(&mut f, "execute_set_admin_timelock", nonce),
        E_TIMELOCK_TOO_SHORT,
        "executing a payload rewritten to a one-second delay",
    );
    assert_eq!(
        f.config().admin_timelock_seconds,
        ADMIN_TIMELOCK_SECONDS,
        "the tampered delay reached the account"
    );
}

// ---------------------------------------------------------------- treasury float ceiling

#[test]
fn propose_set_treasury_min_float_refuses_a_float_over_the_ceiling() {
    // u64::MAX here strands every USDC the treasury holds; the exact ceiling must still land.
    let mut f = live();
    let (r, nonce) = propose(
        &mut f,
        "propose_set_treasury_min_float",
        &u64::MAX.to_le_bytes(),
    );
    expect_error(r, E_ABOVE_MAXIMUM, "a float of u64::MAX");
    assert_nothing_queued(&f, nonce, "a float of u64::MAX");

    let (r, nonce) = propose(
        &mut f,
        "propose_set_treasury_min_float",
        &(TREASURY_FLOAT_CEILING_USDC + 1).to_le_bytes(),
    );
    expect_error(r, E_ABOVE_MAXIMUM, "one atom over the ceiling");
    assert_nothing_queued(&f, nonce, "one atom over the ceiling");
    assert_eq!(
        f.config().treasury_min_float_usdc,
        0,
        "a refused proposal moved the float"
    );

    let (r, nonce) = propose(
        &mut f,
        "propose_set_treasury_min_float",
        &TREASURY_FLOAT_CEILING_USDC.to_le_bytes(),
    );
    expect_ok(r, "propose the exact ceiling");
    warp_past_the_window(&mut f);
    expect_ok(
        execute(&mut f, "execute_set_treasury_min_float", nonce),
        "execute_set_treasury_min_float",
    );
    let c = f.config();
    assert_eq!(
        c.treasury_min_float_usdc, TREASURY_FLOAT_CEILING_USDC,
        "the new float did not reach the account"
    );
    assert_eq!(c.pending_treasury_float_nonce, None, "slot not disarmed");
}

#[test]
fn execute_set_treasury_min_float_re_validates_the_ceiling_on_a_tampered_payload() {
    // The execute-side half. Reachable only through a payload rewritten after it was queued.
    let mut f = live();
    let (r, nonce) = propose(
        &mut f,
        "propose_set_treasury_min_float",
        &TREASURY_FLOAT_CEILING_USDC.to_le_bytes(),
    );
    expect_ok(r, "propose_set_treasury_min_float");
    overwrite_action_data(&mut f, nonce, u64::MAX.to_le_bytes().to_vec());
    warp_past_the_window(&mut f);

    expect_error(
        execute(&mut f, "execute_set_treasury_min_float", nonce),
        E_ABOVE_MAXIMUM,
        "executing a payload rewritten to u64::MAX",
    );
    assert_eq!(
        f.config().treasury_min_float_usdc,
        0,
        "the tampered float reached the account"
    );
}

// ---------------------------------------------------------------- execute_set_public_mint

#[test]
fn execute_set_public_mint_disarms_the_slot_it_consumed() {
    // The single-active slot must be freed, else the public mint can never be changed again: propose
    // refuses while `pending_public_mint_nonce` is Some.
    let mut f = live_closed();
    let (r, nonce) = propose(&mut f, "propose_set_public_mint", &[1]);
    expect_ok(r, "propose_set_public_mint");
    assert_eq!(
        f.config().pending_public_mint_nonce,
        Some(nonce),
        "slot not armed"
    );

    warp_past_the_window(&mut f);
    expect_ok(
        execute(&mut f, "execute_set_public_mint", nonce),
        "execute_set_public_mint",
    );
    let c = f.config();
    assert!(c.public_mint_enabled, "the public mint did not open");
    assert_eq!(
        c.pending_public_mint_nonce, None,
        "the consumed proposal still occupies the single-active slot"
    );
    assert_eq!(c.active_proposal_count, 0, "active_proposal_count");
}

#[test]
fn execute_set_public_mint_refuses_a_non_admin_executor() {
    // Opening the public mint wakes the oracle path; a third party must not choose when.
    let mut f = live_closed();
    let (r, nonce) = propose(&mut f, "propose_set_public_mint", &[1]);
    expect_ok(r, "propose_set_public_mint");
    warp_past_the_window(&mut f);

    let stranger = f.stranger.insecure_clone();
    expect_error(
        execute_as(&mut f, &stranger, "execute_set_public_mint", nonce),
        E_CONSTRAINT_HAS_ONE,
        "execute_set_public_mint signed by a stranger",
    );
    let c = f.config();
    assert!(!c.public_mint_enabled, "a stranger opened the public mint");
    assert_eq!(
        c.pending_public_mint_nonce,
        Some(nonce),
        "the refused execute disarmed the slot"
    );

    expect_ok(
        execute(&mut f, "execute_set_public_mint", nonce),
        "the admin's own execute",
    );
    assert!(f.config().public_mint_enabled, "the admin's execute applied nothing");
}

#[test]
fn execute_set_public_mint_refuses_to_land_while_paused() {
    // A matured open must not land mid-incident and wake the oracle path the instant somebody
    // unpauses.
    let mut f = live_closed();
    let (r, nonce) = propose(&mut f, "propose_set_public_mint", &[1]);
    expect_ok(r, "propose_set_public_mint");
    warp_past_the_window(&mut f);
    expect_ok(pause(&mut f), "pause");

    expect_error(
        execute(&mut f, "execute_set_public_mint", nonce),
        E_PAUSED,
        "execute_set_public_mint while paused",
    );
    let c = f.config();
    assert!(!c.public_mint_enabled, "the mint opened while paused");
    assert_eq!(
        c.pending_public_mint_nonce,
        Some(nonce),
        "the refused execute disarmed the slot"
    );

    expect_ok(unpause(&mut f), "unpause");
    expect_ok(
        execute(&mut f, "execute_set_public_mint", nonce),
        "execute after unpausing",
    );
    assert!(f.config().public_mint_enabled, "the execute applied nothing");
}

// ====================================================== the minimum-operation floor: the mint availability floor

/// `set_min_operation_usdc`, the instant setter. Same `SetParam` shape as the two switches above.
fn set_min_operation(f: &mut Fixture, new_min: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: ix_data("set_min_operation_usdc", &new_min.to_le_bytes()),
    };
    f.send(&[ix], &[&admin])
}

#[test]
fn the_dust_mint_that_captured_a_lazer_print_is_now_refused() {
    // THE PROPERTY, driven against the real bytes. 60 micro-USDC was the smallest
    // amount that minted a non-zero SILV at $58.34/oz, so it was the whole cost of taking the single
    // global high-water slot D2 created. The floor must stop it.
    let mut f = live();
    f.open_public_mint();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);

    expect_error(
        f.try_mint_amount(&holder, false, 60),
        E_OPERATION_BELOW_MINIMUM,
        "a 60 micro-USDC mint",
    );
}

#[test]
fn the_mint_floor_is_checked_before_the_oracle_read_so_a_refused_call_pays_no_verify_fee() {
    // ORDERING. The fixture's Lazer program account is deliberately NOT executable, so any call that
    // reaches step 4 dies with LazerProgramNotExecutable. A dust call must die BEFORE that with
    // OperationBelowMinimum, and a call at the floor must reach it.
    // What this proves is a COMPUTE and FEE property, not a safety one: a reverted transaction rolls
    // back the Lazer fee and the high-water write wherever the check sits. It is still worth pinning,
    // because moving the check below the CPI would make every refused dust call pay a verify fee, and
    // a placement-agnostic test of "dust is refused" would not notice.
    let mut f = live();
    f.open_public_mint();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);

    expect_error(
        f.try_mint_amount(&holder, false, DEFAULT_MIN_OPERATION_USDC - 1),
        E_OPERATION_BELOW_MINIMUM,
        "one micro-USDC under the floor stops before the oracle",
    );
    expect_error(
        f.try_mint_amount(&holder, false, DEFAULT_MIN_OPERATION_USDC),
        E_LAZER_PROGRAM_NOT_EXECUTABLE,
        "exactly at the floor, the call proceeds to the oracle read",
    );
}

#[test]
fn the_floor_the_ceremony_ships_is_the_one_the_program_enforces() {
    // A default that initialize writes but no handler reads would be a comment, not a control. This
    // is the link between the two, measured off the chain rather than asserted from the constant.
    let f = live();
    assert_eq!(
        f.config().min_operation_usdc,
        DEFAULT_MIN_OPERATION_USDC,
        "initialize did not arm the floor"
    );
}

#[test]
fn raising_the_floor_takes_effect_on_the_next_mint() {
    // The setter is instant in both directions, so the only proof that matters is that a mint which
    // succeeded at the old value is refused at the new one, read back off the chain.
    let mut f = live();
    f.open_public_mint();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);

    // At the launch floor this amount clears step 3b and dies at the oracle.
    expect_error(
        f.try_mint_amount(&holder, false, DEFAULT_MIN_OPERATION_USDC),
        E_LAZER_PROGRAM_NOT_EXECUTABLE,
        "before the raise",
    );
    expect_ok(
        set_min_operation(&mut f, DEFAULT_MIN_OPERATION_USDC * 10),
        "set_min_operation_usdc: raise",
    );
    assert_eq!(
        f.config().min_operation_usdc,
        DEFAULT_MIN_OPERATION_USDC * 10,
        "the raise did not persist"
    );
    expect_error(
        f.try_mint_amount(&holder, false, DEFAULT_MIN_OPERATION_USDC),
        E_OPERATION_BELOW_MINIMUM,
        "after the raise, the same amount is under the floor",
    );
}

#[test]
fn lowering_the_floor_to_zero_disables_it() {
    // Zero is a legal state and it must MEAN no floor: it is what an in-place upgrade of an existing
    // config decodes out of `reserved`, so a program that treated zero as "reject everything" would
    // brick every deployed instance on upgrade.
    let mut f = live();
    f.open_public_mint();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);

    expect_ok(set_min_operation(&mut f, 0), "set_min_operation_usdc: zero");
    assert_eq!(f.config().min_operation_usdc, 0, "the write did not persist");
    expect_error(
        f.try_mint_amount(&holder, false, 60),
        E_LAZER_PROGRAM_NOT_EXECUTABLE,
        "with the floor disabled a dust mint reaches the oracle again",
    );
}

#[test]
fn the_setter_refuses_a_value_above_its_ceiling() {
    let mut f = live();
    expect_error(
        set_min_operation(&mut f, MIN_OPERATION_CEILING_USDC + 1),
        E_MIN_OPERATION_TOO_HIGH,
        "one over the ceiling",
    );
    expect_ok(
        set_min_operation(&mut f, MIN_OPERATION_CEILING_USDC),
        "exactly at the ceiling",
    );
    assert_eq!(
        f.config().min_operation_usdc,
        MIN_OPERATION_CEILING_USDC,
        "the boundary value did not persist"
    );
}

#[test]
fn the_setter_refuses_a_no_op_and_a_non_admin() {
    let mut f = live();
    expect_error(
        set_min_operation(&mut f, DEFAULT_MIN_OPERATION_USDC),
        E_MIN_OPERATION_UNCHANGED,
        "writing the value already stored",
    );

    // has_one = admin. A liveness knob a stranger can turn is a liveness knob an attacker can turn.
    let stranger = f.stranger.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(stranger.pubkey(), true),
        ],
        data: ix_data("set_min_operation_usdc", &1_000_000u64.to_le_bytes()),
    };
    expect_error(
        f.send(&[ix], &[&stranger]),
        E_CONSTRAINT_HAS_ONE,
        "a stranger setting the mint floor",
    );
    assert_eq!(
        f.config().min_operation_usdc,
        DEFAULT_MIN_OPERATION_USDC,
        "the refused calls moved the floor anyway"
    );
}
