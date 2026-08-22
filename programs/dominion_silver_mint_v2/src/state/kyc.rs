use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::side::{side_flags_valid_allow_empty, Side};

/// Current KycAccount schema.
pub const KYC_ACCOUNT_VERSION: u8 = 1;

// PII RULE, not negotiable. Nothing here identifies a person, and that includes a HASH of identifying data:
// an email hash is reversed by brute force, the input space is small. `reference` holds a hash of the
// PROVIDER'S INTERNAL RECORD ID, meaningless without the provider's own database. On-chain data is permanent
// and world-readable, so no GDPR erasure is possible: this is the part that is unfixable if it is got wrong.
// The off-chain side must supply the wallet, that record id, and PROOF THAT THE APPROVED PERSON CONTROLS THAT
// WALLET (signed nonce, verified before attesting). A provider verifies a person, not a wallet, and this
// program cannot check that step, so without it the gate is decorative.
// Ships DORMANT (`config.kyc_scope_flags == 0`). Write attestations BEFORE arming, or every existing holder
// is locked out instantly. The design is provider-agnostic: the program stores attestations, not identity.
/// A per-wallet KYC attestation. The account existing IS the approval. Never holds PII.
#[account]
pub struct KycAccount {
    /// The approved wallet. Always equals the PDA seed; re-checked in `attests`.
    pub wallet: Pubkey,
    pub approved_at: i64,
    /// The key that wrote this record. Per record, so rotating the operator does not reassign past approvals.
    pub attestor: Pubkey,
    /// Hash of the PROVIDER'S RECORD ID, never PII. All-zero means "no reference supplied".
    pub reference: [u8; 32],
    pub version: u8,
    /// Room for an expiry or a risk tier without changing the account size.
    pub reserved: [u8; 32],
}

impl KycAccount {
    pub const SIZE: usize = 8 // discriminator
        + 32 // wallet
        + 8  // approved_at
        + 32 // attestor
        + 32 // reference
        + 1  // version
        + 32; // reserved

    /// Whether this attestation covers `signer`. Cannot fail while the PDA seeds bind the account; it is the
    /// check that must hold if they are ever relaxed.
    pub fn attests(&self, signer: &Pubkey) -> bool {
        self.wallet == *signer
    }
}

/// Reject a KYC scope carrying undefined bits. Zero IS allowed: gate off on both sides, the launch posture.
pub fn validate_kyc_scope(flags: u8) -> Result<()> {
    require!(
        side_flags_valid_allow_empty(flags),
        DominionError::KycScopeInvalid
    );
    Ok(())
}

/// The gate. Ok means the action may proceed. Fails CLOSED (it DENIES), unlike the fee-exemption resolver
/// which falls through to charging. A dormant side ignores `attestation`, so a client never branches on config.
pub fn enforce_kyc(
    scope_flags: u8,
    side: Side,
    attestation: Option<&KycAccount>,
    signer: &Pubkey,
) -> Result<()> {
    if !side.is_set_in(scope_flags) {
        return Ok(());
    }
    match attestation {
        Some(a) if a.attests(signer) => Ok(()),
        _ => Err(error!(DominionError::KycRequired)),
    }
}

/// arming rule, pure so it is unit-testable outside a handler. Arming needs a configured operator AND
/// `attestation_count > 0`, i.e. somebody is already through. `flags == 0` (disarm) is always allowed and
/// checked FIRST: it is the only unbrick path, so it must not depend on the roster or the operator.
pub fn validate_kyc_arming(flags: u8, operator: Pubkey, attestation_count: u32) -> Result<()> {
    if flags == 0 {
        return Ok(());
    }
    require!(
        operator != Pubkey::default(),
        DominionError::KycAttestorNotSet
    );
    require!(attestation_count > 0, DominionError::KycNoAttestationsYet);
    Ok(())
}

/// Whether a wallet may be attested. Rejects only what is PROVABLY unusable as a signer: `Pubkey::default()`
/// would fill the roster, satisfy arming's `count > 0`, and admit nobody. Not "the holder is real".
pub fn validate_kyc_subject(wallet: Pubkey) -> Result<()> {
    require!(
        wallet != Pubkey::default(),
        DominionError::KycSubjectInvalid
    );
    Ok(())
}

/// Roster size after an attestation. Re-attestation (`!account_is_new`) is idempotent, so a backend replaying
/// its queue cannot inflate the roster and let the gate be armed against a roster that is empty in reality.
pub fn next_attestation_count(current: u32, account_is_new: bool) -> Result<u32> {
    if !account_is_new {
        return Ok(current);
    }
    current
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))
}

/// The whole next state a revocation must write, not a predicate. Returning the complete state, instead of a
/// bool the handler applies inside an `if`, is what keeps "an armed gate always has a non-empty roster"
/// undeletable: the handler assigns every field unconditionally, so there is no branch to delete.
#[derive(Debug, PartialEq, Eq)]
pub struct RevocationOutcome {
    pub count_after: u32,
    /// Equal to the current flags unless this revocation disarms.
    pub scope_after: u8,
    /// The gate was dropped, so `KycScopeChanged` must be emitted.
    pub disarmed: bool,
}

/// Resolve a revocation into the whole next state. One that would leave an ARMED gate with an EMPTY roster
/// DISARMS the gate rather than being refused: refusing removed the only way to drop the LAST holder, and the
/// workaround (disarm, revoke, re-arm) cannot re-arm, because arming needs `count > 0`.
/// That disarm needs BOTH `signer_is_admin` and `allow_disarm`. Admin-only, because the attestor also calls
/// `revoke_kyc` and must not gain a one-transaction "drop the gate for everybody". Consent as well, because
/// the disarm is reachable by ORDERING: the attestor walks the roster to one (every step leaves
/// `count_after > 0`, so nothing disarms) and the admin's next revocation empties it and drops the gate.
/// NOT symmetric with `validate_kyc_arming`: arming needs `count > 0` BEFORE, this acts on `count == 0` AFTER.
pub fn resolve_revocation(
    scope_flags: u8,
    count_current: u32,
    signer_is_admin: bool,
    allow_disarm: bool,
) -> Result<RevocationOutcome> {
    // `checked_sub`, never saturating: a counter drifted BELOW the real roster is the dangerous direction,
    // it lets the gate be armed on attestations that are gone. Refuse and be noticed.
    let count_after = count_current
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    if scope_flags == 0 || count_after > 0 {
        return Ok(RevocationOutcome {
            count_after,
            scope_after: scope_flags,
            disarmed: false,
        });
    }

    // This revocation would leave an ARMED gate with nobody behind it.
    require!(signer_is_admin, DominionError::KycLastAttestationWhileArmed);
    require!(allow_disarm, DominionError::KycRevokeWouldDisarm);
    Ok(RevocationOutcome {
        count_after: 0,
        scope_after: 0,
        disarmed: true,
    })
}

/// Whether clearing the attestor is permitted. See `validate_kyc_operator_assignment` for why not while armed.
pub fn kyc_operator_may_be_cleared(scope_flags: u8) -> bool {
    scope_flags == 0
}

/// Whether the attestor may be set to this key, NOT THE ADMIN, on any scope: `revoke_kyc`'s admin-only
/// disarm, the hot/cold split, and "a leaked attestor cannot loosen compliance" all rest on the two being
/// different keys and collapse silently if they are equal. NOT CLEARED WHILE ARMED, or no NEW attestation
/// could ever be written and every not-yet-attested holder is shut out with nothing in the program saying so.
/// Disarm first, then decommission. Both are instant.
pub fn validate_kyc_operator_assignment(
    operator: Pubkey,
    admin: Pubkey,
    scope_flags: u8,
) -> Result<()> {
    require_keys_neq!(operator, admin, DominionError::KycOperatorMayNotBeAdmin);
    if operator == Pubkey::default() {
        require!(
            kyc_operator_may_be_cleared(scope_flags),
            DominionError::KycOperatorRequiredWhileArmed
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::side::{SIDE_ALL_BITS, SIDE_MINT_BIT, SIDE_REDEEM_BIT};

    const WALLET: Pubkey = Pubkey::new_from_array([7u8; 32]);
    const OTHER: Pubkey = Pubkey::new_from_array([9u8; 32]);
    const ATTESTOR: Pubkey = Pubkey::new_from_array([3u8; 32]);

    fn attestation(wallet: Pubkey) -> KycAccount {
        KycAccount {
            wallet,
            approved_at: 1,
            attestor: ATTESTOR,
            reference: [0u8; 32],
            version: KYC_ACCOUNT_VERSION,
            reserved: [0u8; 32],
        }
    }

    #[test]
    fn size_matches_the_struct() {
        assert_eq!(KycAccount::SIZE, 8 + 32 + 8 + 32 + 32 + 1 + 32);
        assert_eq!(KycAccount::SIZE, 145);
    }

    #[test]
    fn a_dormant_gate_lets_everyone_through_with_no_attestation() {
        // The launch posture. If this regresses, mint stops working on day one.
        for side in [Side::Mint, Side::Redeem] {
            assert!(enforce_kyc(0, side, None, &WALLET).is_ok());
        }
    }

    #[test]
    fn a_dormant_gate_ignores_a_supplied_attestation_even_a_wrong_one() {
        // A client must not branch on config state, so a stale or wrong account cannot break an ungated action.
        let wrong = attestation(OTHER);
        assert!(enforce_kyc(0, Side::Mint, Some(&wrong), &WALLET).is_ok());
    }

    #[test]
    fn an_armed_side_denies_a_wallet_with_no_attestation() {
        assert!(enforce_kyc(SIDE_MINT_BIT, Side::Mint, None, &WALLET).is_err());
        assert!(enforce_kyc(SIDE_REDEEM_BIT, Side::Redeem, None, &WALLET).is_err());
        assert!(enforce_kyc(SIDE_ALL_BITS, Side::Mint, None, &WALLET).is_err());
    }

    #[test]
    fn an_armed_side_admits_a_matching_attestation() {
        let a = attestation(WALLET);
        assert!(enforce_kyc(SIDE_MINT_BIT, Side::Mint, Some(&a), &WALLET).is_ok());
        assert!(enforce_kyc(SIDE_ALL_BITS, Side::Redeem, Some(&a), &WALLET).is_ok());
    }

    #[test]
    fn someone_elses_attestation_does_NOT_admit_you() {
        let a = attestation(OTHER);
        assert!(enforce_kyc(SIDE_MINT_BIT, Side::Mint, Some(&a), &WALLET).is_err());
    }

    #[test]
    fn arming_one_side_does_not_gate_the_other() {
        // Redeem gated, mint left open so DEX arbitrage keeps working: what justifies two bits over one bool.
        assert!(enforce_kyc(SIDE_REDEEM_BIT, Side::Mint, None, &WALLET).is_ok());
        assert!(enforce_kyc(SIDE_REDEEM_BIT, Side::Redeem, None, &WALLET).is_err());

        assert!(enforce_kyc(SIDE_MINT_BIT, Side::Redeem, None, &WALLET).is_ok());
        assert!(enforce_kyc(SIDE_MINT_BIT, Side::Mint, None, &WALLET).is_err());
    }

    #[test]
    fn scope_validation_allows_zero_but_refuses_undefined_bits() {
        assert!(validate_kyc_scope(0).is_ok()); // turning the gate off entirely
        assert!(validate_kyc_scope(SIDE_MINT_BIT).is_ok());
        assert!(validate_kyc_scope(SIDE_ALL_BITS).is_ok());
        assert!(validate_kyc_scope(0b100).is_err());
        assert!(validate_kyc_scope(0xFF).is_err());
    }
    // ---- the attestation counter and the arming rule ----

    #[test]
    fn arming_is_refused_with_an_empty_roster() {
        let op = Pubkey::new_from_array([3u8; 32]);
        // A configured attestor is NOT enough: a PDA or a typo satisfies it while being unable to sign.
        assert!(validate_kyc_arming(2, op, 0).is_err());
        assert!(validate_kyc_arming(1, op, 0).is_err());
        assert!(validate_kyc_arming(3, op, 0).is_err());
        // One is enough: no on-chain check can tell an accidental roster of one from a deliberate one.
        assert!(validate_kyc_arming(2, op, 1).is_ok());
    }

    #[test]
    fn arming_still_requires_a_configured_attestor_and_reports_that_first() {
        // With neither an attestor nor attestations, "no attestor" is the useful message: it is step one.
        let e = validate_kyc_arming(2, Pubkey::default(), 0).unwrap_err();
        assert!(format!("{e:?}").contains("KycAttestorNotSet"));
        let e2 = validate_kyc_arming(2, Pubkey::new_from_array([9u8; 32]), 0).unwrap_err();
        assert!(format!("{e2:?}").contains("KycNoAttestationsYet"));
    }

    #[test]
    fn DISARMING_never_depends_on_the_roster_or_the_operator() {
        // The unbrick path: if either could block a disarm, a wrongly-armed gate would be unfixable.
        assert!(validate_kyc_arming(0, Pubkey::default(), 0).is_ok());
        assert!(validate_kyc_arming(0, Pubkey::new_from_array([1u8; 32]), 0).is_ok());
        assert!(validate_kyc_arming(0, Pubkey::default(), 7).is_ok());
    }

    #[test]
    fn the_attestor_may_only_be_cleared_while_disarmed() {
        // Not a total lockout: already-attested holders keep redeeming, every other holder is shut out silently.
        assert!(kyc_operator_may_be_cleared(0));
        assert!(!kyc_operator_may_be_cleared(1));
        assert!(!kyc_operator_may_be_cleared(2));
        assert!(!kyc_operator_may_be_cleared(3));
    }

    #[test]
    fn emptying_an_armed_roster_disarms_for_a_consenting_admin_and_is_refused_otherwise() {
        // "Armed with an empty roster" stays unreachable by DISARMING, not by refusing. The disarm needs the
        // admin AND explicit consent: the attestor can walk the roster to one and let the admin empty it.
        for flags in [1u8, 2, 3] {
            let out = resolve_revocation(flags, 1, true, true).unwrap();
            assert_eq!(out.count_after, 0);
            assert_eq!(out.scope_after, 0, "the gate drops with the last holder");
            assert!(out.disarmed, "and it is announced");

            assert!(
                resolve_revocation(flags, 1, true, false).is_err(),
                "an admin who did not ASK to loosen compliance must be refused and see it"
            );
            assert!(
                resolve_revocation(flags, 1, false, true).is_err(),
                "the attestor must not get a one-transaction 'open the gate for everybody', consent or not"
            );
            assert!(resolve_revocation(flags, 1, false, false).is_err());
        }
    }

    #[test]
    fn a_revocation_that_leaves_anyone_behind_never_touches_the_scope() {
        // `allow_disarm` must not become a way to disarm while the roster is still populated.
        for flags in [1u8, 2, 3] {
            for admin in [true, false] {
                for allow in [true, false] {
                    let out = resolve_revocation(flags, 8, admin, allow).unwrap();
                    assert_eq!(out.count_after, 7);
                    assert_eq!(
                        out.scope_after, flags,
                        "the scope is not a side effect of a revocation"
                    );
                    assert!(!out.disarmed);
                }
            }
        }
    }

    #[test]
    fn a_disarmed_gate_revokes_freely_including_to_zero() {
        // Nothing is gated, so nothing can lock out, and there is no scope to drop.
        for admin in [true, false] {
            for allow in [true, false] {
                let out = resolve_revocation(0, 1, admin, allow).unwrap();
                assert_eq!(out.count_after, 0);
                assert_eq!(out.scope_after, 0);
                assert!(!out.disarmed, "no scope was armed, so nothing was disarmed");
            }
        }
    }

    #[test]
    fn revoking_from_a_zero_counter_refuses_rather_than_clamping() {
        // Drifted LOW is the dangerous direction: it lets the gate be armed on attestations that are gone.
        for flags in [0u8, 1, 2, 3] {
            assert!(resolve_revocation(flags, 0, true, true).is_err());
        }
    }

    #[test]
    fn the_attestor_may_never_be_the_admin_key() {
        let admin = Pubkey::new_from_array([1u8; 32]);
        let hot = Pubkey::new_from_array([2u8; 32]);
        // Equal keys collapse admin-only disarm, the hot/cold split, and "a leak cannot loosen compliance".
        for flags in 0u8..=3 {
            assert!(
                validate_kyc_operator_assignment(admin, admin, flags).is_err(),
                "operator == admin must be refused on every scope"
            );
            assert!(validate_kyc_operator_assignment(hot, admin, flags).is_ok() || flags != 0);
        }
        assert!(validate_kyc_operator_assignment(hot, admin, 0).is_ok());
        assert!(validate_kyc_operator_assignment(hot, admin, 2).is_ok());
    }

    #[test]
    fn decommissioning_the_attestor_is_refused_while_the_gate_is_armed() {
        let admin = Pubkey::new_from_array([1u8; 32]);
        // Clearing it while armed leaves a gate with provably no way to admit anybody.
        for flags in 1u8..=3 {
            assert!(validate_kyc_operator_assignment(Pubkey::default(), admin, flags).is_err());
        }
        assert!(validate_kyc_operator_assignment(Pubkey::default(), admin, 0).is_ok());
    }

    #[test]
    fn arming_and_revoking_guard_ONE_invariant_from_opposite_sides() {
        // The invariant: an ARMED gate always has a non-empty roster. Arming checks it BEFORE the change,
        // revocation resolves it AFTER, and neither half covers the other.
        let op = Pubkey::new_from_array([5u8; 32]);
        assert!(
            validate_kyc_arming(2, op, 0).is_err(),
            "cannot ENTER armed from an empty roster"
        );
        assert!(validate_kyc_arming(2, op, 1).is_ok());
        // No outcome LEAVES the pair inconsistent: non-zero flags with a zero count never happens.
        for flags in [1u8, 2, 3] {
            for count in [1u32, 2, 9] {
                for admin in [true, false] {
                    for allow in [true, false] {
                        if let Ok(out) = resolve_revocation(flags, count, admin, allow) {
                            assert!(
                                out.scope_after == 0 || out.count_after > 0,
                                "armed with an empty roster is reachable: flags={flags} count={count}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_roster_transition_is_exercised_not_the_standard_library() {
        // A CREATION increments.
        assert_eq!(next_attestation_count(0, true).unwrap(), 1);
        assert_eq!(next_attestation_count(41, true).unwrap(), 42);
        // A RE-ATTESTATION does not, which is the one that matters: `attest_kyc` is idempotent, so a backend
        // replaying its queue must not inflate the roster.
        assert_eq!(next_attestation_count(0, false).unwrap(), 0);
        assert_eq!(next_attestation_count(7, false).unwrap(), 7);
        // Overflow REFUSES rather than wrapping.
        assert!(next_attestation_count(u32::MAX, true).is_err());
        assert_eq!(next_attestation_count(u32::MAX, false).unwrap(), u32::MAX);

        // The decrement lives inside `resolve_revocation`, and refuses at zero rather than saturating: a
        // counter drifted below the real roster is what lets the gate be armed on a lie.
        assert_eq!(
            resolve_revocation(0, 1, false, false).unwrap().count_after,
            0
        );
        assert_eq!(
            resolve_revocation(0, 9, false, false).unwrap().count_after,
            8
        );
        assert!(
            resolve_revocation(0, 0, true, true).is_err(),
            "must refuse, not saturate to 0"
        );
    }

    #[test]
    fn a_provably_unusable_subject_cannot_be_attested() {
        // No user can present `Pubkey::default()` as the required signer, so attesting it would fill the
        // roster, satisfy arming, and admit nobody. Narrow on purpose: only what is PROVABLY unusable.
        assert!(validate_kyc_subject(Pubkey::default()).is_err());
        assert!(validate_kyc_subject(Pubkey::new_from_array([1u8; 32])).is_ok());
    }
}
