use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::side::{side_flags_valid_allow_empty, Side};

/// Current KycAccount schema.
pub const KYC_ACCOUNT_VERSION: u8 = 1;

/// A per-wallet KYC attestation. DORMANT at launch: the on-chain mechanism ships in the
/// pre-mainnet upgrade (2026-08-05) with `config.kyc_scope_flags == 0`, so nothing is
/// gated until Mark's off-chain provider exists and the admin arms it.
///
/// # Why it ships dormant instead of later
///
/// SolidProof audited an older version of this program. Every upgrade after launch is
/// either unaudited or costs another audit round. Shipping the gate now, switched off,
/// means arming it later is a config change rather than a new contract version. It is also
/// nearly free to build alongside the fee-exemption whitelist, which has the identical
/// shape (one PDA per wallet, admin-managed, optional account on mint and redeem).
///
/// # THE PII RULE, and it is not negotiable
///
/// Nothing on this account identifies a person. Not a name, not an email, not a document
/// number, and NOT A HASH of any of those: an email hash is trivially reversed by brute
/// force because the input space is small and guessable. `reference` holds a hash of the
/// PROVIDER'S INTERNAL RECORD ID, which is high-entropy and meaningless without the
/// provider's own database.
///
/// This matters because on-chain data is permanent and world-readable. A GDPR erasure
/// request cannot be honoured on Solana. Of everything in this batch it is the only part
/// that is genuinely unfixable if it is got wrong, which is why the constraint lives here
/// in the type rather than in a document somebody may not read.
///
/// # What the off-chain side must produce for this to work
///
/// The contract deliberately depends on the SMALLEST possible fact: "this wallet is
/// approved, attested by this key, referencing record H". It never learns who the person
/// is, which provider was used, or which jurisdiction applies. That is what makes it
/// provider-agnostic: whatever Mark picks, and whatever he switches to later, plugs in
/// without touching this code.
///
/// The interface Mark's flow must satisfy is three items, one of which is easy to miss:
///
///   1. The Solana wallet address.
///   2. The provider's record id, hashed into `reference`.
///   3. **Proof that the approved person controls that wallet.** A KYC provider verifies a
///      PERSON, not a WALLET. Without a step where the user signs a nonce with the wallet
///      and the backend verifies that signature before attesting, wallet X gets approved
///      for person A and person B uses it. The gate is then decorative. This program cannot
///      check it, which is exactly why it has to be stated as a requirement on the
///      off-chain side.
///
/// # Operational footgun
///
/// Write attestations BEFORE arming `kyc_scope_flags`. Arming the gate first locks out
/// every existing holder instantly, because none of them has an attestation yet.
/// `set_kyc_scope` refuses to arm while `config.kyc_operator` is unset, which catches the
/// worst version of this mistake but not the general one.
#[account]
pub struct KycAccount {
    /// The approved wallet. Always equals the PDA seed; re-checked in `attests`.
    pub wallet: Pubkey,
    pub approved_at: i64,
    /// The attestor key that wrote this record. Kept per-record rather than trusting the
    /// current `config.kyc_operator`, so rotating the operator does not retroactively
    /// change who is on the hook for an approval, and a compromised-key incident can be
    /// scoped to the records that key actually wrote.
    pub attestor: Pubkey,
    /// Opaque 32 bytes: a hash of the PROVIDER'S RECORD ID. Never PII. See the type docs.
    /// All-zero is permitted and means "no reference supplied", which a manual approval
    /// process may legitimately have.
    pub reference: [u8; 32],
    pub version: u8,
    /// Room for an expiry (periodic re-screening is normal in this domain) or a risk tier,
    /// without changing the account size.
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

    /// Whether this attestation genuinely covers `signer`.
    ///
    /// Defence in depth, exactly as in FeeExemptAccount: the PDA seeds already bind the
    /// account, so a mismatch is unreachable today. This is the check that must hold if the
    /// seeds are ever relaxed.
    pub fn attests(&self, signer: &Pubkey) -> bool {
        self.wallet == *signer
    }
}

/// Reject a KYC scope carrying undefined bits. Zero IS allowed: it is the launch posture
/// (gate off on both sides) and turning the gate fully off must not need its own
/// instruction.
pub fn validate_kyc_scope(flags: u8) -> Result<()> {
    require!(
        side_flags_valid_allow_empty(flags),
        DominionError::KycScopeInvalid
    );
    Ok(())
}

/// The gate itself. Returns Ok when the action may proceed.
///
/// Fails CLOSED, and note that "closed" here means DENYING the action, the opposite
/// outcome from the fee-exemption resolver, which falls through to charging the fee. Both
/// are the safe direction for their own mechanism: an unprovable exemption should cost the
/// caller money, an unprovable attestation should stop them. They are consistent in
/// intent, not in effect.
///
/// When the gate is dormant for this side, the attestation account is ignored entirely, so
/// callers may pass it or omit it freely and clients need no branch on config state.
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


/// The C-02 arming rule, as a PURE function so it is actually testable.
///
/// Both audits recommended the attestation counter over the arming co-signature. Extracted for the same
/// reason `validate_fee_exempt_expiry` was: a rule that only exists inside a handler, behind
/// `Clock::get()` and an `Accounts` struct, is a rule with no unit test. Every previous C-02 mechanism
/// shipped without one.
///
/// `flags == 0` (disarm) is ALWAYS allowed and deliberately checked first: it is the only unbrick path and
/// must never depend on the roster or the operator, either of which may be the thing that is broken.
pub fn validate_kyc_arming(
    flags: u8,
    operator: Pubkey,
    attestation_count: u32,
) -> Result<()> {
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

/**
 * Whether a wallet may be attested at all.
 *
 * ROUND 3 P2. `attest_kyc` accepted `Pubkey::default()`, so the roster could be filled with the system
 * program address: the counter reads 1, arming succeeds, and NOBODY can pass, because no user can present
 * `11111...` as the required signer. An armed gate with zero usable entries, which is the exact state the
 * counter exists to prevent, reached by attesting a hole.
 *
 * This is deliberately NARROWER than "verify the holder is real", which is the missing provider pipeline
 * and cannot be done on chain. It rejects only the addresses that are PROVABLY unusable as a signer, which
 * costs nothing and needs no off-chain identity.
 */
pub fn validate_kyc_subject(wallet: Pubkey) -> Result<()> {
    require!(wallet != Pubkey::default(), DominionError::KycSubjectInvalid);
    Ok(())
}

/**
 * The roster size after an attestation, given whether the account was CREATED by this call.
 *
 * ROUND 3 P2, and the reason this exists as a function at all. The two tests I wrote for the counter could
 * not fail: one exercised `u32::checked_add` and `u32::checked_sub`, i.e. the Rust standard library, and the
 * other asserted that a constant is non-zero. Neither touched a handler, so replacing `checked_sub` with
 * `saturating_sub` or incrementing on every re-attestation left both green.
 *
 * The arithmetic and the creation rule now live here, so a test can exercise the ACTUAL transition the
 * handler performs rather than the primitive it happens to use.
 */
pub fn next_attestation_count(current: u32, account_is_new: bool) -> Result<u32> {
    if !account_is_new {
        // Idempotent re-attestation. A backend replaying its queue must not inflate the roster: that would
        // eventually let the gate be armed against a roster that is empty in reality.
        return Ok(current);
    }
    current
        .checked_add(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))
}

/**
 * The whole state transition a revocation performs. Not a predicate: the complete next value of every
 * field the handler must write.
 *
 * REVIEW-OF-FIXES, second round, and the shape matters as much as the rule. My previous version returned
 * `Result<bool>` and the handler applied the disarm inside `if must_disarm { ... }`. A reviewer deleted that
 * whole block and measured 154/154 Rust green plus every gate green: section 4c proves the rule is CALLED,
 * never that its answer is USED, and a `bool` carries no obligation where the old `Result<()>` at least had
 * `#[must_use]`. So "armed gate with an empty roster", the round-3 P0, was re-openable by deleting a
 * conditional.
 *
 * Returning the next state removes the conditional entirely: the handler assigns `scope_after` and the
 * derived `kyc_enforced` UNCONDITIONALLY, so there is no branch to delete. Only the event is conditional,
 * and losing an event is not losing an invariant.
 *
 * ---- the rule itself ----
 *
 * ROUND 3 P0. The counter closed "arming an empty roster" and left the mirror image open: arm legitimately
 * with one attestation, then revoke it. The count returns to zero WHILE the gate stays armed, so nobody can
 * pass and nobody new can be admitted. The lockout C-02 exists to prevent, through a different door.
 *
 * REVIEW-OF-FIXES P1: my first fix REFUSED that revocation, which deleted the compliance-removal path for
 * the last holder. Armed gate, roster of exactly one wallet W, and W must go (sanctioned, failed re-screen,
 * or an attestor typo, since any well-formed wrong address is attestable). The only route out was
 * `set_kyc_scope(0)`, which un-gates redemption for everyone INCLUDING W, then revoke, and then the gate
 * could not be re-armed because arming needs `count > 0`. The bug was recoverable by one instant admin
 * disarm; the fix was not recoverable at all.
 *
 * So the emptying revocation DISARMS instead of being refused. Two conditions on it, and each closes a
 * finding of its own:
 *
 * ADMIN ONLY. `revoke_kyc` is callable by the attestor as well, and auto-disarming for the attestor would
 * hand a compromised backend a one-transaction "open the gate for everybody". The attestor can already
 * admit any wallet it chooses, so it already has "let a chosen address through"; what it must not gain is
 * "drop the gate for every address at once".
 *
 * AND EXPLICITLY REQUESTED, via `allow_disarm`. Both reviewers found the same escalation independently, and
 * admin-only did not close it, because the attestor does not need to REACH the disarm, only to arrange for
 * the admin to trigger it. The attestor revokes wallets down to a roster of exactly one (every step leaves
 * `count_after > 0`, so nothing disarms), and then the admin's next revocation, whatever it was for, empties
 * the roster and drops the gate. The window is real rather than theoretical: revocation goes through the
 * Squads panel, so the admin approves at a moment when the roster holds fifty and the transaction executes
 * later. Under the previous behaviour that transaction REVERTED and the admin investigated.
 *
 * `allow_disarm` puts the consent in the signed message. An admin who did not ask to loosen compliance gets
 * the refusal and the visibility that comes with it; an admin who genuinely wants to remove the last holder
 * says so. Squads assembles instruction arguments without trouble, which is exactly what the reverted
 * co-signature approach could not do.
 *
 * NOT symmetric with `validate_kyc_arming` on purpose: arming needs `count > 0` BEFORE, this acts on
 * `count == 0` AFTER. Assuming one covers the other is how this half went missing in the first place.
 */
#[derive(Debug, PartialEq, Eq)]
pub struct RevocationOutcome {
    /// The roster size to store.
    pub count_after: u32,
    /// The scope flags to store. Equal to the current flags unless this revocation disarms.
    pub scope_after: u8,
    /// Whether the gate was dropped, i.e. whether `KycScopeChanged` must be emitted.
    pub disarmed: bool,
}

pub fn resolve_revocation(
    scope_flags: u8,
    count_current: u32,
    signer_is_admin: bool,
    allow_disarm: bool,
) -> Result<RevocationOutcome> {
    // `checked_sub`, never saturating. A saturating decrement would paper over a counter that had drifted
    // below the real roster size, and that direction is the dangerous one: it lets the gate be armed while
    // the count claims attestations that no longer exist.
    let count_after = count_current
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))?;

    // Nothing armed, or somebody is still behind the gate afterwards: no scope change at all.
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

/** Whether clearing the attestor is permitted, given the current scope. See C-02's second half. */
pub fn kyc_operator_may_be_cleared(scope_flags: u8) -> bool {
    scope_flags == 0
}

/**
 * Whether the attestor may be set to this key, given the admin and the current scope.
 *
 * Both halves of C-02's second finding, plus the review-of-fixes addition, in one place so section 4c can
 * require the handler to call it. It was a bare `require_keys_neq!` in the handler first, and a handler-only
 * check is invisible to every test and every gate: deleting it left 156/156 green.
 *
 * NOT THE ADMIN. The entire admin/attestor asymmetry rests on the two being different keys: `revoke_kyc`'s
 * admin-only disarm, the hot/cold split, and the claim that a leaked attestor key cannot loosen compliance.
 * Setting them equal collapses all three silently, and there is no legitimate configuration where the Squads
 * vault is also the server key that signs every approval.
 *
 * NOT CLEARED WHILE ARMED. `set_kyc_scope(2)` legitimately, then `set_kyc_operator(Pubkey::default())`, and
 * no new attestation can ever be written while the redeem side stays closed. Already-attested holders keep
 * redeeming, so it is not a total lockout, but every holder not yet attested is shut out with nothing in the
 * program saying so. Disarm first, then decommission: both are instant.
 */
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
        // The launch posture. This is the single most important case: if it ever regresses,
        // mint stops working on day one.
        for side in [Side::Mint, Side::Redeem] {
            assert!(enforce_kyc(0, side, None, &WALLET).is_ok());
        }
    }

    #[test]
    fn a_dormant_gate_ignores_a_supplied_attestation_even_a_wrong_one() {
        // Clients must not need to branch on config state to decide whether to pass the
        // account, so a stale or mismatched account cannot break an ungated action.
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
        // Mark's likely first step: KYC on redeem only, public mint left open so DEX
        // arbitrage keeps working. This is the case that justifies two bits over one bool.
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
    // ---- C-02: the attestation counter and the arming rule ----

    #[test]
    fn arming_is_refused_with_an_empty_roster() {
        let op = Pubkey::new_from_array([3u8; 32]);
        // The whole point: a configured attestor is NOT enough, because a PDA or a typo satisfies that
        // while being unable to sign. Somebody has to be through the gate already.
        assert!(validate_kyc_arming(2, op, 0).is_err());
        assert!(validate_kyc_arming(1, op, 0).is_err());
        assert!(validate_kyc_arming(3, op, 0).is_err());
        // One is enough to arm. Arming with exactly one still locks out everyone else, which is an
        // operational matter no on-chain check can distinguish from a deliberately small roster.
        assert!(validate_kyc_arming(2, op, 1).is_ok());
    }

    #[test]
    fn arming_still_requires_a_configured_attestor_and_reports_that_first() {
        // Order matters for the operator's sake: with neither an attestor nor attestations, the useful
        // message is "no attestor", because setting one is the first step.
        let e = validate_kyc_arming(2, Pubkey::default(), 0).unwrap_err();
        assert!(format!("{e:?}").contains("KycAttestorNotSet"));
        // And an attestor with an empty roster reports the roster.
        let e2 = validate_kyc_arming(2, Pubkey::new_from_array([9u8; 32]), 0).unwrap_err();
        assert!(format!("{e2:?}").contains("KycNoAttestationsYet"));
    }

    #[test]
    fn DISARMING_never_depends_on_the_roster_or_the_operator() {
        // The unbrick path. If either of these could block a disarm, a wrongly-armed gate would be
        // unfixable by exactly the mechanism meant to fix it.
        assert!(validate_kyc_arming(0, Pubkey::default(), 0).is_ok());
        assert!(validate_kyc_arming(0, Pubkey::new_from_array([1u8; 32]), 0).is_ok());
        assert!(validate_kyc_arming(0, Pubkey::default(), 7).is_ok());
    }

    #[test]
    fn the_attestor_may_only_be_cleared_while_disarmed() {
        // C-02's second half, which the co-signature did not address at all: arm legitimately, then
        // decommission the attestor, and no NEW attestation can ever be written while the side stays
        // gated. Already-attested holders keep redeeming; everyone else is shut out silently.
        assert!(kyc_operator_may_be_cleared(0));
        assert!(!kyc_operator_may_be_cleared(1));
        assert!(!kyc_operator_may_be_cleared(2));
        assert!(!kyc_operator_may_be_cleared(3));
    }



    #[test]
    fn emptying_an_armed_roster_disarms_for_a_consenting_admin_and_is_refused_otherwise() {
        // ROUND 3 P0, as amended twice. The state "armed with an empty roster" must be unreachable, and the
        // way to keep it unreachable is to disarm, not to refuse: refusing removed the only way to remove
        // the last holder. But the disarm needs BOTH the admin AND explicit consent, because the attestor
        // can walk the roster down to one and let the admin's next revocation drop the gate for everybody.
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
        // The common case, and it must be untouched for EITHER signer and regardless of `allow_disarm`:
        // passing the flag must not become a way to disarm while the roster is still populated.
        for flags in [1u8, 2, 3] {
            for admin in [true, false] {
                for allow in [true, false] {
                    let out = resolve_revocation(flags, 8, admin, allow).unwrap();
                    assert_eq!(out.count_after, 7);
                    assert_eq!(out.scope_after, flags, "the scope is not a side effect of a revocation");
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
        // The counter is already broken if this happens, and the direction of the drift is the dangerous
        // one: a count below the real roster size lets the gate be armed against attestations that are
        // gone. Refuse and be noticed.
        for flags in [0u8, 1, 2, 3] {
            assert!(resolve_revocation(flags, 0, true, true).is_err());
        }
    }


    #[test]
    fn the_attestor_may_never_be_the_admin_key() {
        let admin = Pubkey::new_from_array([1u8; 32]);
        let hot = Pubkey::new_from_array([2u8; 32]);
        // REVIEW-OF-FIXES P2, both reviewers. Nothing forbade this, and it collapses every KYC authority
        // argument at once: admin-only disarm, hot/cold split, "a leaked attestor cannot loosen compliance".
        for flags in 0u8..=3 {
            assert!(
                validate_kyc_operator_assignment(admin, admin, flags).is_err(),
                "operator == admin must be refused on every scope"
            );
            assert!(validate_kyc_operator_assignment(hot, admin, flags).is_ok() || flags != 0);
        }
        // An ordinary rotation to a different hot key is fine, armed or not.
        assert!(validate_kyc_operator_assignment(hot, admin, 0).is_ok());
        assert!(validate_kyc_operator_assignment(hot, admin, 2).is_ok());
    }

    #[test]
    fn decommissioning_the_attestor_is_refused_while_the_gate_is_armed() {
        let admin = Pubkey::new_from_array([1u8; 32]);
        // C-02's second half: clearing it while armed leaves a gate with provably no way to admit anybody.
        for flags in 1u8..=3 {
            assert!(validate_kyc_operator_assignment(Pubkey::default(), admin, flags).is_err());
        }
        // Disarmed, decommissioning is allowed. It is the documented way to turn the mechanism off.
        assert!(validate_kyc_operator_assignment(Pubkey::default(), admin, 0).is_ok());
    }

    #[test]
    fn arming_and_revoking_guard_ONE_invariant_from_opposite_sides() {
        // The invariant: an ARMED gate always has a non-empty roster. Arming checks it BEFORE the change,
        // revocation resolves it AFTER. Writing one and assuming it covered the other is exactly how the
        // second half went missing, so the pair is stated here explicitly.
        let op = Pubkey::new_from_array([5u8; 32]);
        assert!(validate_kyc_arming(2, op, 0).is_err(), "cannot ENTER armed from an empty roster");
        assert!(validate_kyc_arming(2, op, 1).is_ok());
        // And the other side never LEAVES the pair inconsistent: either the roster stays populated, or the
        // scope goes to zero with it. There is no outcome where flags are non-zero and the count is zero.
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
        // ROUND 3 P2. The two tests this replaces could not fail: one asserted `u32::checked_add(1)` and
        // `checked_sub(1)` behave as documented, which is a test of Rust, and the other asserted a constant
        // is non-zero. Swapping the handler's `checked_sub` for `saturating_sub`, or incrementing on every
        // re-attestation, left both green. These exercise the actual transition instead.
        //
        // A CREATION increments.
        assert_eq!(next_attestation_count(0, true).unwrap(), 1);
        assert_eq!(next_attestation_count(41, true).unwrap(), 42);
        // A RE-ATTESTATION does not. This is the one that matters: `attest_kyc` is idempotent so a backend
        // replaying its queue must not inflate the roster, or the gate could be armed against a roster that
        // is empty in reality.
        assert_eq!(next_attestation_count(0, false).unwrap(), 0);
        assert_eq!(next_attestation_count(7, false).unwrap(), 7);
        // Overflow REFUSES rather than wrapping.
        assert!(next_attestation_count(u32::MAX, true).is_err());
        assert_eq!(next_attestation_count(u32::MAX, false).unwrap(), u32::MAX);

        // Revocation decrements, and refuses at zero rather than saturating. Saturating would paper over a
        // counter already drifted below the real roster, in the direction that lets the gate be armed on a
        // lie, so refusing and being noticed is the correct answer. The decrement folded into
        // `resolve_revocation` when the rule started returning the whole next state, so it is exercised
        // through that.
        assert_eq!(resolve_revocation(0, 1, false, false).unwrap().count_after, 0);
        assert_eq!(resolve_revocation(0, 9, false, false).unwrap().count_after, 8);
        assert!(resolve_revocation(0, 0, true, true).is_err(), "must refuse, not saturate to 0");
    }

    #[test]
    fn a_provably_unusable_subject_cannot_be_attested() {
        // ROUND 3 P2. `Pubkey::default()` was accepted, so the roster could be filled with the system
        // program address: count reads 1, arming succeeds, and nobody can pass because no user can present
        // `11111...` as the required signer. An armed gate with zero usable entries.
        assert!(validate_kyc_subject(Pubkey::default()).is_err());
        assert!(validate_kyc_subject(Pubkey::new_from_array([1u8; 32])).is_ok());
        // Narrow on purpose: this rejects only what is PROVABLY unusable. Verifying a holder is real is the
        // off-chain provider pipeline and cannot be done here.
    }

}
