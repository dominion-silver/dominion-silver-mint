// The pre-mint DESTINATION, and why the redirect is not available:
// let ship.
// THE ATTACK, in the words of the report: the admin can `set_inventory_wallet(attacker)` and
// then `admin_premint(remaining cap headroom)` in the same block. The hard cap bounds how much can be
// taken; it provides no window in which anyone could see it coming and no way to stop it.
// 's fix kept the FIRST binding instant, on the argument that with the field unset
// `admin_premint` refuses outright and there is nothing to redirect. refuted that in :
// compromise the Ops key DURING the ceremony, before the legitimate binding, and the attacker binds
// their own wallet with no delay and no veto. "Nothing to steal" confused supply already minted with
// issuance power still available.
// OPTION A, what this file now pins. `inventory_wallet` is an argument of `initialize`, bound
// atomically with everything else and validated non-default. `set_inventory_wallet` is DELETED, not
// restricted: the instruction, its Accounts struct and its lib.rs entry are gone. The only writer
// left is `execute_set_inventory_wallet`, behind the 24h timelock and guardian-cancellable.
// WHAT THIS FILE DOES NOT CLOSE, and D11 is the answer to it: tokens already held by the LEGITIMATE
// destination. With redemptions open at launch, whoever holds that key redeems them into treasury
// USDC with no admin instruction and no timelock. That is custody, not program logic.

mod common;

use common::*;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

const E_TIMELOCK_NOT_ELAPSED: u32 = 12028;
const E_NONCE_MISMATCH: u32 = 12042;
const E_PROPOSAL_ALREADY_ACTIVE: u32 = 12044;
const E_CONSTRAINT_HAS_ONE: u32 = 2001;

// Appended at the end of the error enum, so this is one of the last codes in it.
const E_INVENTORY_UNCHANGED: u32 = 12123;

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

/// The fixture ships PAUSED, which is the launch posture. `execute_set_inventory_wallet` refuses a
/// redirect while paused ON PURPOSE: it would otherwise take effect the instant somebody unpauses,
/// which is exactly when nobody is watching this field. Tests that reach an execute therefore need a
/// live protocol, and the ones that do not deliberately keep the paused fixture.
/// going live is no longer one admin signature. `unpause` demands an active guardian
/// distinct from the admin, and the common helper installs one.
fn live() -> Fixture {
    let mut f = Fixture::new_bare();
    expect_ok(f.unpause(), "fixture: unpause");
    f
}

fn inventory(f: &Fixture) -> Pubkey {
    Pubkey::new_from_array(f.config().inventory_wallet)
}

// ---------------------------------------------------------------- the timelocked change
// There is no "first binding" section any more. `initialize` performs the first and only instant
// binding, and initialize.rs owns the proof of both halves: the readback of the requested key, and
// the refusal of the default pubkey. Everything below starts from a wallet the fixture already
// bound, which is exactly the state a real deployment is in the moment the ceremony ends.

#[test]
fn a_change_takes_a_proposal_the_full_delay_and_an_execute() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    // The wallet `initialize` bound. There is no instruction that could have put it there afterwards.
    let first = inventory(&f);
    assert_ne!(first, Pubkey::default(), "the fixture must start bound");
    let second = Pubkey::new_unique();

    let (r, nonce) = propose_inventory_as(&mut f, &admin, second);
    expect_ok(r, "propose the change");
    assert_eq!(
        f.config().pending_inventory_wallet_nonce,
        Some(nonce),
        "the config did not record the pending proposal"
    );
    // Proposing does NOT move the wallet. This is the observation window.
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
    let bound = inventory(&f);

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
    let first = inventory(&f);

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
    let first = inventory(&f);

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

/// A Token-2022 SILV token account for `owner`, written straight into the VM. `admin_premint` only
/// requires a well-formed account whose mint and owner it can read; nothing here needs the extensions,
/// and the base 165-byte body is a valid Token-2022 account.
fn place_silv_token_account(f: &mut Fixture, owner: &Pubkey) -> Pubkey {
    let mint = f.silv_mint;
    let addr = ata(&mint, owner, &pk(TOKEN_2022_PROGRAM));
    let mut body = vec![0u8; 165];
    body[0..32].copy_from_slice(mint.as_ref());
    body[32..64].copy_from_slice(owner.as_ref());
    body[64..72].copy_from_slice(&0u64.to_le_bytes()); // amount
    body[108] = 1; // AccountState::Initialized
    f.svm
        .set_account(
            addr,
            Account {
                lamports: 2_039_280,
                data: body,
                owner: pk(TOKEN_2022_PROGRAM),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    addr
}

/// Raw balance at a token account ADDRESS. The common `token_balance` derives the ATA from an owner,
/// and these tests already hold the address.
fn balance_at(f: &Fixture, addr: &Pubkey) -> u64 {
    f.svm
        .get_account(addr)
        .map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
        .unwrap_or(0)
}

fn premint_ix(f: &Fixture, destination_ata: Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(f.admin.pubkey(), true),
            AccountMeta::new(f.silv_mint, false),
            AccountMeta::new(destination_ata, false),
            AccountMeta::new_readonly(silv_mint_authority_pda(), false),
            AccountMeta::new_readonly(pk(TOKEN_2022_PROGRAM), false),
        ],
        data: ix_data("admin_premint", &amount.to_le_bytes()),
    }
}

#[test]
fn the_redirect_then_premint_pair_cannot_happen_in_one_block() {
    // THE scenario, assembled for real rather than argued about: one transaction carrying the
    // historical redirect discriminator followed by `admin_premint` of the cap headroom into the
    // attacker's ATA. Under option A the first instruction has no handler, so the transaction fails
    // atomically and the second one never runs.
    // The premint half is a REAL instruction with real accounts, and the test proves it separately:
    // the same premint into the LEGITIMATE destination succeeds. Without that control the test would
    // pass just as happily if `admin_premint` were broken for every destination.
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let legitimate = inventory(&f);
    let attacker = Pubkey::new_unique();
    let legit_ata = place_silv_token_account(&mut f, &legitimate);
    let attacker_ata = place_silv_token_account(&mut f, &attacker);
    let amount = 1_000_000u64;

    let mut redirect_data = anchor_disc("global:set_inventory_wallet").to_vec();
    redirect_data.extend_from_slice(attacker.as_ref());
    let redirect = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: redirect_data,
    };
    let steal = premint_ix(&f, attacker_ata, amount);

    let outcome = f.send(&[redirect, steal], &[&admin]);
    assert!(
        outcome.is_err(),
        "the redirect-then-premint pair landed in one transaction"
    );
    assert_eq!(
        inventory(&f),
        legitimate,
        "the destination moved, so the premint in the same transaction would have landed at the attacker"
    );
    assert_eq!(
        balance_at(&f, &attacker_ata),
        0,
        "SILV was issued to the attacker's account"
    );

    // The control: the premint itself works, into the destination `initialize` bound.
    let control = premint_ix(&f, legit_ata, amount);
    expect_ok(
        f.send(&[control], &[&admin]),
        "admin_premint into the configured inventory wallet",
    );
    assert_eq!(
        balance_at(&f, &legit_ata),
        amount,
        "the control premint issued nothing, so the negative above proves nothing"
    );
}

#[test]
fn an_executed_change_cannot_be_replayed() {
    let mut f = live();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();

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

// ================================================================ OPTION A
// RED PHASE FIRST. These scenarios are written against `1314be4`, WITHOUT the production fix, and
// they must fail on their RESULT rather than on a missing symbol. common proof rule is
// explicit: "une erreur de compilation causee seulement par un import de symbole qui n existe pas
// n est pas suffisante". So neither test names a field or an instruction that does not exist yet.
// Both build raw instruction data and send it to the REAL `.so` through LiteSVM, then read
// `ConfigAccount` back. That is the only way to prove what the dispatcher does, and says so:
// "un simple `rg` n est pas la preuve rouge principale".

/// Anchor's 8-byte discriminator for a global instruction, `sha256("global:<name>")[..8]`. Written
/// out here rather than imported so this test keeps working after the instruction is deleted: the
/// whole point is to send bytes the program should no longer answer.
fn legacy_set_inventory_disc() -> [u8; 8] {
    anchor_disc("global:set_inventory_wallet")
}

#[test]
fn option_a_the_removed_instant_setter_discriminator_is_not_dispatched() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let target = Pubkey::new_unique();
    let before = inventory(&f);

    // The historical 8 bytes, plus a 32-byte pubkey argument, straight at the dispatcher.
    let mut data = legacy_set_inventory_disc().to_vec();
    data.extend_from_slice(target.as_ref());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data,
    };
    let outcome = f.send(&[ix], &[&admin]);

    assert!(
        outcome.is_err(),
        "FAIL: the legacy set_inventory_wallet discriminator is still dispatched successfully"
    );
    assert_eq!(
        inventory(&f),
        before,
        "FAIL: the legacy discriminator mutated ConfigAccount"
    );
}

#[test]
fn option_a_initialize_binds_the_inventory_wallet_atomically() {
    // A fixture is already initialized, so the question this asks is simply: after the one and only
    // `initialize`, is a non-default inventory wallet bound? Under option A it is, because the
    // address is an argument. Today it is not, because the field is only reachable through the
    // instant setter that option A deletes.
    let f = Fixture::new();
    assert_ne!(
        inventory(&f),
        Pubkey::default(),
        "FAIL: initialize did not atomically bind the requested inventory wallet"
    );
}
