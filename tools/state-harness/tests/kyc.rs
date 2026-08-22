// On-chain tests for the KYC gate. Every assertion here reads an account back OUT of the VM after a
// real transaction. The 158 unit tests all call pure functions in src/state/, so none of them can see
// a handler that computed the right value and failed to persist it, an Anchor constraint that was
// deleted, or a write that Anchor discarded because the account lost its `mut`.

mod common;

use common::*;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;

#[test]
fn attest_increments_the_roster_counter_on_chain() {
    let mut f = Fixture::new();
    let holder = f.holder.pubkey();
    assert_eq!(f.config().kyc_attestation_count, 0);

    expect_ok(f.attest(holder), "attest_kyc");

    // THE test for the P0 that shipped: without `mut` on AttestKyc.config the increment is computed
    // and silently discarded, the instruction still returns Ok and still emits KycAttested, and the
    // gate can never be armed.
    assert_eq!(
        f.config().kyc_attestation_count,
        1,
        "attest_kyc did not persist the roster increment"
    );

    let row = f.kyc(&holder).expect("the KycAccount must exist");
    assert_eq!(row.wallet_key(), holder, "KycAccount.wallet");
    assert_eq!(row.attestor_key(), f.attestor.pubkey(), "KycAccount.attestor");
    assert_eq!(row.version, 1, "KycAccount.version");
    assert_eq!(row.approved_at, NOW_SECS, "KycAccount.approved_at");
}

#[test]
fn re_attesting_the_same_wallet_does_not_inflate_the_counter() {
    let mut f = Fixture::new();
    let holder = f.holder.pubkey();
    expect_ok(f.attest(holder), "first attest");
    expect_ok(f.attest(holder), "replayed attest");
    expect_ok(f.attest(holder), "replayed attest again");

    // A backend replaying its queue must not be able to arm the gate against a roster of one.
    assert_eq!(
        f.config().kyc_attestation_count,
        1,
        "replaying attest_kyc inflated the roster counter"
    );

    // A second, distinct wallet does count.
    let holder2 = f.holder2.pubkey();
    expect_ok(f.attest(holder2), "attest a second wallet");
    assert_eq!(f.config().kyc_attestation_count, 2);
}

#[test]
fn attesting_the_zero_pubkey_is_refused() {
    let mut f = Fixture::new();
    // A subject nobody can sign as would satisfy arming's `count > 0` while admitting nobody.
    expect_error(
        f.attest(Pubkey::default()),
        E_KYC_SUBJECT_INVALID,
        "attest_kyc(Pubkey::default())",
    );
    assert_eq!(f.config().kyc_attestation_count, 0);
    assert!(f.kyc(&Pubkey::default()).is_none());
}

#[test]
fn only_the_attestor_may_attest() {
    let mut f = Fixture::new();
    let holder = f.holder.pubkey();
    let stranger = f.stranger.insecure_clone();
    expect_error(
        f.attest_as(&stranger, holder, [0u8; 32]),
        E_UNAUTHORIZED,
        "attest_kyc signed by a stranger",
    );
    assert_eq!(f.config().kyc_attestation_count, 0);
    assert!(f.kyc(&holder).is_none());
}

#[test]
fn arming_the_gate_requires_an_attestor_and_a_non_empty_roster() {
    // No attestor configured: the arming rule checks the operator before the roster.
    let mut bare = Fixture::new_bare();
    expect_error(
        bare.set_kyc_scope(SIDE_ALL_BITS),
        E_KYC_ATTESTOR_NOT_SET,
        "arming with no attestor",
    );
    assert_eq!(bare.config().kyc_scope_flags, 0);

    let mut f = Fixture::new();
    expect_error(
        f.set_kyc_scope(SIDE_ALL_BITS),
        E_KYC_NO_ATTESTATIONS_YET,
        "arming with an empty roster",
    );
    expect_error(
        f.set_kyc_scope(0xFF),
        E_KYC_SCOPE_INVALID,
        "arming with undefined Side bits",
    );
    let c = f.config();
    assert_eq!(c.kyc_scope_flags, 0, "a refused arming must not move the gate");
    assert!(!c.kyc_enforced);

    expect_ok(f.attest(f.holder.pubkey()), "attest before arming");
    expect_ok(f.set_kyc_scope(SIDE_MINT_BIT), "arm the mint side");
    let c = f.config();
    assert_eq!(c.kyc_scope_flags, SIDE_MINT_BIT, "set_kyc_scope did not persist the flags");
    assert!(c.kyc_enforced, "kyc_enforced is derived from the flags and must follow them");

    // Disarming is the only unbrick path, and it must move BOTH fields back.
    expect_ok(f.set_kyc_scope(0), "disarm");
    let c = f.config();
    assert_eq!(c.kyc_scope_flags, 0);
    assert!(!c.kyc_enforced, "kyc_enforced must be false once the flags are 0");
}

#[test]
fn only_the_admin_may_change_the_scope() {
    let mut f = Fixture::new();
    expect_ok(f.attest(f.holder.pubkey()), "attest");
    let attestor = f.attestor.insecure_clone();
    let stranger = f.stranger.insecure_clone();
    expect_error(
        f.set_kyc_scope_as(&stranger, SIDE_ALL_BITS),
        E_CONSTRAINT_HAS_ONE,
        "set_kyc_scope signed by a stranger",
    );
    // The hot attestor key must not be able to arm or disarm the gate it feeds.
    expect_error(
        f.set_kyc_scope_as(&attestor, SIDE_ALL_BITS),
        E_CONSTRAINT_HAS_ONE,
        "set_kyc_scope signed by the attestor",
    );
    assert_eq!(f.config().kyc_scope_flags, 0);
}

#[test]
fn revoke_decrements_the_counter_and_closes_the_account() {
    let mut f = Fixture::new();
    let holder = f.holder.pubkey();
    let holder2 = f.holder2.pubkey();
    expect_ok(f.attest(holder), "attest holder");
    expect_ok(f.attest(holder2), "attest holder2");
    expect_ok(f.set_kyc_scope(SIDE_ALL_BITS), "arm both sides");
    assert_eq!(f.config().kyc_attestation_count, 2);

    let attestor = f.attestor.insecure_clone();
    expect_ok(f.revoke_as(&attestor, holder, false), "revoke holder");

    let c = f.config();
    assert_eq!(c.kyc_attestation_count, 1, "revoke_kyc did not persist the decrement");
    // A revocation that does NOT empty the roster must leave the gate exactly where it was, and the
    // derived pair must still agree.
    assert_eq!(c.kyc_scope_flags, SIDE_ALL_BITS, "a non-final revoke moved the scope");
    assert!(c.kyc_enforced, "kyc_enforced disagrees with kyc_scope_flags");

    assert!(f.kyc(&holder).is_none(), "the KycAccount was not closed");
    assert!(f.kyc(&holder2).is_some(), "the wrong KycAccount was closed");
}

#[test]
fn only_the_attestor_or_the_admin_may_revoke() {
    let mut f = Fixture::new();
    let holder = f.holder.pubkey();
    expect_ok(f.attest(holder), "attest");
    let stranger = f.stranger.insecure_clone();
    expect_error(
        f.revoke_as(&stranger, holder, false),
        E_UNAUTHORIZED,
        "revoke_kyc signed by a stranger",
    );
    assert_eq!(f.config().kyc_attestation_count, 1);
    assert!(f.kyc(&holder).is_some(), "a refused revoke closed the account anyway");
}

#[test]
fn the_last_revoke_while_armed_needs_the_admin_and_explicit_consent() {
    let mut f = Fixture::new();
    let holder = f.holder.pubkey();
    expect_ok(f.attest(holder), "attest the only holder");
    expect_ok(f.set_kyc_scope(SIDE_ALL_BITS), "arm both sides");

    let attestor = f.attestor.insecure_clone();
    let admin = f.admin.insecure_clone();

    // The hot attestor key must not gain a one-transaction "drop the gate for everybody".
    expect_error(
        f.revoke_as(&attestor, holder, true),
        E_KYC_LAST_ATTESTATION_WHILE_ARMED,
        "the attestor revoking the last holder",
    );
    // The admin can, but only having said so in the signed message.
    expect_error(
        f.revoke_as(&admin, holder, false),
        E_KYC_REVOKE_WOULD_DISARM,
        "the admin revoking the last holder without allow_disarm",
    );
    let c = f.config();
    assert_eq!(c.kyc_attestation_count, 1, "a refused revoke moved the counter");
    assert_eq!(c.kyc_scope_flags, SIDE_ALL_BITS, "a refused revoke moved the scope");

    expect_ok(
        f.revoke_as(&admin, holder, true),
        "the admin revoking the last holder with allow_disarm",
    );
    let c = f.config();
    assert_eq!(c.kyc_attestation_count, 0);
    // The design calls "armed gate, empty roster" unreachable. This is where that is enforced.
    assert_eq!(c.kyc_scope_flags, 0, "the consented last-holder disarm did not happen");
    assert!(!c.kyc_enforced, "kyc_enforced disagrees with kyc_scope_flags after the disarm");
    assert!(f.kyc(&holder).is_none());
}

#[test]
fn the_attestor_key_may_be_rotated_but_not_to_the_admin_nor_cleared_while_armed() {
    let mut f = Fixture::new();
    let admin_key = f.admin.pubkey();
    let attestor_key = f.attestor.pubkey();
    // Fixture::new rotated the attestor in; prove the write landed rather than trusting the Ok.
    assert_eq!(
        f.config().kyc_operator_key(),
        attestor_key,
        "set_kyc_operator did not persist the new attestor"
    );

    let stranger = f.stranger.insecure_clone();
    expect_error(
        f.set_kyc_operator_as(&stranger, stranger.pubkey()),
        E_CONSTRAINT_HAS_ONE,
        "set_kyc_operator signed by a stranger",
    );
    // The hot/cold split, the admin-only revoke disarm and "a leaked attestor cannot loosen
    // compliance" all rest on these being different keys.
    expect_error(
        f.set_kyc_operator(admin_key),
        E_KYC_OPERATOR_MAY_NOT_BE_ADMIN,
        "set_kyc_operator(admin)",
    );

    expect_ok(f.attest(f.holder.pubkey()), "attest");
    expect_ok(f.set_kyc_scope(SIDE_MINT_BIT), "arm");
    // Clearing while armed would shut out every not-yet-attested holder with no on-chain remedy.
    expect_error(
        f.set_kyc_operator(Pubkey::default()),
        E_KYC_OPERATOR_REQUIRED_WHILE_ARMED,
        "clearing the attestor while armed",
    );
    assert_eq!(
        f.config().kyc_operator_key(),
        attestor_key,
        "a refused rotation changed the attestor anyway"
    );

    expect_ok(f.set_kyc_scope(0), "disarm first");
    expect_ok(f.set_kyc_operator(Pubkey::default()), "decommission the attestor");
    assert_eq!(
        f.config().kyc_operator_key(),
        Pubkey::default(),
        "decommissioning the attestor did not persist"
    );
}

#[test]
fn a_dormant_gate_lets_a_wallet_mint_with_no_attestation_supplied() {
    let mut f = Fixture::new();
    f.open_public_mint();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);
    assert_eq!(f.config().kyc_scope_flags, 0, "the launch posture is a dormant gate");

    // The Lazer program account is deliberately not executable, so the oracle read (the step AFTER
    // the gate) is what fails. That specific code is the proof the gate let the call through: a
    // client must not have to branch on config while the gate is dormant.
    expect_error(
        f.try_mint(&holder, false),
        E_LAZER_PROGRAM_NOT_EXECUTABLE,
        "mint_silv with a dormant gate and no KycAccount",
    );

    expect_ok(f.attest(holder.pubkey()), "attest the holder");
    expect_ok(f.set_kyc_scope(SIDE_MINT_BIT), "arm the mint side");

    // Armed: the same call is now denied, because the attestation was not supplied.
    expect_error(
        f.try_mint(&holder, false),
        E_KYC_REQUIRED,
        "mint_silv with an armed gate and no KycAccount",
    );

    // Armed, attestation supplied: through the gate again. This is what fails if attest_kyc creates
    // a row whose `wallet` is not written, since KycAccount::attests would then reject the holder.
    expect_error(
        f.try_mint(&holder, true),
        E_LAZER_PROGRAM_NOT_EXECUTABLE,
        "mint_silv with an armed gate and the KycAccount supplied",
    );
}
