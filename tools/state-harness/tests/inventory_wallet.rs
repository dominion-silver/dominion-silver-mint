// ROUND 7. The pre-mint DESTINATION, and the redirect both auditors refused to let ship.
//
// THE ATTACK, in the words of the Codex report: the admin can `set_inventory_wallet(attacker)` and
// then `admin_premint(remaining cap headroom)` in the same block. The hard cap bounds how much can be
// taken; it provides no window in which anyone could see it coming and no way to stop it.
//
// THE SHAPE OF THE FIX, which these tests exist to pin down. The FIRST binding stays instant, because
// with the field unset `admin_premint` refuses outright and there is nothing to redirect. Every
// CHANGE goes through propose + 24h + execute, and is guardian-cancellable like every other timelocked
// action. That deviation from the letter of the auditors' condition is deliberate and is what the
// first two tests below assert, so it cannot be lost silently in a later refactor.

mod common;

use common::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

const E_INVENTORY_WALLET_NOT_SET: u32 = 12086;
const E_TIMELOCK_NOT_ELAPSED: u32 = 12028;
const E_NONCE_MISMATCH: u32 = 12042;
const E_PROPOSAL_ALREADY_ACTIVE: u32 = 12044;
const E_CONSTRAINT_HAS_ONE: u32 = 2001;

// Appended at the end of the error enum, so these two are the last codes in it.
const E_INVENTORY_CHANGE_REQUIRES_TIMELOCK: u32 = 12122;
const E_INVENTORY_UNCHANGED: u32 = 12123;

fn set_inventory_as(f: &mut Fixture, signer: &Keypair, wallet: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data("set_inventory_wallet", wallet.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn propose_inventory_as(f: &mut Fixture, signer: &Keypair, wallet: Pubkey) -> (TxOutcome, u64) {
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("propose_set_inventory_wallet", wallet.as_ref()),
    };
    (f.send(&[ix], &[signer]), nonce)
}

fn execute_inventory_as(f: &mut Fixture, signer: &Keypair, nonce: u64, rent: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(rent, false),
        ],
        data: ix_data("execute_set_inventory_wallet", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

fn unpause(f: &mut Fixture) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: ix_data("unpause", &[]),
    };
    f.send(&[ix], &[&admin])
}

/// The fixture ships PAUSED, which is the launch posture. `execute_set_inventory_wallet` refuses a
/// redirect while paused ON PURPOSE: it would otherwise take effect the instant somebody unpauses,
/// which is exactly when nobody is watching this field. Tests that reach an execute therefore need a
/// live protocol, and the ones that do not deliberately keep the paused fixture.
fn live() -> Fixture {
    let mut f = Fixture::new_bare();
    expect_ok(unpause(&mut f), "fixture: unpause");
    f
}

fn inventory(f: &Fixture) -> Pubkey {
    Pubkey::new_from_array(f.config().inventory_wallet)
}

// ---------------------------------------------------------------- the first binding

#[test]
fn the_first_binding_is_instant_and_the_second_is_refused() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let first = Pubkey::new_unique();
    let second = Pubkey::new_unique();

    assert_eq!(inventory(&f), Pubkey::default(), "the fixture starts unbound");
    expect_ok(set_inventory_as(&mut f, &admin, first), "the first binding");
    assert_eq!(inventory(&f), first, "the first binding did not persist");

    // THE WHOLE POINT. A second instant call is the redirect, and it is refused with an error that
    // names the path to take instead.
    expect_error(
        set_inventory_as(&mut f, &admin, second),
        E_INVENTORY_CHANGE_REQUIRES_TIMELOCK,
        "an instant CHANGE of an already-bound inventory wallet",
    );
    assert_eq!(inventory(&f), first, "the refused call moved the wallet anyway");
}

#[test]
fn the_first_binding_still_refuses_the_default_pubkey_and_a_stranger() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let stranger = f.stranger.insecure_clone();

    expect_error(
        set_inventory_as(&mut f, &admin, Pubkey::default()),
        E_INVENTORY_WALLET_NOT_SET,
        "binding the zero pubkey",
    );
    expect_error(
        set_inventory_as(&mut f, &stranger, Pubkey::new_unique()),
        E_CONSTRAINT_HAS_ONE,
        "a stranger binding the inventory wallet",
    );
    assert_eq!(inventory(&f), Pubkey::default(), "the wallet was bound anyway");
}

// ---------------------------------------------------------------- the timelocked change

#[test]
fn a_change_takes_a_proposal_the_full_delay_and_an_execute() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    let first = Pubkey::new_unique();
    let second = Pubkey::new_unique();
    expect_ok(set_inventory_as(&mut f, &admin, first), "bind");

    let (r, nonce) = propose_inventory_as(&mut f, &admin, second);
    expect_ok(r, "propose the change");
    assert_eq!(
        f.config().pending_inventory_wallet_nonce,
        Some(nonce),
        "the config did not record the pending proposal"
    );
    // Proposing does NOT move the wallet. This is the observation window the auditors asked for.
    assert_eq!(inventory(&f), first, "proposing moved the wallet immediately");

    // One second short of the delay is still refused. The boundary is the property, not the ballpark.
    let delay = f.config().admin_timelock_seconds as i64;
    f.warp(delay - 1);
    expect_error(
        execute_inventory_as(&mut f, &admin, nonce, admin_key),
        E_TIMELOCK_NOT_ELAPSED,
        "executing one second early",
    );
    assert_eq!(inventory(&f), first, "the early execute moved the wallet");

    f.warp(1);
    expect_ok(
        execute_inventory_as(&mut f, &admin, nonce, admin_key),
        "execute after the delay",
    );
    assert_eq!(inventory(&f), second, "the change did not land");
    assert_eq!(
        f.config().pending_inventory_wallet_nonce, None,
        "the slot was not released"
    );
}

#[test]
fn only_one_change_may_be_armed_at_a_time() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    expect_ok(set_inventory_as(&mut f, &admin, Pubkey::new_unique()), "bind");

    let (r, _) = propose_inventory_as(&mut f, &admin, Pubkey::new_unique());
    expect_ok(r, "the first proposal");

    // Without this, an admin could arm five redirects to five wallets and a guardian would have to
    // cancel all five inside the window. One armed proposal per kind is what makes the veto tractable.
    let (r2, _) = propose_inventory_as(&mut f, &admin, Pubkey::new_unique());
    expect_error(r2, E_PROPOSAL_ALREADY_ACTIVE, "a second concurrent proposal");
}

#[test]
fn proposing_the_wallet_already_configured_is_refused() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let bound = Pubkey::new_unique();
    expect_ok(set_inventory_as(&mut f, &admin, bound), "bind");

    // A no-op costs a 24h window and a guardian's attention for nothing.
    let (r, _) = propose_inventory_as(&mut f, &admin, bound);
    expect_error(r, E_INVENTORY_UNCHANGED, "proposing the current wallet");
}

#[test]
fn a_stranger_may_neither_propose_nor_execute_a_change() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    let stranger = f.stranger.insecure_clone();
    let first = Pubkey::new_unique();
    expect_ok(set_inventory_as(&mut f, &admin, first), "bind");

    let (r, _) = propose_inventory_as(&mut f, &stranger, Pubkey::new_unique());
    expect_error(r, E_CONSTRAINT_HAS_ONE, "a stranger proposing a redirect");

    let (r2, nonce) = propose_inventory_as(&mut f, &admin, Pubkey::new_unique());
    expect_ok(r2, "the admin proposes");
    let delay = f.config().admin_timelock_seconds as i64;
    f.warp(delay + 1);
    expect_error(
        execute_inventory_as(&mut f, &stranger, nonce, admin_key),
        E_CONSTRAINT_HAS_ONE,
        "a stranger executing a matured redirect",
    );
    assert_eq!(inventory(&f), first, "a stranger moved the wallet");
}

#[test]
fn cancelling_a_change_releases_the_slot_and_leaves_the_wallet_alone() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    let first = Pubkey::new_unique();
    expect_ok(set_inventory_as(&mut f, &admin, first), "bind");

    let (r, nonce) = propose_inventory_as(&mut f, &admin, Pubkey::new_unique());
    expect_ok(r, "propose");

    // Account order copied from the proven helper in transfer_close.rs rather than guessed: my first
    // attempt invented one and Anchor answered 3010. The trailing program id is Anchor's encoding for
    // an absent optional account, here the guardian.
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(admin_key, false),
            AccountMeta::new_readonly(admin_key, true),
            AccountMeta::new_readonly(program_id(), false),
        ],
        data: ix_data("cancel_timelocked_action", &nonce.to_le_bytes()),
    };
    expect_ok(f.send(&[ix], &[&admin]), "cancel the redirect");

    assert_eq!(inventory(&f), first, "cancelling moved the wallet");
    assert_eq!(
        f.config().pending_inventory_wallet_nonce, None,
        "cancelling did not release the slot, so no further change could ever be proposed"
    );

    // And the slot really is reusable: the guardian veto must not brick the setter for good.
    let (r2, _) = propose_inventory_as(&mut f, &admin, Pubkey::new_unique());
    expect_ok(r2, "a fresh proposal after a cancellation");
}

// ---------------------------------------------------------------- the attack itself

#[test]
fn the_redirect_then_premint_pair_cannot_happen_in_one_block() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let legitimate = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    expect_ok(set_inventory_as(&mut f, &admin, legitimate), "bind");

    // This is the Codex scenario, verbatim: redirect, then mint the cap headroom into the new
    // destination, same block. The first half no longer exists as an instant instruction, so the
    // pair cannot be assembled at all, and the transaction fails on the redirect rather than after
    // the supply has moved.
    expect_error(
        set_inventory_as(&mut f, &admin, attacker),
        E_INVENTORY_CHANGE_REQUIRES_TIMELOCK,
        "the redirect half of the redirect-then-premint pair",
    );
    assert_eq!(
        inventory(&f),
        legitimate,
        "the destination moved, so a premint in the same transaction would have landed at the attacker"
    );
}

#[test]
fn an_executed_change_cannot_be_replayed() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    expect_ok(set_inventory_as(&mut f, &admin, Pubkey::new_unique()), "bind");

    let target = Pubkey::new_unique();
    let (r, nonce) = propose_inventory_as(&mut f, &admin, target);
    expect_ok(r, "propose");
    let delay = f.config().admin_timelock_seconds as i64;
    f.warp(delay + 1);
    expect_ok(execute_inventory_as(&mut f, &admin, nonce, admin_key), "execute");

    // Execute closes the timelock account, so the replay fails on the account rather than on a flag.
    // Asserting the OUTCOME, not the error code, because "the account is gone" and "the slot is
    // empty" are both correct refusals and which one fires is an implementation detail.
    let replay = execute_inventory_as(&mut f, &admin, nonce, admin_key);
    assert!(replay.is_err(), "the executed change replayed");
    assert_eq!(inventory(&f), target, "the replay disturbed the wallet");
}

#[test]
fn a_change_cannot_be_executed_through_the_wrong_action_slot() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    expect_ok(set_inventory_as(&mut f, &admin, Pubkey::new_unique()), "bind");

    // Arm an inventory change, then try to drive it through a nonce that is not the armed one. The
    // handler binds to `config.pending_inventory_wallet_nonce`, so a stray nonce is a mismatch.
    let (r, nonce) = propose_inventory_as(&mut f, &admin, Pubkey::new_unique());
    expect_ok(r, "propose");
    let delay = f.config().admin_timelock_seconds as i64;
    f.warp(delay + 1);
    // Anchor's seed constraint fires before the handler, because no account exists at nonce+1. That
    // is a correct refusal and an earlier one than `NonceMismatch`; asserting the specific code here
    // would pin an implementation detail rather than the property. The property is that it fails and
    // the wallet does not move.
    let before = inventory(&f);
    assert!(
        execute_inventory_as(&mut f, &admin, nonce + 1, admin_key).is_err(),
        "executing a nonce that is not the armed one succeeded"
    );
    assert_eq!(inventory(&f), before, "a stray nonce moved the wallet");
    let _ = E_NONCE_MISMATCH;
}
