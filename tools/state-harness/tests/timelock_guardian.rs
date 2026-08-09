// On-chain tests for the timelock, the guardian set and the emergency pause. Every assertion reads an
// account back OUT of the VM after a real transaction: the 158 unit tests only call pure functions, so
// none can see a discarded write, a deleted account constraint, or a timelock that defers nothing.

mod common;

use borsh::{BorshDeserialize, BorshSerialize};
use common::*;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- codes and constants

const E_PREMIUM_TOO_HIGH: u32 = 12022;
const E_TIMELOCK_NOT_ELAPSED: u32 = 12028;
const E_TIMELOCK_ACTION_CANCELLED: u32 = 12029;
const E_TIMELOCK_ACTION_ALREADY_EXECUTED: u32 = 12030;
const E_GUARDIAN_IN_COOLDOWN: u32 = 12039;
const E_GUARDIAN_COUNT_EXCEEDED: u32 = 12040;
const E_NONCE_MISMATCH: u32 = 12042;
const E_PROPOSAL_NO_OP: u32 = 12043;
const E_PROPOSAL_ALREADY_ACTIVE: u32 = 12044;
const E_GUARDIAN_FLOOR_BREACHED: u32 = 12095;
const E_GUARDIAN_REMOVAL_ALREADY_SCHEDULED: u32 = 12096;
const E_GUARDIAN_REMOVAL_NOT_SCHEDULED: u32 = 12097;
const E_GUARDIAN_REMOVAL_EXPIRED: u32 = 12099;
const E_GUARDIAN_SELF_CANCEL_EXHAUSTED: u32 = 12100;

const ACTION_SET_PREMIUM_MINT: u8 = 1;
const ACTION_SET_PREMIUM_REDEEM: u8 = 2;

const PREMIUM_BPS_MINT_CEILING: u16 = 500;
const GUARDIAN_REMOVE_COOLDOWN_SECONDS: i64 = 3_600;
const GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS: i64 = 7 * 86_400;
const MAX_GUARDIANS: u8 = 3;

const TL_DISC: &str = "account:TimelockQueueAccount";
const GUARDIAN_DISC: &str = "account:GuardianAccount";

// ---------------------------------------------------------------- account mirrors

/// Mirror of `state::timelock::TimelockQueueAccount`. The account is allocated at a fixed SIZE and the
/// borsh body is shorter, so the tail is padding and is deliberately not compared.
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

/// Mirror of `state::guardian::GuardianAccount`.
#[derive(BorshDeserialize, BorshSerialize, Debug, Clone)]
struct Guardian {
    guardian: [u8; 32],
    added_at: i64,
    cooldown_until: i64,
    pending_removal_at: i64,
    self_cancel_used: bool,
    version: u8,
    reserved: [u8; 32],
}

fn decode<T: BorshDeserialize>(data: &[u8], disc_preimage: &str, what: &str) -> T {
    assert!(data.len() >= 8, "{what}: too short for a discriminator");
    assert_eq!(
        &data[..8],
        &anchor_disc(disc_preimage),
        "{what}: wrong account discriminator"
    );
    T::deserialize(&mut &data[8..]).unwrap_or_else(|e| {
        panic!("{what}: borsh decode failed ({e}); the on-chain layout drifted from the mirror struct")
    })
}

fn read_timelock(f: &Fixture, nonce: u64) -> Option<Timelock> {
    let acc = f.svm.get_account(&timelock_pda(nonce))?;
    if acc.lamports == 0 || acc.data.len() < 8 {
        return None;
    }
    Some(decode(&acc.data, TL_DISC, "TimelockQueueAccount"))
}

fn read_guardian(f: &Fixture, key: &Pubkey) -> Option<Guardian> {
    let acc = f.svm.get_account(&guardian_pda(key))?;
    if acc.lamports == 0 || acc.data.is_empty() {
        return None;
    }
    assert_eq!(acc.data.len(), 98, "GuardianAccount::SIZE changed");
    Some(decode(&acc.data, GUARDIAN_DISC, "GuardianAccount"))
}

fn now(f: &Fixture) -> i64 {
    let clock: solana_sdk::clock::Clock = f.svm.get_sysvar();
    clock.unix_timestamp
}

/// Write a TimelockQueueAccount at `to_nonce`, copying the account at `from_nonce` and applying `edit`.
/// The orphaned and cancelled-but-open proposals below are reachable on chain but no instruction in this
/// version can produce them (both cancel and execute close the account), so they are placed directly.
fn clone_timelock(f: &mut Fixture, from_nonce: u64, to_nonce: u64, edit: impl FnOnce(&mut Timelock)) {
    let src = f
        .svm
        .get_account(&timelock_pda(from_nonce))
        .expect("the source timelock account does not exist");
    let mut tl: Timelock = decode(&src.data, TL_DISC, "TimelockQueueAccount");
    edit(&mut tl);
    let mut data = anchor_disc(TL_DISC).to_vec();
    data.extend_from_slice(&borsh::to_vec(&tl).unwrap());
    assert!(data.len() <= src.data.len(), "the edited body outgrew the account");
    data.resize(src.data.len(), 0);
    f.svm
        .set_account(
            timelock_pda(to_nonce),
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

// ---------------------------------------------------------------- instructions

/// Anchor's encoding for `None` in an optional account slot is the PROGRAM ID in that position:
/// omitting the meta returns 3005 AccountNotEnoughKeys instead.
fn optional(slot: Option<Pubkey>) -> Pubkey {
    slot.unwrap_or_else(program_id)
}

fn propose_premium_as(f: &mut Fixture, signer: &Keypair, name: &str, bps: u16) -> (TxOutcome, u64) {
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data(name, &bps.to_le_bytes()),
    };
    (f.send(&[ix], &[signer]), nonce)
}

fn propose_premium_mint(f: &mut Fixture, bps: u16) -> (TxOutcome, u64) {
    let admin = f.admin.insecure_clone();
    propose_premium_as(f, &admin, "propose_set_premium_mint", bps)
}

fn execute_premium_as(
    f: &mut Fixture,
    signer: &Keypair,
    name: &str,
    nonce: u64,
    rent_recipient: Pubkey,
) -> TxOutcome {
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

fn execute_premium_mint(f: &mut Fixture, nonce: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    execute_premium_as(f, &admin, "execute_set_premium_mint", nonce, admin.pubkey())
}

fn cancel_timelocked_as(
    f: &mut Fixture,
    signer: &Keypair,
    guardian_slot: Option<Pubkey>,
    nonce: u64,
    rent_recipient: Pubkey,
) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(rent_recipient, false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(optional(guardian_slot), false),
        ],
        data: ix_data("cancel_timelocked_action", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

fn pause_as(f: &mut Fixture, signer: &Keypair, guardian_slot: Option<Pubkey>) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(optional(guardian_slot), false),
        ],
        data: ix_data("pause", &[]),
    };
    f.send(&[ix], &[signer])
}

/// ROUND 8: `unpause` takes a mandatory guardian slot. This file already fills all three guardian
/// slots before it unpauses, so it presents one of ITS OWN guardians rather than asking the common
/// helper to appoint a fourth, which `max_guardian_count = 3` would refuse.
fn unpause_as(f: &mut Fixture, signer: &Keypair, guardian_slot: Pubkey) -> TxOutcome {
    f.unpause_with(signer, guardian_slot)
}

fn add_guardian_as(f: &mut Fixture, signer: &Keypair, g: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new(guardian_pda(&g), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("add_guardian", g.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn add_guardian(f: &mut Fixture, g: Pubkey) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    add_guardian_as(f, &admin, g)
}

fn remove_guardian_as(f: &mut Fixture, signer: &Keypair, g: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(guardian_pda(&g), false),
        ],
        data: ix_data("remove_guardian", g.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn remove_guardian(f: &mut Fixture, g: Pubkey) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    remove_guardian_as(f, &admin, g)
}

/// `finalize_guardian_removal` takes no signer of its own: it is permissionless, and the only signature
/// on the transaction is the fee payer's.
fn finalize_removal(f: &mut Fixture, payer: &Keypair, g: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(guardian_pda(&g), false),
        ],
        data: ix_data("finalize_guardian_removal", g.as_ref()),
    };
    f.send(&[ix], &[payer])
}

fn cancel_removal_as(f: &mut Fixture, signer: &Keypair, g: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(guardian_pda(&g), false),
        ],
        data: ix_data("cancel_guardian_removal", g.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn propose_admin_transfer(f: &mut Fixture, signer: &Keypair, new_admin: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data("propose_admin_transfer", new_admin.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn accept_admin_transfer(f: &mut Fixture, new_admin: &Keypair) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(new_admin.pubkey(), true),
        ],
        data: ix_data("accept_admin_transfer", &[]),
    };
    f.send(&[ix], &[new_admin])
}

/// A funded keypair the fixture does not already own.
fn funded(f: &mut Fixture) -> Keypair {
    let k = Keypair::new();
    f.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}

/// Three appointed guardians, the maximum this config allows.
fn with_three_guardians(f: &mut Fixture) -> (Keypair, Keypair, Keypair) {
    let (g1, g2, g3) = (funded(f), funded(f), funded(f));
    for g in [&g1, &g2, &g3] {
        expect_ok(add_guardian(f, g.pubkey()), "add_guardian");
    }
    assert_eq!(f.config().guardian_count, 3, "guardian_count after three adds");
    (g1, g2, g3)
}

// ---------------------------------------------------------------- propose / execute

#[test]
fn propose_writes_the_timelock_account_and_arms_the_config_slot() {
    let mut f = Fixture::new();
    let t0 = now(&f);
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose_set_premium_mint(200)");

    // Nothing about the queued action lives in a pure function: the account contents and the config
    // slot are the whole record of it, and a discarded write here reports success.
    let tl = read_timelock(&f, nonce).expect("the timelock account must exist");
    assert_eq!(tl.nonce, nonce, "timelock.nonce");
    assert_eq!(tl.action_disc, ACTION_SET_PREMIUM_MINT, "timelock.action_disc");
    assert_eq!(tl.action_data, 200u16.to_le_bytes().to_vec(), "timelock.action_data");
    assert_eq!(tl.scheduled_at, t0, "timelock.scheduled_at");
    assert_eq!(
        tl.executable_at,
        t0 + ADMIN_TIMELOCK_SECONDS as i64,
        "timelock.executable_at is not now + admin_timelock_seconds"
    );
    assert_eq!(tl.executed_at, None, "timelock.executed_at");
    assert!(!tl.cancelled, "timelock.cancelled");
    assert_eq!(tl.proposer, f.admin.pubkey().to_bytes(), "timelock.proposer");
    assert_eq!(tl.rent_payer, f.admin.pubkey().to_bytes(), "timelock.rent_payer");

    let c = f.config();
    assert_eq!(
        c.pending_premium_mint_nonce,
        Some(nonce),
        "propose did not arm the single-active slot"
    );
    assert_eq!(c.next_timelock_nonce, nonce + 1, "next_timelock_nonce did not advance");
    assert_eq!(c.active_proposal_count, 1, "active_proposal_count");
    // D30: minting is halted across the announced window, or the old rate can be front-run for a day.
    assert_eq!(
        c.mint_paused_until, tl.executable_at,
        "propose did not pause minting for the announced window"
    );
    assert_eq!(c.premium_bps_mint, 100, "propose must not change the live premium");
}

#[test]
fn execute_before_the_delay_is_refused_then_lands_after_a_warp() {
    let mut f = Fixture::new();
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");

    // The delay is the whole point of the mechanism, and it is only observable against a clock.
    expect_error(
        execute_premium_mint(&mut f, nonce),
        E_TIMELOCK_NOT_ELAPSED,
        "execute inside the window",
    );
    assert_eq!(f.config().premium_bps_mint, 100, "a refused execute changed the premium");

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 - 1);
    expect_error(
        execute_premium_mint(&mut f, nonce),
        E_TIMELOCK_NOT_ELAPSED,
        "execute one second early",
    );

    f.warp(1);
    expect_ok(execute_premium_mint(&mut f, nonce), "execute at executable_at");
    let c = f.config();
    assert_eq!(c.premium_bps_mint, 200, "execute did not persist the new premium");
    assert_eq!(c.pending_premium_mint_nonce, None, "execute did not free the slot");
    assert_eq!(c.active_proposal_count, 0, "execute did not release the proposal budget");
    assert_eq!(c.mint_paused_until, 0, "execute left minting paused");
    assert_eq!(c.premium_bps_redeem, 150, "execute touched the other side");
    assert!(read_timelock(&f, nonce).is_none(), "the timelock account was not closed");
}

#[test]
fn executing_the_same_proposal_twice_is_refused_and_the_slot_frees_up() {
    let mut f = Fixture::new();
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(execute_premium_mint(&mut f, nonce), "execute");

    // The account was closed by the first execute, so the replay cannot even be deserialized.
    expect_error(
        execute_premium_mint(&mut f, nonce),
        E_ACCOUNT_NOT_INITIALIZED,
        "replayed execute",
    );
    assert_eq!(f.config().premium_bps_mint, 200);

    // The slot must be genuinely free afterwards, or the mint premium could never change again.
    let (r, nonce2) = propose_premium_mint(&mut f, 300);
    expect_ok(r, "a second proposal after a clean execute");
    assert_eq!(nonce2, nonce + 1);
    assert_eq!(f.config().pending_premium_mint_nonce, Some(nonce2));
}

#[test]
fn a_second_proposal_of_the_same_kind_is_refused_while_one_is_pending() {
    let mut f = Fixture::new();
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "first propose");
    // D35: without this the second propose overwrites the slot and orphans the first proposal, which
    // still holds a budget slot and can no longer be executed or found.
    let (r, _) = propose_premium_mint(&mut f, 300);
    expect_error(r, E_PROPOSAL_ALREADY_ACTIVE, "second propose while one is pending");
    let c = f.config();
    assert_eq!(c.pending_premium_mint_nonce, Some(nonce), "the slot moved");
    assert_eq!(c.next_timelock_nonce, nonce + 1, "the refused propose burned a nonce");
    assert_eq!(c.active_proposal_count, 1);
}

#[test]
fn only_the_admin_may_propose_or_execute_a_premium_change() {
    let mut f = Fixture::new();
    let stranger = f.stranger.insecure_clone();
    let (r, _) = propose_premium_as(&mut f, &stranger, "propose_set_premium_mint", 200);
    expect_error(r, E_CONSTRAINT_HAS_ONE, "propose signed by a stranger");
    assert_eq!(f.config().next_timelock_nonce, 0, "a refused propose allocated a nonce");

    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    let admin_key = f.admin.pubkey();
    // Anyone being able to execute takes away the admin's option to let a window lapse unused.
    expect_error(
        execute_premium_as(&mut f, &stranger, "execute_set_premium_mint", nonce, admin_key),
        E_CONSTRAINT_HAS_ONE,
        "execute signed by a stranger",
    );
    assert_eq!(f.config().premium_bps_mint, 100);
}

#[test]
fn the_a7_bind_refuses_an_execute_that_is_not_the_configs_active_nonce() {
    let mut f = Fixture::new();
    let (r, live) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose the live action");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);

    // An orphan: same kind, same rent payer, already matured, but the config slot points elsewhere.
    // A7 is what makes clearing the slot actually stop a proposal, and the code calls it the check
    // most likely to be deleted as redundant.
    let orphan = live + 1;
    clone_timelock(&mut f, live, orphan, |tl| tl.nonce = orphan);
    let admin = f.admin.insecure_clone();
    expect_error(
        execute_premium_as(
            &mut f,
            &admin,
            "execute_set_premium_mint",
            orphan,
            admin.pubkey(),
        ),
        E_NONCE_MISMATCH,
        "execute of an orphan whose nonce is not the config's active slot",
    );
    assert_eq!(f.config().premium_bps_mint, 100, "the orphan execute landed anyway");

    // Positive control: the same call on the ACTIVE nonce succeeds, so the refusal above was the A7
    // bind and not a broken crafted account.
    expect_ok(execute_premium_mint(&mut f, live), "execute the live action");
    assert_eq!(f.config().premium_bps_mint, 200);
}

#[test]
fn execute_revalidates_the_decoded_action_data_against_the_ceiling() {
    let mut f = Fixture::new();
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose an in-range premium");
    // Rewrite the queued payload out of range. propose validated the value it was given, so only the
    // execute-side re-validation stands between a corrupted or mis-encoded action and a 655% premium.
    clone_timelock(&mut f, nonce, nonce, |tl| {
        tl.action_data = u16::MAX.to_le_bytes().to_vec()
    });
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        execute_premium_mint(&mut f, nonce),
        E_PREMIUM_TOO_HIGH,
        "execute of an out-of-range action_data",
    );
    assert_eq!(f.config().premium_bps_mint, 100);
}

#[test]
fn a_premium_proposal_above_the_ceiling_or_a_no_op_is_refused() {
    let mut f = Fixture::new();
    let (r, _) = propose_premium_mint(&mut f, PREMIUM_BPS_MINT_CEILING + 1);
    expect_error(r, E_PREMIUM_TOO_HIGH, "propose above the ceiling");
    let (r, _) = propose_premium_mint(&mut f, 100);
    expect_error(r, E_PROPOSAL_NO_OP, "propose the value already live");
    let c = f.config();
    assert_eq!(c.next_timelock_nonce, 0, "a refused propose allocated a nonce");
    assert_eq!(c.active_proposal_count, 0);
    assert_eq!(c.mint_paused_until, 0, "a refused propose paused minting");

    // The ceiling itself must be reachable, and the post-write invariant must still hold after it.
    let (r, nonce) = propose_premium_mint(&mut f, PREMIUM_BPS_MINT_CEILING);
    expect_ok(r, "propose exactly at the ceiling");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(execute_premium_mint(&mut f, nonce), "execute at the ceiling");
    assert_eq!(f.config().premium_bps_mint, PREMIUM_BPS_MINT_CEILING);

    // And one bps past it is refused, which is what makes the ceiling a ceiling. The previous version
    // asserted `stored <= CEILING` right after pinning `stored == CEILING`, so it could not fail.
    let (r, _) = propose_premium_mint(&mut f, PREMIUM_BPS_MINT_CEILING + 1);
    expect_error(r, E_PREMIUM_TOO_HIGH, "propose one bps above the ceiling, from the ceiling");
    assert_eq!(
        f.config().premium_bps_mint,
        PREMIUM_BPS_MINT_CEILING,
        "a refused propose moved the live premium"
    );
}

#[test]
fn the_combined_premium_floor_is_disabled_in_the_shipped_bytes() {
    let mut f = Fixture::new();
    // PREMIUM_BPS_COMBINED_FLOOR is 0, so `sum >= FLOOR` can refuse nothing: a zero mint premium
    // against the launch redeem premium executes. If the floor is ever raised this goes red.
    let (r, nonce) = propose_premium_mint(&mut f, 0);
    expect_ok(r, "propose a zero mint premium");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(execute_premium_mint(&mut f, nonce), "execute a zero mint premium");
    assert_eq!(f.config().premium_bps_mint, 0);
}

// ---------------------------------------------------------------- cancel

#[test]
fn a_guardian_can_cancel_a_pending_action_and_the_slot_is_disarmed() {
    let mut f = Fixture::new();
    let g = funded(&mut f);
    expect_ok(add_guardian(&mut f, g.pubkey()), "add_guardian");
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");
    let admin_key = f.admin.pubkey();

    expect_ok(
        cancel_timelocked_as(&mut f, &g, Some(guardian_pda(&g.pubkey())), nonce, admin_key),
        "cancel by an active guardian",
    );
    let c = f.config();
    assert_eq!(
        c.pending_premium_mint_nonce, None,
        "cancel did not disarm the single-active slot"
    );
    assert_eq!(c.active_proposal_count, 0, "cancel did not release the budget slot");
    // A veto of a fee change must not also leave minting halted for the rest of the window.
    assert_eq!(c.mint_paused_until, 0, "cancel left minting paused");
    assert_eq!(c.premium_bps_mint, 100);
    assert!(read_timelock(&f, nonce).is_none(), "cancel did not close the account");

    // The action kind must be re-proposable, which is what the slot clear buys.
    let (r, _) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "re-propose after a cancel");
}

#[test]
fn cancelling_an_orphan_must_not_disarm_a_live_premium_mint_proposal() {
    let mut f = Fixture::new();
    let (r, live) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose the live action");
    let paused_until = f.config().mint_paused_until;
    let orphan = live + 1;
    clone_timelock(&mut f, live, orphan, |tl| tl.nonce = orphan);

    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    expect_ok(
        cancel_timelocked_as(&mut f, &admin, None, orphan, admin_key),
        "cancel the orphan",
    );
    // "Only disarm what is mine": an unconditional clear keyed on the action kind alone would kill a
    // live proposal and reopen the front-run window mint_paused_until exists to close.
    let c = f.config();
    assert_eq!(
        c.pending_premium_mint_nonce,
        Some(live),
        "cancelling an orphan wiped the slot of a LIVE proposal"
    );
    assert_eq!(
        c.mint_paused_until, paused_until,
        "cancelling an orphan reopened the announced mint window"
    );

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(execute_premium_mint(&mut f, live), "the live action still executes");
    assert_eq!(f.config().premium_bps_mint, 200);
}

#[test]
fn cancelling_an_orphan_must_not_disarm_a_live_premium_redeem_proposal() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let (r, live) = propose_premium_as(&mut f, &admin, "propose_set_premium_redeem", 200);
    expect_ok(r, "propose the live redeem action");
    assert_eq!(f.config().pending_premium_redeem_nonce, Some(live));
    assert_eq!(
        read_timelock(&f, live).unwrap().action_disc,
        ACTION_SET_PREMIUM_REDEEM,
        "timelock.action_disc"
    );
    let orphan = live + 1;
    clone_timelock(&mut f, live, orphan, |tl| tl.nonce = orphan);

    // Same guard, reached through the disarm_if_mine! macro rather than the premium-mint arm.
    let admin_key = admin.pubkey();
    expect_ok(
        cancel_timelocked_as(&mut f, &admin, None, orphan, admin_key),
        "cancel the orphan",
    );
    assert_eq!(
        f.config().pending_premium_redeem_nonce,
        Some(live),
        "cancelling an orphan wiped the slot of a LIVE proposal"
    );

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(
        execute_premium_as(&mut f, &admin, "execute_set_premium_redeem", live, admin_key),
        "the live redeem action still executes",
    );
    assert_eq!(f.config().premium_bps_redeem, 200);
}

#[test]
fn a_stranger_and_a_foreign_guardian_account_cannot_cancel() {
    let mut f = Fixture::new();
    let (g1, g2, _g3) = with_three_guardians(&mut f);
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");
    let stranger = f.stranger.insecure_clone();
    let admin_key = f.admin.pubkey();

    expect_error(
        cancel_timelocked_as(&mut f, &stranger, None, nonce, admin_key),
        E_UNAUTHORIZED,
        "cancel by a stranger",
    );
    // The PDA seeds bind the guardian account to the SIGNER. Deleting that attribute leaves only
    // may_act's `guardian == signer` re-check, and the failure code moves from 2006 to 12013.
    expect_error(
        cancel_timelocked_as(
            &mut f,
            &g1,
            Some(guardian_pda(&g2.pubkey())),
            nonce,
            admin_key,
        ),
        E_CONSTRAINT_SEEDS,
        "cancel presenting another guardian's account",
    );
    assert_eq!(f.config().pending_premium_mint_nonce, Some(nonce), "a refused cancel disarmed");

    // A guardian whose removal was finalized is in cooldown and must lose the veto.
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "schedule g1's removal");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    let payer = funded(&mut f);
    expect_ok(finalize_removal(&mut f, &payer, g1.pubkey()), "finalize g1");
    expect_error(
        cancel_timelocked_as(&mut f, &g1, Some(guardian_pda(&g1.pubkey())), nonce, admin_key),
        E_UNAUTHORIZED,
        "cancel by a guardian in cooldown",
    );
    assert_eq!(f.config().pending_premium_mint_nonce, Some(nonce));
}

#[test]
fn a_cancelled_or_executed_timelock_account_is_refused_by_cancel_and_execute() {
    let mut f = Fixture::new();
    let (r, live) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();

    // Both instructions close the account, so a cancelled-or-executed account that is still open can
    // only be placed directly. The constraints are live code and this is what tests them.
    let dead = live + 1;
    clone_timelock(&mut f, live, dead, |tl| {
        tl.nonce = dead;
        tl.cancelled = true;
    });
    expect_error(
        cancel_timelocked_as(&mut f, &admin, None, dead, admin_key),
        E_TIMELOCK_ACTION_CANCELLED,
        "cancel an already-cancelled proposal",
    );
    expect_error(
        execute_premium_as(&mut f, &admin, "execute_set_premium_mint", dead, admin_key),
        E_TIMELOCK_ACTION_CANCELLED,
        "execute a cancelled proposal",
    );

    let done = live + 2;
    clone_timelock(&mut f, live, done, |tl| {
        tl.nonce = done;
        tl.executed_at = Some(NOW_SECS);
    });
    expect_error(
        cancel_timelocked_as(&mut f, &admin, None, done, admin_key),
        E_TIMELOCK_ACTION_ALREADY_EXECUTED,
        "cancel an executed proposal",
    );
    expect_error(
        execute_premium_as(&mut f, &admin, "execute_set_premium_mint", done, admin_key),
        E_TIMELOCK_ACTION_ALREADY_EXECUTED,
        "execute an executed proposal",
    );
    assert_eq!(f.config().premium_bps_mint, 100);
}

// ---------------------------------------------------------------- pause

#[test]
fn pause_is_admin_or_guardian_and_the_flag_reads_back_on_chain() {
    let mut f = Fixture::new();
    let (g1, g2, _g3) = with_three_guardians(&mut f);
    let admin = f.admin.insecure_clone();
    let stranger = f.stranger.insecure_clone();
    expect_ok(unpause_as(&mut f, &admin, guardian_pda(&g2.pubkey())), "unpause to start from live");
    assert!(!f.config().paused);

    // The worst failure mode in the file: a pause that emits Paused and never writes the flag, so an
    // operator responding to a bad print sees a confirmed halt while mint and redeem keep running.
    expect_ok(pause_as(&mut f, &admin, None), "pause by the admin");
    assert!(f.config().paused, "pause did not persist config.paused");

    expect_ok(unpause_as(&mut f, &admin, guardian_pda(&g2.pubkey())), "unpause");
    expect_ok(
        pause_as(&mut f, &g1, Some(guardian_pda(&g1.pubkey()))),
        "pause by an active guardian",
    );
    assert!(f.config().paused, "a guardian pause did not persist");

    expect_ok(unpause_as(&mut f, &admin, guardian_pda(&g2.pubkey())), "unpause");
    expect_error(pause_as(&mut f, &stranger, None), E_UNAUTHORIZED, "pause by a stranger");
    assert!(!f.config().paused, "a refused pause halted the protocol anyway");
    // The seeds attribute is what makes may_act's re-check unnecessary; without it this is 12013.
    expect_error(
        pause_as(&mut f, &g1, Some(guardian_pda(&g2.pubkey()))),
        E_CONSTRAINT_SEEDS,
        "pause presenting another guardian's account",
    );
    assert!(!f.config().paused);

    expect_ok(remove_guardian(&mut f, g1.pubkey()), "schedule g1's removal");
    // The removal is DEFERRED: the target keeps every power for the whole window, which is what makes
    // the veto non-circular.
    expect_ok(
        pause_as(&mut f, &g1, Some(guardian_pda(&g1.pubkey()))),
        "a guardian under notice may still pause",
    );
    assert!(f.config().paused);

    expect_ok(unpause_as(&mut f, &admin, guardian_pda(&g2.pubkey())), "unpause");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    let payer = funded(&mut f);
    expect_ok(finalize_removal(&mut f, &payer, g1.pubkey()), "finalize g1");
    expect_error(
        pause_as(&mut f, &g1, Some(guardian_pda(&g1.pubkey()))),
        E_UNAUTHORIZED,
        "pause by a guardian in cooldown",
    );
    assert!(!f.config().paused, "a removed guardian still halted the protocol");
}

#[test]
fn unpause_is_admin_only_and_instant() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let admin = f.admin.insecure_clone();
    let stranger = f.stranger.insecure_clone();
    assert!(f.config().paused, "a fresh deploy is paused");

    // Guardians hold the pause, not the resume: a guardian that could unpause would defeat its own veto.
    expect_error(unpause_as(&mut f, &g1, guardian_pda(&g1.pubkey())), E_CONSTRAINT_HAS_ONE, "unpause by a guardian");
    expect_error(unpause_as(&mut f, &stranger, guardian_pda(&g1.pubkey())), E_CONSTRAINT_HAS_ONE, "unpause by a stranger");
    assert!(f.config().paused, "a refused unpause resumed the protocol");

    expect_ok(unpause_as(&mut f, &admin, guardian_pda(&g1.pubkey())), "unpause by the admin");
    assert!(!f.config().paused, "unpause did not persist; the protocol can never resume");
}

// ---------------------------------------------------------------- guardian set

#[test]
fn add_guardian_writes_the_account_and_the_count() {
    let mut f = Fixture::new();
    let t0 = now(&f);
    let g1 = funded(&mut f);
    let stranger = f.stranger.insecure_clone();

    expect_error(
        add_guardian_as(&mut f, &stranger, g1.pubkey()),
        E_CONSTRAINT_HAS_ONE,
        "add_guardian by a stranger",
    );
    assert!(read_guardian(&f, &g1.pubkey()).is_none());

    expect_ok(add_guardian(&mut f, g1.pubkey()), "add_guardian");
    let acc = read_guardian(&f, &g1.pubkey()).expect("the GuardianAccount must exist");
    assert_eq!(acc.guardian, g1.pubkey().to_bytes(), "GuardianAccount.guardian");
    assert_eq!(acc.added_at, t0, "GuardianAccount.added_at");
    assert_eq!(acc.cooldown_until, 0, "a new guardian must be active");
    assert_eq!(acc.pending_removal_at, 0);
    assert!(!acc.self_cancel_used, "a new guardian starts with its veto budget");
    assert_eq!(acc.version, 1, "GuardianAccount.version");
    // Without the persisted count, finalize_guardian_removal's floor can never pass and no guardian
    // can ever be removed, while the console still shows a veto set.
    assert_eq!(f.config().guardian_count, 1, "add_guardian did not persist the count");

    // Re-adding an ACTIVE guardian would let one key inflate the count to the maximum.
    expect_error(
        add_guardian(&mut f, g1.pubkey()),
        E_PROPOSAL_ALREADY_ACTIVE,
        "re-add an already active guardian",
    );
    assert_eq!(f.config().guardian_count, 1, "a refused re-add inflated the count");

    let (g2, g3, g4) = (funded(&mut f), funded(&mut f), funded(&mut f));
    expect_ok(add_guardian(&mut f, g2.pubkey()), "add g2");
    expect_ok(add_guardian(&mut f, g3.pubkey()), "add g3");
    assert_eq!(f.config().guardian_count, MAX_GUARDIANS);
    expect_error(
        add_guardian(&mut f, g4.pubkey()),
        E_GUARDIAN_COUNT_EXCEEDED,
        "add past max_guardian_count",
    );
    assert_eq!(f.config().guardian_count, MAX_GUARDIANS);
}

#[test]
fn the_admin_may_not_appoint_itself_or_the_incoming_admin() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    // Self-appointment would satisfy guardian_count and the floor with a seat that is no veto at all.
    expect_error(
        add_guardian(&mut f, admin_key),
        E_UNAUTHORIZED,
        "the admin appointing itself",
    );
    assert_eq!(f.config().guardian_count, 0);

    let incoming = funded(&mut f);
    expect_ok(
        propose_admin_transfer(&mut f, &admin, incoming.pubkey()),
        "propose_admin_transfer",
    );
    // Otherwise the barrier is sidestepped: appoint K, then complete a transfer to K.
    expect_error(
        add_guardian(&mut f, incoming.pubkey()),
        E_UNAUTHORIZED,
        "appointing the INCOMING admin",
    );
    assert_eq!(f.config().guardian_count, 0);
}

#[test]
fn guardian_removal_is_scheduled_deferred_and_finalized() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let stranger = f.stranger.insecure_clone();
    let payer = funded(&mut f);
    let t0 = now(&f);

    expect_error(
        remove_guardian_as(&mut f, &stranger, g1.pubkey()),
        E_CONSTRAINT_HAS_ONE,
        "remove_guardian by a stranger",
    );
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "schedule g1's removal");
    let acc = read_guardian(&f, &g1.pubkey()).unwrap();
    // A removal that took effect immediately would make the guardian veto circular.
    assert_eq!(
        acc.pending_removal_at,
        t0 + ADMIN_TIMELOCK_SECONDS as i64,
        "the notice is not deferred by the admin timelock"
    );
    assert_eq!(acc.cooldown_until, 0, "the target must keep its powers during the window");
    let c = f.config();
    assert_eq!(c.pending_removal_count, 1, "remove_guardian did not count the notice");
    assert_eq!(c.guardian_count, 3, "scheduling must not shrink the set");

    expect_error(
        remove_guardian(&mut f, g1.pubkey()),
        E_GUARDIAN_REMOVAL_ALREADY_SCHEDULED,
        "re-scheduling a live notice",
    );
    expect_error(
        finalize_removal(&mut f, &payer, g1.pubkey()),
        E_TIMELOCK_NOT_ELAPSED,
        "finalize inside the window",
    );
    assert_eq!(f.config().guardian_count, 3);

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    let t1 = now(&f);
    // Permissionless on purpose, so a stalling admin cannot leave a removal hanging indefinitely.
    expect_ok(finalize_removal(&mut f, &payer, g1.pubkey()), "finalize g1");
    let acc = read_guardian(&f, &g1.pubkey()).unwrap();
    assert_eq!(
        acc.cooldown_until,
        t1 + GUARDIAN_REMOVE_COOLDOWN_SECONDS,
        "finalize did not put the guardian in cooldown, so it keeps every power"
    );
    assert_eq!(acc.pending_removal_at, 0, "finalize left the notice armed");
    let c = f.config();
    assert_eq!(c.guardian_count, 2, "finalize did not persist the decrement");
    assert_eq!(c.pending_removal_count, 0, "finalize left the pending counter inflated");
}

#[test]
fn the_removal_floor_blocks_a_parallel_purge() {
    let mut f = Fixture::new();
    let (g1, g2, g3) = with_three_guardians(&mut f);
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");
    expect_ok(remove_guardian(&mut f, g2.pubkey()), "notice g2");
    // The floor counts guardians NOT already under notice, so one window can never purge the set.
    expect_error(
        remove_guardian(&mut f, g3.pubkey()),
        E_GUARDIAN_FLOOR_BREACHED,
        "putting the whole set under notice in one window",
    );
    let c = f.config();
    assert_eq!(c.pending_removal_count, 2, "the refused notice was counted");
    assert_eq!(c.guardian_count, 3);
    assert_eq!(
        read_guardian(&f, &g3.pubkey()).unwrap().pending_removal_at,
        0,
        "the refused notice was written to the guardian anyway"
    );
}

#[test]
fn a_matured_notice_expires_and_then_anyone_may_clear_it() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let payer = funded(&mut f);
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS + 2);
    // Without the expiry window a matured notice is a stored instant-eviction coupon: pre-armed while
    // quiet, redeemed months later with no reaction time.
    expect_error(
        finalize_removal(&mut f, &payer, g1.pubkey()),
        E_GUARDIAN_REMOVAL_EXPIRED,
        "finalize an expired notice",
    );
    assert_eq!(f.config().guardian_count, 3);

    // Housekeeping is open to anyone once expired, or pending_removal_count stays inflated and blocks
    // every future removal through the floor.
    let stranger = f.stranger.insecure_clone();
    expect_ok(
        cancel_removal_as(&mut f, &stranger, g1.pubkey()),
        "anyone clears an expired notice",
    );
    let acc = read_guardian(&f, &g1.pubkey()).unwrap();
    assert_eq!(acc.pending_removal_at, 0, "the expired notice stayed armed");
    assert!(!acc.self_cancel_used, "housekeeping burned the target's veto budget");
    assert_eq!(
        f.config().pending_removal_count,
        0,
        "the pending counter stayed inflated"
    );
}

#[test]
fn finalize_needs_a_notice_and_removal_refuses_a_cooled_down_guardian() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let payer = funded(&mut f);
    // Without this the whole scheduling step can be skipped: `now >= 0` passes for an unnoticed
    // guardian and this instruction is permissionless.
    expect_error(
        finalize_removal(&mut f, &payer, g1.pubkey()),
        E_GUARDIAN_REMOVAL_NOT_SCHEDULED,
        "finalize with no notice",
    );
    expect_error(
        cancel_removal_as(&mut f, &payer, g1.pubkey()),
        E_GUARDIAN_REMOVAL_NOT_SCHEDULED,
        "cancel with no notice",
    );
    assert_eq!(f.config().guardian_count, 3);

    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(finalize_removal(&mut f, &payer, g1.pubkey()), "finalize g1");
    // A guardian in cooldown holds no seat, so noticing it again would inflate the pending counter
    // against a seat that is not active and block real removals through the floor.
    expect_error(
        remove_guardian(&mut f, g1.pubkey()),
        E_GUARDIAN_IN_COOLDOWN,
        "notice a guardian already in cooldown",
    );
    assert_eq!(f.config().pending_removal_count, 0);
}

#[test]
fn the_target_may_veto_its_own_removal_exactly_once() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let stranger = f.stranger.insecure_clone();
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");

    // A third party cancelling would mean no guardian could ever be evicted.
    expect_error(
        cancel_removal_as(&mut f, &stranger, g1.pubkey()),
        E_UNAUTHORIZED,
        "a third party cancelling a live notice",
    );
    assert_ne!(read_guardian(&f, &g1.pubkey()).unwrap().pending_removal_at, 0);

    expect_ok(cancel_removal_as(&mut f, &g1, g1.pubkey()), "the target vetoes its removal");
    let acc = read_guardian(&f, &g1.pubkey()).unwrap();
    assert_eq!(acc.pending_removal_at, 0, "the veto did not clear the notice");
    assert!(acc.self_cancel_used, "the veto did not consume the one-use budget");
    assert_eq!(f.config().pending_removal_count, 0);

    // The cap is what bounds eviction to two windows; unlimited self-vetoes made a rogue guardian
    // permanently unremovable, and it can pause repeatedly while unpause is admin-only.
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1 again");
    expect_error(
        cancel_removal_as(&mut f, &g1, g1.pubkey()),
        E_GUARDIAN_SELF_CANCEL_EXHAUSTED,
        "a second self-veto",
    );
    let c = f.config();
    assert_eq!(c.pending_removal_count, 1, "the refused veto cleared the notice");
    assert_ne!(read_guardian(&f, &g1.pubkey()).unwrap().pending_removal_at, 0);
}

#[test]
fn an_admin_cancel_does_not_burn_the_targets_self_veto() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let admin = f.admin.insecure_clone();
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");
    expect_ok(cancel_removal_as(&mut f, &admin, g1.pubkey()), "the admin cancels");
    assert!(
        !read_guardian(&f, &g1.pubkey()).unwrap().self_cancel_used,
        "an admin cancel consumed the target's veto budget"
    );
    assert_eq!(f.config().pending_removal_count, 0);

    // Proof the budget really survived: the target can still veto once.
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1 again");
    expect_ok(cancel_removal_as(&mut f, &g1, g1.pubkey()), "the target still holds its veto");
    assert!(read_guardian(&f, &g1.pubkey()).unwrap().self_cancel_used);
}

#[test]
fn a_key_holding_both_roles_cancels_as_admin_and_keeps_the_veto() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let (_g1, _g2, k) = with_three_guardians(&mut f);

    expect_ok(propose_admin_transfer(&mut f, &admin, k.pubkey()), "propose the transfer");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(accept_admin_transfer(&mut f, &k), "accept the transfer");
    assert_eq!(f.config().admin_key(), k.pubkey(), "the admin did not move");

    // K is now both admin and target. The admin branch is tested FIRST for exactly this case, so the
    // cancel must not spend the guardian's single self-veto.
    expect_ok(remove_guardian_as(&mut f, &k, k.pubkey()), "the admin notices itself");
    expect_ok(cancel_removal_as(&mut f, &k, k.pubkey()), "cancel as admin and target");
    assert!(
        !read_guardian(&f, &k.pubkey()).unwrap().self_cancel_used,
        "the admin branch burned the guardian's veto budget"
    );
    assert_eq!(f.config().pending_removal_count, 0);
}

#[test]
fn a_re_appointment_waits_out_the_cooldown_and_resets_the_veto_budget() {
    let mut f = Fixture::new();
    let (g1, _g2, _g3) = with_three_guardians(&mut f);
    let payer = funded(&mut f);

    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");
    expect_ok(cancel_removal_as(&mut f, &g1, g1.pubkey()), "g1 spends its veto");
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1 again");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(finalize_removal(&mut f, &payer, g1.pubkey()), "finalize g1");
    assert_eq!(f.config().guardian_count, 2);

    // The cooldown is what stops the admin who ordered a removal from undoing it in the same slot.
    expect_error(
        add_guardian(&mut f, g1.pubkey()),
        E_GUARDIAN_IN_COOLDOWN,
        "re-appoint inside the cooldown",
    );
    assert_eq!(f.config().guardian_count, 2);

    f.warp(GUARDIAN_REMOVE_COOLDOWN_SECONDS + 1);
    let t = now(&f);
    expect_ok(add_guardian(&mut f, g1.pubkey()), "re-appoint after the cooldown");
    let acc = read_guardian(&f, &g1.pubkey()).unwrap();
    assert_eq!(acc.cooldown_until, 0, "the re-appointed guardian is still in cooldown");
    assert_eq!(acc.added_at, t, "the re-appointment did not refresh added_at");
    // A fresh mandate is a fresh budget, or the 48h eviction bound silently becomes 24h for that key.
    assert!(!acc.self_cancel_used, "the re-appointed guardian inherited a spent veto");
    assert_eq!(f.config().guardian_count, 3, "the re-appointment did not count");

    expect_ok(
        pause_as(&mut f, &g1, Some(guardian_pda(&g1.pubkey()))),
        "the re-appointed guardian may act again",
    );
    assert!(f.config().paused);
}
