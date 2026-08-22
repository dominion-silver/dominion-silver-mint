// On-chain tests for the INSTANT admin powers in instructions/admin/caps.rs, plus the proposal-budget
// guard in propose.rs. Every case reads the config back out of the VM after a real transaction: the
// tighten-fast / loosen-slow asymmetry is a property of what the account holds afterwards, and a
// handler that emits its success event while Anchor discards the write looks identical from outside.

mod common;

use common::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- codes and constants

const E_ABOVE_MAXIMUM: u32 = 12003;
const E_WRONG_MINT: u32 = 12026;
const E_PROPOSAL_NO_OP: u32 = 12043;
const E_TOO_MANY_ACTIVE_PROPOSALS: u32 = 12045;
const E_SUPPLY_CAP_RAISE_BLOCKED: u32 = 12084;
const E_REDEMPTIONS_ENABLE_BLOCKED: u32 = 12088;
const E_LOOSENING_REQUIRES_TIMELOCK: u32 = 12090;
const E_REDEEM_LIMITS_ALL_NONE: u32 = 12091;
const E_SUPPLY_CAP_BELOW_SUPPLY: u32 = 12098;
const E_PUBLIC_MINT_UNCHANGED: u32 = 12101;
const E_TIMELOCK_NOT_ELAPSED: u32 = 12028;
const E_PUBLIC_MINT_OPEN_REQUIRES_TIMELOCK: u32 = 12102;

const DEFAULT_MAX_SILV_SUPPLY: u64 = 150_000_000_000;
const MAX_SILV_SUPPLY_CEILING: u64 = 1_000_000_000_000_000;
const DEFAULT_INSTANT_REDEEM_BUDGET_USDC: u64 = 20_000_000_000;
const DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS: u32 = 86_400;
const DEFAULT_LARGE_REDEEM_THRESHOLD_USDC: u64 = 5_000_000_000;
const DEFAULT_REDEEM_QUEUE_DELAY_SECONDS: u32 = 259_200;
const INSTANT_WINDOW_MAX_SECONDS: u32 = 604_800;
const MAX_ACTIVE_PROPOSALS: u8 = 10;

// ---------------------------------------------------------------- RedeemLimitsArgs

/// Mirror of `execute::RedeemLimitsArgs`, in declaration order. Borsh encodes `Option<T>` as a 1-byte
/// tag then the payload, so the wire form is written out by hand rather than pulled from the program.
#[derive(Clone, Default)]
struct Limits {
    budget: Option<u64>,
    window: Option<u32>,
    threshold: Option<u64>,
    queue_delay: Option<u32>,
    enabled: Option<bool>,
}

impl Limits {
    fn budget(v: u64) -> Self {
        Limits {
            budget: Some(v),
            ..Default::default()
        }
    }
    fn window(v: u32) -> Self {
        Limits {
            window: Some(v),
            ..Default::default()
        }
    }
    fn enabled(v: bool) -> Self {
        Limits {
            enabled: Some(v),
            ..Default::default()
        }
    }

    fn encode(&self) -> Vec<u8> {
        let mut d = Vec::new();
        push_opt(&mut d, self.budget.map(|v| v.to_le_bytes().to_vec()));
        push_opt(&mut d, self.window.map(|v| v.to_le_bytes().to_vec()));
        push_opt(&mut d, self.threshold.map(|v| v.to_le_bytes().to_vec()));
        push_opt(&mut d, self.queue_delay.map(|v| v.to_le_bytes().to_vec()));
        push_opt(&mut d, self.enabled.map(|v| vec![v as u8]));
        d
    }
}

fn push_opt(d: &mut Vec<u8>, payload: Option<Vec<u8>>) {
    match payload {
        Some(bytes) => {
            d.push(1);
            d.extend_from_slice(&bytes);
        }
        None => d.push(0),
    }
}

// ---------------------------------------------------------------- instructions

fn set_max_supply_as(f: &mut Fixture, signer: &Keypair, mint: Pubkey, new_max: u64) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(mint, false),
        ],
        data: ix_data("set_max_silv_supply", &new_max.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

fn set_max_supply(f: &mut Fixture, new_max: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let mint = f.silv_mint;
    set_max_supply_as(f, &admin, mint, new_max)
}

fn set_param_as(f: &mut Fixture, signer: &Keypair, name: &str, args: &[u8]) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data(name, args),
    };
    f.send(&[ix], &[signer])
}

fn set_redemptions_enabled_as(f: &mut Fixture, signer: &Keypair, enabled: bool) -> TxOutcome {
    set_param_as(f, signer, "set_redemptions_enabled", &[enabled as u8])
}

fn set_redemptions_enabled(f: &mut Fixture, enabled: bool) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    set_redemptions_enabled_as(f, &admin, enabled)
}

fn set_public_mint_enabled_as(f: &mut Fixture, signer: &Keypair, enabled: bool) -> TxOutcome {
    set_param_as(f, signer, "set_public_mint_enabled", &[enabled as u8])
}

fn set_public_mint_enabled(f: &mut Fixture, enabled: bool) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    set_public_mint_enabled_as(f, &admin, enabled)
}

fn tighten_as(f: &mut Fixture, signer: &Keypair, args: &Limits) -> TxOutcome {
    set_param_as(f, signer, "emergency_tighten_redeem_limits", &args.encode())
}

fn tighten(f: &mut Fixture, args: &Limits) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    tighten_as(f, &admin, args)
}

fn propose_redeem_limits(f: &mut Fixture, args: &Limits) -> (TxOutcome, u64) {
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
        data: ix_data("propose_set_redeem_limits", &args.encode()),
    };
    (f.send(&[ix], &[&admin]), nonce)
}

fn execute_redeem_limits(f: &mut Fixture, nonce: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(admin.pubkey(), false),
        ],
        data: ix_data("execute_set_redeem_limits", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[&admin])
}

fn propose_premium_mint(f: &mut Fixture, bps: u16) -> (TxOutcome, u64) {
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
        data: ix_data("propose_set_premium_mint", &bps.to_le_bytes()),
    };
    (f.send(&[ix], &[&admin]), nonce)
}

// ---------------------------------------------------------------- fixture helpers

/// routed through the common helper, which installs the independent guardian that
/// `unpause` now demands.
fn unpause_once(f: &mut Fixture) {
    if !f.config().paused {
        return;
    }
    expect_ok(f.unpause(), "unpause");
}

/// Reach a CLOSED redeem state. inverted the starting point: `initialize` now leaves
/// redemptions open, so the state these tests need is one instant close away rather than one 24h
/// timelock away. The close is itself the permitted direction, so this helper asserts it landed.
fn close_redemptions(f: &mut Fixture) {
    unpause_once(f);
    expect_ok(set_redemptions_enabled(f, false), "close_redemptions");
    assert!(
        !f.config().redemptions_enabled,
        "close_redemptions left redemptions open"
    );
}


/// Patch the live SILV mint's `supply` field (bytes 36..44 of the SPL mint body). `set_max_silv_supply`
/// reads the REAL mint rather than a tracked counter, so a non-zero supply cannot be reached any other
/// way in this fixture: nothing here mints.
fn set_silv_supply(f: &mut Fixture, supply: u64) {
    let mint = f.silv_mint;
    let mut acc = f.svm.get_account(&mint).expect("the SILV mint must exist");
    acc.data[36..44].copy_from_slice(&supply.to_le_bytes());
    f.svm.set_account(mint, acc).unwrap();
}

/// Write `active_proposal_count` straight into the config. Reaching ten organically needs ten distinct
/// proposal KINDS (each has its own single-active slot), which would test ten other instructions rather
/// than the budget guard this pins.
fn force_active_proposal_count(f: &mut Fixture, n: u8) {
    let mut c = f.config();
    c.active_proposal_count = n;
    let mut acc = f.svm.get_account(&config_pda()).unwrap();
    let body = borsh::to_vec(&c).unwrap();
    acc.data[8..8 + body.len()].copy_from_slice(&body);
    f.svm.set_account(config_pda(), acc).unwrap();
    assert_eq!(
        f.config().active_proposal_count,
        n,
        "the forced active_proposal_count did not stick"
    );
}

// ---------------------------------------------------------------- set_max_silv_supply

#[test]
fn the_supply_cap_tightens_instantly_and_the_new_value_persists() {
    // The permitted direction. A cap that reads back unchanged means the write was discarded.
    let mut f = Fixture::new();
    assert_eq!(f.config().max_silv_supply, DEFAULT_MAX_SILV_SUPPLY, "launch cap");

    let lower = DEFAULT_MAX_SILV_SUPPLY - 50_000_000_000;
    expect_ok(set_max_supply(&mut f, lower), "lower the cap");
    assert_eq!(f.config().max_silv_supply, lower, "the tighten did not persist");

    // Still a one-way ratchet after the first move: no rebound to the old value.
    expect_error(
        set_max_supply(&mut f, DEFAULT_MAX_SILV_SUPPLY),
        E_SUPPLY_CAP_RAISE_BLOCKED,
        "raise back to the launch cap",
    );
    assert_eq!(f.config().max_silv_supply, lower, "the refused raise moved the cap");
}

#[test]
fn the_supply_cap_can_never_be_raised() {
    // The ratchet. One atomic unit above the current cap is still a raise.
    let mut f = Fixture::new();
    expect_error(
        set_max_supply(&mut f, DEFAULT_MAX_SILV_SUPPLY + 1),
        E_SUPPLY_CAP_RAISE_BLOCKED,
        "raise the cap by one",
    );
    assert_eq!(
        f.config().max_silv_supply,
        DEFAULT_MAX_SILV_SUPPLY,
        "a refused raise changed the cap"
    );
}

#[test]
fn the_supply_cap_may_not_fall_below_the_live_mint_supply() {
    // Lowering below what is already minted would permanently kill admin_premint, the only mint path
    // at launch, and the cap can never be raised back.
    let mut f = Fixture::new();
    set_silv_supply(&mut f, 10_000_000_000);

    expect_error(
        set_max_supply(&mut f, 10_000_000_000 - 1),
        E_SUPPLY_CAP_BELOW_SUPPLY,
        "cap one unit under the live supply",
    );
    assert_eq!(
        f.config().max_silv_supply,
        DEFAULT_MAX_SILV_SUPPLY,
        "a refused tighten changed the cap"
    );

    // The boundary the other way: exactly the live supply is allowed, so headroom can be taken to zero.
    expect_ok(set_max_supply(&mut f, 10_000_000_000), "cap at the live supply");
    assert_eq!(f.config().max_silv_supply, 10_000_000_000, "the boundary tighten did not persist");
}

#[test]
fn the_supply_cap_is_checked_against_the_ceiling_before_anything_else() {
    // An absurd value must report AboveMaximum, not the less informative SupplyCapRaiseBlocked.
    let mut f = Fixture::new();
    expect_error(
        set_max_supply(&mut f, MAX_SILV_SUPPLY_CEILING + 1),
        E_ABOVE_MAXIMUM,
        "cap above the compile-time ceiling",
    );
    assert_eq!(f.config().max_silv_supply, DEFAULT_MAX_SILV_SUPPLY, "the cap moved");
}

#[test]
fn the_live_supply_reading_cannot_be_spoofed_with_another_mint() {
    // Without the address pin on silv_mint, a decoy mint reporting supply 0 would let the cap be taken
    // under the real live supply in one transaction.
    let mut f = Fixture::new();
    set_silv_supply(&mut f, 10_000_000_000);
    let decoy = f.usdc_mint; // a real, decodable mint whose supply is 0
    let admin = f.admin.insecure_clone();

    expect_error(
        set_max_supply_as(&mut f, &admin, decoy, 1_000_000_000),
        E_WRONG_MINT,
        "set_max_silv_supply with a decoy mint",
    );
    assert_eq!(
        f.config().max_silv_supply,
        DEFAULT_MAX_SILV_SUPPLY,
        "the spoofed call moved the cap"
    );
}

#[test]
fn only_the_admin_may_tighten_the_supply_cap() {
    // Anyone able to call this could lower the cap to the live supply and stop issuance for good.
    let mut f = Fixture::new();
    let stranger = f.stranger.insecure_clone();
    let mint = f.silv_mint;

    expect_error(
        set_max_supply_as(&mut f, &stranger, mint, 1_000_000_000),
        E_CONSTRAINT_HAS_ONE,
        "set_max_silv_supply signed by a stranger",
    );
    assert_eq!(
        f.config().max_silv_supply,
        DEFAULT_MAX_SILV_SUPPLY,
        "a stranger moved the cap"
    );
}

// ---------------------------------------------------------------- set_redemptions_enabled

#[test]
fn redemptions_close_instantly_and_the_switch_persists() {
    // The tighten direction of the redeem switch, and the only proof the write survives Anchor's exit.
    // the launch state is already OPEN, so the close is one instruction from `new`.
    let mut f = Fixture::new();
    f.require_redemptions_open();

    expect_ok(set_redemptions_enabled(&mut f, false), "close redemptions");
    assert!(
        !f.config().redemptions_enabled,
        "the instant close did not persist"
    );
}

#[test]
fn redemptions_cannot_be_opened_instantly_from_either_state() {
    // Opening is the largest loosening the program has, so it is refused in bytecode whatever the
    // current state, and must ride the 24h timelock instead.
    // reversed the order of the two states, not the property: the launch state is now OPEN,
    // so the open-state case comes first and the closed-state case follows the instant close. Both
    // states are still covered, and neither needs a 24h warp to reach.
    let mut f = Fixture::new();
    f.require_redemptions_open();
    expect_error(
        set_redemptions_enabled(&mut f, true),
        E_REDEMPTIONS_ENABLE_BLOCKED,
        "open redemptions while already open",
    );
    assert!(f.config().redemptions_enabled, "the refused open flipped the switch");

    close_redemptions(&mut f);
    expect_error(
        set_redemptions_enabled(&mut f, true),
        E_REDEMPTIONS_ENABLE_BLOCKED,
        "open redemptions while closed",
    );
    assert!(!f.config().redemptions_enabled, "the refused open flipped the switch");
}

#[test]
fn closing_already_closed_redemptions_must_not_wipe_a_queued_proposal() {
    // The handler disarms pending_redeem_limits_nonce, so without the no-op guard a defensive
    // "confirm redemptions are off" click silently destroys a queued proposal and costs 24 hours.
    // the closed state is now reached by closing, not by doing nothing.
    let mut f = Fixture::new();
    close_redemptions(&mut f);
    let (r, nonce) = propose_redeem_limits(&mut f, &Limits::enabled(true));
    expect_ok(r, "queue an open");
    assert_eq!(f.config().pending_redeem_limits_nonce, Some(nonce), "propose did not arm the slot");

    expect_error(
        set_redemptions_enabled(&mut f, false),
        E_PROPOSAL_NO_OP,
        "close redemptions that are already closed",
    );
    let c = f.config();
    assert_eq!(
        c.pending_redeem_limits_nonce,
        Some(nonce),
        "the refused no-op disarmed the queued proposal"
    );
    assert_eq!(c.active_proposal_count, 1, "the refused no-op released a proposal slot");
}

#[test]
fn an_instant_close_disarms_a_queued_open() {
    // The tighten direction must also revoke the announced open, or it lands hours later with no
    // fresh decision.
    let mut f = Fixture::new();
    f.require_redemptions_open();
    let (r, nonce) = propose_redeem_limits(&mut f, &Limits::budget(DEFAULT_INSTANT_REDEEM_BUDGET_USDC * 2));
    expect_ok(r, "queue a loosening");
    assert_eq!(f.config().pending_redeem_limits_nonce, Some(nonce), "propose did not arm the slot");

    expect_ok(set_redemptions_enabled(&mut f, false), "close redemptions");
    let c = f.config();
    assert!(!c.redemptions_enabled, "the close did not persist");
    assert_eq!(c.pending_redeem_limits_nonce, None, "the close left the queued proposal armed");
}

#[test]
fn a_closed_redeem_switch_can_only_be_reopened_through_the_24h_timelock() {
    // The launch posture flipped the STARTING state, not the asymmetry, and this is the
    // test that says so out loud: from the state an operator actually reaches after an incident
    // close, the only way back is propose, wait the full delay, execute. Both instant lanes are
    // proved shut from that same state, and the early execute is proved shut at the boundary.
    let mut f = Fixture::new();
    close_redemptions(&mut f);

    expect_error(
        set_redemptions_enabled(&mut f, true),
        E_REDEMPTIONS_ENABLE_BLOCKED,
        "reopening through the direct setter",
    );
    expect_error(
        tighten(&mut f, &Limits::enabled(true)),
        E_LOOSENING_REQUIRES_TIMELOCK,
        "reopening through the emergency lane",
    );
    assert!(!f.config().redemptions_enabled, "a refused reopen opened redemptions");

    let (r, nonce) = propose_redeem_limits(&mut f, &Limits::enabled(true));
    expect_ok(r, "propose the reopen");
    assert!(
        !f.config().redemptions_enabled,
        "proposing the reopen opened redemptions immediately, so there is no veto window"
    );

    // One second short of the delay. The boundary is the property, not the ballpark.
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 - 1);
    expect_error(
        execute_redeem_limits(&mut f, nonce),
        E_TIMELOCK_NOT_ELAPSED,
        "executing the reopen one second early",
    );
    assert!(!f.config().redemptions_enabled, "the early execute reopened redemptions");

    f.warp(2);
    expect_ok(execute_redeem_limits(&mut f, nonce), "execute the reopen");
    assert!(
        f.config().redemptions_enabled,
        "the matured execute reported success and applied nothing"
    );
}

#[test]
fn only_the_admin_may_move_the_redeem_switch() {
    let mut f = Fixture::new();
    f.require_redemptions_open();
    let stranger = f.stranger.insecure_clone();

    expect_error(
        set_redemptions_enabled_as(&mut f, &stranger, false),
        E_CONSTRAINT_HAS_ONE,
        "set_redemptions_enabled signed by a stranger",
    );
    assert!(
        f.config().redemptions_enabled,
        "a stranger closed redemptions"
    );
}

// ---------------------------------------------------------------- set_public_mint_enabled

#[test]
fn the_public_mint_closes_instantly_and_the_switch_persists() {
    // The emergency direction: a misbehaving feed must be answerable in one transaction.
    let mut f = Fixture::new();
    f.open_public_mint();

    expect_ok(set_public_mint_enabled(&mut f, false), "close the public mint");
    let c = f.config();
    assert!(!c.public_mint_enabled, "the instant close did not persist");
    assert_eq!(c.pending_public_mint_nonce, None, "the close left an open armed");
}

#[test]
fn the_public_mint_cannot_be_opened_instantly_from_either_state() {
    // Opening wakes the oracle path and lets the public consume the cap headroom, so it must be
    // announced and guardian-cancellable. The direction check runs before the no-op check.
    // the launch state is now OPEN, so the two states are visited in the other order. The
    // closed state is reached by the instant close, which is the permitted direction.
    let mut f = Fixture::new();
    assert!(f.config().public_mint_enabled, "the launch state is open");
    expect_error(
        set_public_mint_enabled(&mut f, true),
        E_PUBLIC_MINT_OPEN_REQUIRES_TIMELOCK,
        "open the public mint while already open",
    );
    assert!(f.config().public_mint_enabled, "the refused open closed the mint");

    expect_ok(set_public_mint_enabled(&mut f, false), "close the public mint");
    expect_error(
        set_public_mint_enabled(&mut f, true),
        E_PUBLIC_MINT_OPEN_REQUIRES_TIMELOCK,
        "open the public mint while closed",
    );
    assert!(!f.config().public_mint_enabled, "the refused open flipped the switch");
}

#[test]
fn closing_an_already_closed_public_mint_is_refused_as_a_no_op() {
    // the first close is now a real change, so the no-op under test is the SECOND one.
    let mut f = Fixture::new();
    expect_ok(set_public_mint_enabled(&mut f, false), "close the public mint");
    expect_error(
        set_public_mint_enabled(&mut f, false),
        E_PUBLIC_MINT_UNCHANGED,
        "close a public mint that is already closed",
    );
    assert!(!f.config().public_mint_enabled, "the refused no-op flipped the switch");
}

#[test]
fn only_the_admin_may_close_the_public_mint() {
    let mut f = Fixture::new();
    f.open_public_mint();
    let stranger = f.stranger.insecure_clone();

    expect_error(
        set_public_mint_enabled_as(&mut f, &stranger, false),
        E_CONSTRAINT_HAS_ONE,
        "set_public_mint_enabled signed by a stranger",
    );
    assert!(f.config().public_mint_enabled, "a stranger closed the public mint");
}

// ---------------------------------------------------------------- emergency_tighten_redeem_limits

#[test]
fn the_emergency_lane_applies_every_tightening_field_on_chain() {
    // The instant fast lane, in its permitted direction: budget down, window up, threshold down,
    // queue delay up. A no-op that emits RedeemLimitsTightened is the failure this pins.
    let mut f = Fixture::new();
    let args = Limits {
        budget: Some(DEFAULT_INSTANT_REDEEM_BUDGET_USDC / 2),
        window: Some(DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS * 2),
        threshold: Some(DEFAULT_LARGE_REDEEM_THRESHOLD_USDC / 2),
        queue_delay: Some(DEFAULT_REDEEM_QUEUE_DELAY_SECONDS * 2),
        enabled: None,
    };
    expect_ok(tighten(&mut f, &args), "tighten all four throttles");

    let c = f.config();
    assert_eq!(c.instant_redeem_budget_usdc, DEFAULT_INSTANT_REDEEM_BUDGET_USDC / 2, "budget");
    assert_eq!(c.instant_redeem_window_seconds, DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS * 2, "window");
    assert_eq!(c.large_redeem_threshold_usdc, DEFAULT_LARGE_REDEEM_THRESHOLD_USDC / 2, "threshold");
    assert_eq!(c.redeem_queue_delay_seconds, DEFAULT_REDEEM_QUEUE_DELAY_SECONDS * 2, "queue delay");
}

#[test]
fn the_emergency_lane_refuses_a_budget_raise() {
    // Raising the instant budget is the one-block drain the whole asymmetry exists to prevent.
    let mut f = Fixture::new();
    expect_error(
        tighten(&mut f, &Limits::budget(DEFAULT_INSTANT_REDEEM_BUDGET_USDC + 1)),
        E_LOOSENING_REQUIRES_TIMELOCK,
        "raise the instant budget instantly",
    );
    assert_eq!(
        f.config().instant_redeem_budget_usdc,
        DEFAULT_INSTANT_REDEEM_BUDGET_USDC,
        "a refused loosening moved the budget"
    );
}

#[test]
fn the_emergency_lane_refuses_a_window_shrink() {
    // A shorter window raises the sustained drain rate and can early-reset a near-exhausted budget,
    // so shrinking it is a LOOSENING despite the smaller number.
    let mut f = Fixture::new();
    expect_error(
        tighten(&mut f, &Limits::window(DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS - 1)),
        E_LOOSENING_REQUIRES_TIMELOCK,
        "shrink the instant window instantly",
    );
    assert_eq!(
        f.config().instant_redeem_window_seconds,
        DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS,
        "a refused loosening moved the window"
    );
}

#[test]
fn the_emergency_lane_refuses_to_open_redemptions() {
    // The redeem switch rides RedeemLimitsArgs, so the instant lane must reject Some(true) or it
    // becomes a second, undelayed way to open the only path that pays out treasury cash.
    // the request has to be a real open to mean anything, so redemptions are closed first.
    let mut f = Fixture::new();
    close_redemptions(&mut f);
    expect_error(
        tighten(&mut f, &Limits::enabled(true)),
        E_LOOSENING_REQUIRES_TIMELOCK,
        "open redemptions through the emergency lane",
    );
    assert!(
        !f.config().redemptions_enabled,
        "the emergency lane opened redemptions"
    );
}

#[test]
fn the_emergency_lane_actually_closes_redemptions_and_disarms_a_queued_open() {
    // The apply arm for redemptions_enabled. Without it the transaction succeeds, emits its event and
    // leaves redemptions paying out: a silent no-op on an emergency lever.
    let mut f = Fixture::new();
    f.require_redemptions_open();
    let (r, nonce) = propose_redeem_limits(&mut f, &Limits::budget(DEFAULT_INSTANT_REDEEM_BUDGET_USDC * 2));
    expect_ok(r, "queue a loosening");
    assert_eq!(f.config().pending_redeem_limits_nonce, Some(nonce), "propose did not arm the slot");

    expect_ok(tighten(&mut f, &Limits::enabled(false)), "emergency close");
    let c = f.config();
    assert!(!c.redemptions_enabled, "the emergency close did not persist");
    assert_eq!(
        c.pending_redeem_limits_nonce, None,
        "the emergency close left the queued open armed"
    );
}

#[test]
fn the_emergency_lane_still_obeys_the_fat_finger_ceilings() {
    // A longer window is the tighten direction, so only the ceiling stops a 7-day-plus window that
    // would grief instant redemption indefinitely.
    let mut f = Fixture::new();
    expect_error(
        tighten(&mut f, &Limits::window(INSTANT_WINDOW_MAX_SECONDS + 1)),
        E_ABOVE_MAXIMUM,
        "window one second above the ceiling",
    );
    assert_eq!(
        f.config().instant_redeem_window_seconds,
        DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS,
        "a refused ceiling breach moved the window"
    );
}

#[test]
fn the_emergency_lane_refuses_a_call_that_changes_nothing() {
    // Tightening to the current value passes the direction check, so only the effective-change gate
    // keeps a phantom "the throttle was tightened at 03:12" out of the incident log.
    let mut f = Fixture::new();
    expect_error(
        tighten(&mut f, &Limits::budget(DEFAULT_INSTANT_REDEEM_BUDGET_USDC)),
        E_PROPOSAL_NO_OP,
        "tighten the budget to its current value",
    );
    expect_error(
        tighten(&mut f, &Limits::default()),
        E_REDEEM_LIMITS_ALL_NONE,
        "tighten with no field set",
    );
    assert_eq!(
        f.config().instant_redeem_budget_usdc,
        DEFAULT_INSTANT_REDEEM_BUDGET_USDC,
        "a refused no-op moved the budget"
    );
}

#[test]
fn only_the_admin_may_use_the_emergency_lane() {
    // Permissionless access here is a denial of service: anyone could throttle redemptions to zero.
    let mut f = Fixture::new();
    let stranger = f.stranger.insecure_clone();

    expect_error(
        tighten_as(&mut f, &stranger, &Limits::budget(1)),
        E_CONSTRAINT_HAS_ONE,
        "emergency_tighten_redeem_limits signed by a stranger",
    );
    assert_eq!(
        f.config().instant_redeem_budget_usdc,
        DEFAULT_INSTANT_REDEEM_BUDGET_USDC,
        "a stranger moved the budget"
    );
}

// ---------------------------------------------------------------- propose.rs proposal budget

#[test]
fn the_tenth_active_proposal_is_the_last_one_accepted() {
    // The boundary of the D29 cap: nine active still admits one more.
    let mut f = Fixture::new();
    force_active_proposal_count(&mut f, MAX_ACTIVE_PROPOSALS - 1);

    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose with nine active proposals");
    let c = f.config();
    assert_eq!(c.active_proposal_count, MAX_ACTIVE_PROPOSALS, "the tenth was not counted");
    assert_eq!(c.pending_premium_mint_nonce, Some(nonce), "the slot was not armed");
}

#[test]
fn an_eleventh_proposal_is_refused_and_leaves_no_trace() {
    // Past the cap, propose must revert rather than allocate: an unbounded queue is rent the admin
    // pays and a set of live actions nobody is tracking.
    let mut f = Fixture::new();
    force_active_proposal_count(&mut f, MAX_ACTIVE_PROPOSALS);

    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_error(r, E_TOO_MANY_ACTIVE_PROPOSALS, "propose past the cap");
    let c = f.config();
    assert_eq!(c.active_proposal_count, MAX_ACTIVE_PROPOSALS, "the refused propose was counted");
    assert_eq!(c.pending_premium_mint_nonce, None, "the refused propose armed the slot");
    assert_eq!(c.next_timelock_nonce, nonce, "the refused propose consumed a nonce");
    assert_eq!(c.mint_paused_until, 0, "the refused propose paused minting");
    assert!(
        f.svm.get_account(&timelock_pda(nonce)).map_or(true, |a| a.lamports == 0),
        "the refused propose left a timelock account behind"
    );
}
