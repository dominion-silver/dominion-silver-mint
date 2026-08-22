// On-chain tests for the admin-transfer state machine, the timelock lifecycle and the two
// counter subtractions in the guardian path. Every assertion reads an account back OUT of the VM:
// a handover that reports success and leaves config.admin untouched is invisible to a unit test.

mod common;

use borsh::{BorshDeserialize, BorshSerialize};
use common::*;
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- codes and constants

const E_ARITHMETIC_OVERFLOW: u32 = 12018;
const E_INVALID_PENDING_ADMIN: u32 = 12020;
const E_PENDING_ADMIN_EXPIRED: u32 = 12021;
const E_TIMELOCK_NOT_ELAPSED: u32 = 12028;
const E_NONCE_MISMATCH: u32 = 12042;
const E_PROPOSAL_NO_OP: u32 = 12043;
const E_PROPOSAL_ALREADY_ACTIVE: u32 = 12044;

const PENDING_ADMIN_EXPIRY_SECONDS: i64 = 7 * 86_400;

const CONFIG_DISC: &str = "account:ConfigAccount";
const TL_DISC: &str = "account:TimelockQueueAccount";

// ---------------------------------------------------------------- account mirrors

/// Mirror of `state::timelock::TimelockQueueAccount`. The account is allocated at a fixed SIZE and
/// the borsh body is shorter, so the tail is padding and is deliberately not compared.
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

fn decode<T: BorshDeserialize>(data: &[u8], disc_preimage: &str, what: &str) -> T {
    assert!(data.len() >= 8, "{what}: too short for a discriminator");
    assert_eq!(
        &data[..8],
        &anchor_disc(disc_preimage),
        "{what}: wrong account discriminator"
    );
    T::deserialize(&mut &data[8..]).unwrap_or_else(|e| {
        panic!("{what}: borsh decode failed ({e}); the on-chain layout drifted from the mirror")
    })
}

fn read_timelock(f: &Fixture, nonce: u64) -> Option<Timelock> {
    let acc = f.svm.get_account(&timelock_pda(nonce))?;
    if acc.lamports == 0 || acc.data.len() < 8 {
        return None;
    }
    Some(decode(&acc.data, TL_DISC, "TimelockQueueAccount"))
}

fn place(f: &mut Fixture, key: Pubkey, model: &Account, disc: &str, body: Vec<u8>) {
    let mut data = anchor_disc(disc).to_vec();
    data.extend_from_slice(&body);
    assert!(data.len() <= model.data.len(), "the edited body outgrew the account");
    data.resize(model.data.len(), 0);
    f.svm
        .set_account(
            key,
            Account {
                lamports: model.lamports,
                data,
                owner: model.owner,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

/// Write a TimelockQueueAccount at `to_nonce` by copying `from_nonce` and applying `edit`. Cancelled
/// and nonce-mismatched proposals are reachable on chain but no instruction can produce them here,
/// because both cancel and execute close the account, so they are placed directly.
fn clone_timelock(f: &mut Fixture, from_nonce: u64, to_nonce: u64, edit: impl FnOnce(&mut Timelock)) {
    let src = f
        .svm
        .get_account(&timelock_pda(from_nonce))
        .expect("the source timelock account does not exist");
    let mut tl: Timelock = decode(&src.data, TL_DISC, "TimelockQueueAccount");
    edit(&mut tl);
    place(f, timelock_pda(to_nonce), &src, TL_DISC, borsh::to_vec(&tl).unwrap());
}

/// Edit the live ConfigAccount in place. Only used to DESYNC a counter, which is the state the two
/// checked_sub calls exist to catch and which no instruction sequence can reach.
fn edit_config(f: &mut Fixture, edit: impl FnOnce(&mut Config)) {
    let src = f.svm.get_account(&config_pda()).expect("the config does not exist");
    let mut c = f.config();
    edit(&mut c);
    place(f, config_pda(), &src, CONFIG_DISC, borsh::to_vec(&c).unwrap());
}

fn now(f: &Fixture) -> i64 {
    let clock: solana_sdk::clock::Clock = f.svm.get_sysvar();
    clock.unix_timestamp
}

/// A funded keypair the fixture does not already own.
fn funded(f: &mut Fixture) -> Keypair {
    let k = Keypair::new();
    f.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}

// ---------------------------------------------------------------- instructions

/// Anchor's encoding for `None` in an optional account slot is the PROGRAM ID in that position.
fn optional(slot: Option<Pubkey>) -> Pubkey {
    slot.unwrap_or_else(program_id)
}

fn propose_transfer_as(f: &mut Fixture, signer: &Keypair, new_admin: Pubkey) -> TxOutcome {
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

fn propose_transfer(f: &mut Fixture, new_admin: Pubkey) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    propose_transfer_as(f, &admin, new_admin)
}

fn accept_transfer_as(f: &mut Fixture, signer: &Keypair) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data("accept_admin_transfer", &[]),
    };
    f.send(&[ix], &[signer])
}

fn cancel_transfer_as(f: &mut Fixture, signer: &Keypair, guardian_slot: Option<Pubkey>) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(optional(guardian_slot), false),
        ],
        data: ix_data("cancel_admin_transfer", &[]),
    };
    f.send(&[ix], &[signer])
}

/// routed through the common helper, which installs the independent guardian `unpause` now
/// demands. Callers in this file MUST install it while the ORIGINAL admin still holds the office:
/// `add_guardian` is `has_one = admin`, so an appointment attempted after a handover is refused.
fn unpause_as(f: &mut Fixture, signer: &Keypair) -> TxOutcome {
    f.unpause_as(signer)
}

/// the appointee co-signs, so this takes the Keypair rather than the Pubkey.
fn add_guardian(f: &mut Fixture, g: &Keypair) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(guardian_pda(&g.pubkey()), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("add_guardian", g.pubkey().as_ref()),
    };
    f.send(&[ix], &[&admin])
}

fn remove_guardian(f: &mut Fixture, g: Pubkey) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(guardian_pda(&g), false),
        ],
        data: ix_data("remove_guardian", g.as_ref()),
    };
    f.send(&[ix], &[&admin])
}

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

fn cancel_timelocked_as(
    f: &mut Fixture,
    signer: &Keypair,
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
            AccountMeta::new_readonly(program_id(), false),
        ],
        data: ix_data("cancel_timelocked_action", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

// ---------------------------------------------------------------- propose

#[test]
fn propose_admin_transfer_is_admin_only_and_arms_a_delayed_window() {
    let mut f = Fixture::new();
    let incoming = funded(&mut f);
    let stranger = f.stranger.insecure_clone();
    let admin_key = f.admin.pubkey();

    // Anyone able to queue a handover blocks every legitimate one for the whole expiry window.
    expect_error(
        propose_transfer_as(&mut f, &stranger, stranger.pubkey()),
        E_CONSTRAINT_HAS_ONE,
        "propose_admin_transfer by a stranger",
    );
    assert_eq!(f.config().pending_admin, None, "a refused propose armed the slot");

    // A no-op handover would occupy the single pending slot for seven days for nothing.
    expect_error(
        propose_transfer(&mut f, admin_key),
        E_PROPOSAL_NO_OP,
        "propose the admin already in place",
    );
    expect_error(
        propose_transfer(&mut f, Pubkey::default()),
        E_INVALID_PENDING_ADMIN,
        "propose the zero pubkey",
    );
    assert_eq!(f.config().pending_admin, None);

    let t0 = now(&f);
    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "propose the handover");
    let c = f.config();
    assert_eq!(
        c.pending_admin,
        Some(incoming.pubkey().to_bytes()),
        "propose did not persist pending_admin"
    );
    // The eta IS the guardian veto window. eta == now collapses it and the handover is instant.
    assert_eq!(
        c.pending_admin_eta,
        t0 + ADMIN_TIMELOCK_SECONDS as i64,
        "pending_admin_eta is not now + admin_timelock_seconds"
    );
    assert_eq!(
        c.pending_admin_expires_at,
        t0 + ADMIN_TIMELOCK_SECONDS as i64 + PENDING_ADMIN_EXPIRY_SECONDS,
        "the accept window is not a full expiry window wide"
    );
    assert_eq!(c.admin_key(), admin_key, "propose moved the live admin");
}

#[test]
fn a_live_pending_transfer_may_not_be_overwritten_but_an_expired_one_may() {
    let mut f = Fixture::new();
    let (a, b) = (funded(&mut f), funded(&mut f));
    expect_ok(propose_transfer(&mut f, a.pubkey()), "propose A");
    let armed = f.config();

    // Replacing the announced key without a new window retargets the handover under the guardians.
    expect_error(
        propose_transfer(&mut f, b.pubkey()),
        E_PROPOSAL_ALREADY_ACTIVE,
        "propose B over a live pending transfer",
    );
    let c = f.config();
    assert_eq!(c.pending_admin, Some(a.pubkey().to_bytes()), "the pending key moved");
    assert_eq!(c.pending_admin_eta, armed.pending_admin_eta, "the eta moved");
    assert_eq!(
        c.pending_admin_expires_at, armed.pending_admin_expires_at,
        "the expiry moved"
    );

    // Once the window has lapsed the slot is free again, or a stale proposal locks it forever.
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + PENDING_ADMIN_EXPIRY_SECONDS + 1);
    let t1 = now(&f);
    expect_ok(propose_transfer(&mut f, b.pubkey()), "propose B after the expiry");
    let c = f.config();
    assert_eq!(c.pending_admin, Some(b.pubkey().to_bytes()), "the replacement did not land");
    assert_eq!(c.pending_admin_eta, t1 + ADMIN_TIMELOCK_SECONDS as i64);
}

// ---------------------------------------------------------------- accept

#[test]
fn the_transfer_lifecycle_refuses_an_early_accept_then_moves_the_admin_on_chain() {
    let mut f = Fixture::new();
    let incoming = funded(&mut f);
    let old_admin = f.admin.insecure_clone();
    // the unpause guardian is appointed HERE, before the handover, because `add_guardian` is
    // admin-only and the old admin is about to lose that office. The unpause assertions at the end of
    // this test are about who may CALL unpause, not about who may appoint.
    f.ensure_unpause_guardian();
    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "propose the handover");

    // FIX B: without the eta gate a compromised admin proposes and accepts in the same block and
    // the guardians never see the window they exist to veto in.
    expect_error(
        accept_transfer_as(&mut f, &incoming),
        E_TIMELOCK_NOT_ELAPSED,
        "accept in the same block as the propose",
    );
    assert_eq!(f.config().admin_key(), old_admin.pubkey(), "an early accept moved the admin");

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 - 1);
    expect_error(
        accept_transfer_as(&mut f, &incoming),
        E_TIMELOCK_NOT_ELAPSED,
        "accept one second early",
    );
    assert_eq!(f.config().admin_key(), old_admin.pubkey());

    f.warp(1);
    expect_ok(accept_transfer_as(&mut f, &incoming), "accept at the eta");
    let c = f.config();
    assert_eq!(c.admin_key(), incoming.pubkey(), "accept did not persist the new admin");
    assert_eq!(c.pending_admin, None, "accept left the pending slot armed");
    assert_eq!(c.pending_admin_eta, 0, "accept left the eta set");
    assert_eq!(c.pending_admin_expires_at, 0, "accept left the expiry set");

    // The handover is only real if the old key actually lost its powers and the new one has them.
    expect_error(
        unpause_as(&mut f, &old_admin),
        E_CONSTRAINT_HAS_ONE,
        "the old admin still holds an admin-only instruction",
    );
    assert!(f.config().paused, "a refused unpause resumed the protocol");
    expect_ok(unpause_as(&mut f, &incoming), "the new admin holds the admin powers");
    assert!(!f.config().paused);

    // And the consumed proposal cannot be replayed.
    expect_error(
        accept_transfer_as(&mut f, &incoming),
        E_INVALID_PENDING_ADMIN,
        "accept replayed after the slot was cleared",
    );
}

#[test]
fn only_the_announced_successor_may_accept() {
    let mut f = Fixture::new();
    let incoming = funded(&mut f);
    let stranger = f.stranger.insecure_clone();
    let old_admin = f.admin.pubkey();

    // No pending transfer at all: the Option unwrap is the first gate.
    expect_error(
        accept_transfer_as(&mut f, &stranger),
        E_INVALID_PENDING_ADMIN,
        "accept with nothing pending",
    );

    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "propose the handover");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    // Without the pending == signer bind the announced successor stops being the one who lands.
    expect_error(
        accept_transfer_as(&mut f, &stranger),
        E_INVALID_PENDING_ADMIN,
        "accept signed by a wallet that is not the announced successor",
    );
    let c = f.config();
    assert_eq!(c.admin_key(), old_admin, "a stranger's accept moved the admin");
    assert_eq!(
        c.pending_admin,
        Some(incoming.pubkey().to_bytes()),
        "a refused accept consumed the pending slot"
    );

    expect_ok(accept_transfer_as(&mut f, &incoming), "the announced successor accepts");
    assert_eq!(f.config().admin_key(), incoming.pubkey());
}

#[test]
fn a_pending_transfer_stops_being_acceptable_once_it_expires() {
    let mut f = Fixture::new();
    let incoming = funded(&mut f);
    let old_admin = f.admin.pubkey();
    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "propose the handover");
    let expires_at = f.config().pending_admin_expires_at;

    // One second past the window a years-old announcement must be dead, not a stored takeover.
    f.warp(expires_at + 1 - now(&f));
    expect_error(
        accept_transfer_as(&mut f, &incoming),
        E_PENDING_ADMIN_EXPIRED,
        "accept one second after the expiry",
    );
    let c = f.config();
    assert_eq!(c.admin_key(), old_admin, "an expired accept moved the admin");
    assert_eq!(
        c.pending_admin,
        Some(incoming.pubkey().to_bytes()),
        "a refused accept cleared the pending slot"
    );

    // The bound itself: a fresh proposal accepted at exactly expires_at must still land, or the
    // refusal above would also pass with the window a second too short.
    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "re-propose after the expiry");
    let expires_at = f.config().pending_admin_expires_at;
    f.warp(expires_at - now(&f));
    expect_ok(accept_transfer_as(&mut f, &incoming), "accept at exactly expires_at");
    assert_eq!(f.config().admin_key(), incoming.pubkey());
}

// ---------------------------------------------------------------- cancel

#[test]
fn cancel_admin_transfer_is_admin_or_guardian_only() {
    let mut f = Fixture::new();
    let g = funded(&mut f);
    expect_ok(add_guardian(&mut f, &g), "add_guardian");
    let incoming = funded(&mut f);
    let stranger = f.stranger.insecure_clone();
    let admin = f.admin.insecure_clone();
    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "propose the handover");
    let armed = f.config();

    // A permissionless cancel means no handover can ever complete.
    expect_error(
        cancel_transfer_as(&mut f, &stranger, None),
        E_UNAUTHORIZED,
        "cancel_admin_transfer by a stranger",
    );
    expect_error(
        cancel_transfer_as(&mut f, &incoming, None),
        E_UNAUTHORIZED,
        "cancel_admin_transfer by the incoming admin",
    );
    let c = f.config();
    assert_eq!(c.pending_admin, armed.pending_admin, "a refused cancel disarmed the slot");
    assert_eq!(c.pending_admin_eta, armed.pending_admin_eta);

    // The guardian veto during the delay window is the point of the delay.
    expect_ok(
        cancel_transfer_as(&mut f, &g, Some(guardian_pda(&g.pubkey()))),
        "cancel by an active guardian",
    );
    let c = f.config();
    assert_eq!(c.pending_admin, None, "the guardian cancel did not clear pending_admin");
    assert_eq!(c.pending_admin_eta, 0, "the guardian cancel left the eta set");
    assert_eq!(c.pending_admin_expires_at, 0, "the guardian cancel left the expiry set");

    // A vetoed successor must not be able to accept afterwards.
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        accept_transfer_as(&mut f, &incoming),
        E_INVALID_PENDING_ADMIN,
        "accept a cancelled handover",
    );
    assert_eq!(f.config().admin_key(), admin.pubkey());

    // The admin arm of the same check.
    expect_ok(propose_transfer(&mut f, incoming.pubkey()), "re-propose after the veto");
    expect_ok(cancel_transfer_as(&mut f, &admin, None), "cancel by the admin");
    assert_eq!(f.config().pending_admin, None);
}

// ------------------------------------------------- the sweeper that could not sweep

// Two tests lived here, for `close_timelock_account`. Both had to FABRICATE
// their subject with `clone_timelock(.., |tl| tl.cancelled = true)`, under the comment "Cancel closes
// the account, so that state is placed directly". That comment was written down and not
// read: the instruction required `cancelled || executed_at.is_some`, and every writer of either
// field closes the account in the same transaction, so no live account could ever satisfy it. The
// instruction is deleted. What replaces the two tests is the invariant that makes it unnecessary,
// asserted against real state instead of placed state.
#[test]
fn cancelling_a_proposal_closes_its_account_so_no_orphan_is_left_to_sweep() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    let (r, nonce) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");
    assert!(read_timelock(&f, nonce).is_some(), "the proposal was not created");

    expect_ok(cancel_timelocked_as(&mut f, &admin, nonce, admin_key), "cancel");

    // The account is GONE, not merely flagged. This is why a rent sweeper had nothing to reclaim.
    assert!(
        read_timelock(&f, nonce).is_none(),
        "cancel left the account behind: a sweeper is needed again, and so is this test's premise"
    );
}

// ---------------------------------------------------------------- cancel_timelocked_action nonce

#[test]
fn cancel_timelocked_action_binds_the_stored_nonce_to_the_argument() {
    let mut f = Fixture::new();
    let admin = f.admin.insecure_clone();
    let admin_key = admin.pubkey();
    let (r, live) = propose_premium_mint(&mut f, 200);
    expect_ok(r, "propose");

    // An account whose stored nonce drifted from its own seed. The seed is the only other thing
    // binding the account to the argument, so this require is what catches the drift.
    clone_timelock(&mut f, live, live, |tl| tl.nonce = live + 7);
    expect_error(
        cancel_timelocked_as(&mut f, &admin, live, admin_key),
        E_NONCE_MISMATCH,
        "cancel an account whose stored nonce is not the argument",
    );
    let c = f.config();
    assert_eq!(c.pending_premium_mint_nonce, Some(live), "the refused cancel disarmed the slot");
    assert_eq!(c.active_proposal_count, 1, "the refused cancel released the budget");
    assert!(read_timelock(&f, live).is_some(), "the refused cancel closed the account");

    // Positive control: the same call on a consistent account succeeds.
    clone_timelock(&mut f, live, live, |tl| tl.nonce = live);
    expect_ok(
        cancel_timelocked_as(&mut f, &admin, live, admin_key),
        "cancel a consistent account",
    );
    assert_eq!(f.config().pending_premium_mint_nonce, None);
}

// ---------------------------------------------------------------- guardian counter subtractions

#[test]
fn finalize_removal_refuses_a_desynced_pending_counter() {
    let mut f = Fixture::new();
    let (g1, g2) = (funded(&mut f), funded(&mut f));
    expect_ok(add_guardian(&mut f, &g1), "add g1");
    expect_ok(add_guardian(&mut f, &g2), "add g2");
    let payer = funded(&mut f);
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");
    assert_eq!(f.config().pending_removal_count, 1);

    // The desync no instruction can produce: a notice armed on the guardian, nothing counted on the
    // config. checked_sub is deliberate here, so the transaction must abort rather than clamp.
    edit_config(&mut f, |c| c.pending_removal_count = 0);
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_error(
        finalize_removal(&mut f, &payer, g1.pubkey()),
        E_ARITHMETIC_OVERFLOW,
        "finalize against a pending_removal_count that is already zero",
    );
    let c = f.config();
    // 3, not 2: `initialize` appointed the fixture's own guardian before these two.
    assert_eq!(c.guardian_count, 3, "the aborted finalize shrank the set anyway");
    assert_eq!(c.pending_removal_count, 0);

    // Positive control: with the counter back in sync the same finalize lands.
    edit_config(&mut f, |c| c.pending_removal_count = 1);
    expect_ok(finalize_removal(&mut f, &payer, g1.pubkey()), "finalize g1");
    let c = f.config();
    assert_eq!(c.guardian_count, 2, "finalize did not persist the decrement");
    assert_eq!(c.pending_removal_count, 0);
}

#[test]
fn cancel_removal_refuses_a_desynced_pending_counter() {
    let mut f = Fixture::new();
    let (g1, g2) = (funded(&mut f), funded(&mut f));
    expect_ok(add_guardian(&mut f, &g1), "add g1");
    expect_ok(add_guardian(&mut f, &g2), "add g2");
    let admin = f.admin.insecure_clone();
    expect_ok(remove_guardian(&mut f, g1.pubkey()), "notice g1");

    // Same shape on the cancel path: clamping to zero would hide the desync and leave the config
    // counter permanently wrong, which the removal floor then reads.
    edit_config(&mut f, |c| c.pending_removal_count = 0);
    expect_error(
        cancel_removal_as(&mut f, &admin, g1.pubkey()),
        E_ARITHMETIC_OVERFLOW,
        "cancel against a pending_removal_count that is already zero",
    );
    assert_eq!(f.config().pending_removal_count, 0);

    edit_config(&mut f, |c| c.pending_removal_count = 1);
    expect_ok(cancel_removal_as(&mut f, &admin, g1.pubkey()), "cancel the notice");
    assert_eq!(f.config().pending_removal_count, 0, "cancel did not persist the decrement");
}
