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

/** The roster size after a revocation. `checked_sub`, never saturating: see the handler's note. */
pub fn count_after_revocation(current: u32) -> Result<u32> {
    current
        .checked_sub(1)
        .ok_or(error!(DominionError::ArithmeticOverflow))
}

/**
 * What a revocation must do, given the scope, the roster size it would LEAVE, and who signed.
 * Returns whether the gate must be DISARMED in the same instruction.
 *
 * ROUND 3 P0. The counter closed "arming an empty roster" and left the mirror image open: arm
 * legitimately with one attestation, then revoke that attestation. The count returns to zero WHILE the
 * gate stays armed, so nobody can pass and nobody new can be admitted. The exact total lockout C-02
 * exists to prevent, reached through a different door.
 *
 * REVIEW-OF-FIXES P1, and the reason this returns a bool instead of `Result<()>`. My first fix simply
 * REFUSED the emptying revocation. Both reviewers found the same cost, independently: it deletes the
 * compliance-removal path for the last holder. Armed gate, roster of exactly one wallet W, and W must go
 * (sanctioned, failed re-screen, or an attestor typo, since a well-formed wrong address is attestable).
 * `revoke_kyc(W)` was refused for the ADMIN too. The only route out was `set_kyc_scope(0)`, which
 * un-gates redemption for everyone INCLUDING W, then revoke, and then the gate could not be re-armed at
 * all because arming needs `count > 0` and the count is now zero.
 *
 * So the bug was "an armed gate nobody can pass, recoverable by one instant admin disarm" and the fix
 * bought that at the price of "a wallet that must not redeem can redeem, and removing it requires opening
 * the gate to it". That is the same trade `set_kyc_operator` refused in 184a738, made in the opposite
 * direction. The round-3 report offered two remedies; the first one taken removed a capability.
 *
 * This is the second: DISARM ATOMICALLY when the roster would empty, and emit `KycScopeChanged` so the
 * loosening is as visible on chain as an explicit disarm. The lockout is closed AND revocation keeps
 * working, which is strictly better than either the bug or the first fix.
 *
 * ADMIN ONLY, and that asymmetry is the whole point. `revoke_kyc` is callable by the attestor as well,
 * and auto-disarming for the attestor would hand a compromised backend a one-transaction "open the gate
 * for everybody" button. The attestor keeps the refusal: it can offboard any holder but the last, and
 * the admin does the last one. The attestor is not thereby powerless-by-accident, it is
 * powerless-on-purpose, because emptying the roster IS a compliance decision.
 *
 * (A compromised attestor can already admit any wallet it likes, so it can already let a chosen address
 * through. What it must not gain is the ability to drop the gate for every address at once.)
 *
 * NOT symmetric with `validate_kyc_arming` on purpose: arming needs `count > 0` BEFORE, this acts on
 * `count == 0` AFTER. Assuming one covers the other is how this half went missing in the first place.
 */
pub fn revocation_must_disarm(
    scope_flags: u8,
    count_after: u32,
    signer_is_admin: bool,
) -> Result<bool> {
    // Nothing is armed: revocation is unconditional and changes no scope.
    if scope_flags == 0 {
        return Ok(false);
    }
    // Somebody is still behind the gate afterwards, so the invariant holds untouched.
    if count_after > 0 {
        return Ok(false);
    }
    require!(signer_is_admin, DominionError::KycLastAttestationWhileArmed);
    Ok(true)
}

/** Whether clearing the attestor is permitted, given the current scope. See C-02's second half. */
pub fn kyc_operator_may_be_cleared(scope_flags: u8) -> bool {
    scope_flags == 0
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
    fn emptying_an_armed_roster_disarms_for_the_admin_and_is_refused_for_the_attestor() {
        // ROUND 3 P0, as amended by REVIEW-OF-FIXES P1. `count_after` is the roster size the revocation
        // would LEAVE. The state "armed with an empty roster" must be unreachable, but the way to keep it
        // unreachable is to disarm, not to refuse: refusing removed the only way to remove the last holder.
        for flags in [1u8, 2, 3] {
            assert_eq!(
                revocation_must_disarm(flags, 0, true).unwrap(),
                true,
                "the admin removes the last holder and the gate drops with it"
            );
            assert!(
                revocation_must_disarm(flags, 0, false).is_err(),
                "the attestor must not get a one-transaction 'open the gate for everybody'"
            );
        }
        // Revoking one of several is fine for EITHER signer, and changes no scope: somebody is still through.
        for admin in [true, false] {
            assert_eq!(revocation_must_disarm(2, 1, admin).unwrap(), false);
            assert_eq!(revocation_must_disarm(3, 7, admin).unwrap(), false);
        }
        // Disarmed, revoke freely, including to zero, from either signer. Nothing is gated, so nothing
        // locks out, and there is no scope left to drop.
        for admin in [true, false] {
            assert_eq!(revocation_must_disarm(0, 0, admin).unwrap(), false);
        }
    }

    #[test]
    fn the_admin_auto_disarm_cannot_be_reached_by_an_attestor_on_any_armed_scope() {
        // The whole security value of the amended rule is this asymmetry, so it gets its own test rather
        // than riding on a loop above. Every non-zero scope, attestor signer, emptying revocation: refused.
        for flags in 1u8..=3 {
            assert!(revocation_must_disarm(flags, 0, false).is_err());
        }
        // And the refusal is specifically about EMPTYING, not about being the attestor: with anyone left
        // behind the gate, the attestor's revocation goes through untouched.
        for flags in 1u8..=3 {
            assert_eq!(revocation_must_disarm(flags, 1, false).unwrap(), false);
        }
    }

    #[test]
    fn arming_and_revoking_guard_ONE_invariant_from_opposite_sides() {
        // The invariant: an ARMED gate always has a non-empty roster. Arming checks it BEFORE the change,
        // revocation AFTER. Writing one and assuming it covered the other is exactly how the second half
        // went missing, so the pair is stated here explicitly.
        let op = Pubkey::new_from_array([5u8; 32]);
        assert!(validate_kyc_arming(2, op, 0).is_err(), "cannot ENTER armed from an empty roster");
        assert!(validate_kyc_arming(2, op, 1).is_ok());
        // The other side of the invariant is no longer a refusal: reaching an empty roster while armed is
        // allowed FOR THE ADMIN and disarms in the same instruction, so the state "armed with an empty
        // roster" is still unreachable. The attestor is still refused.
        assert_eq!(revocation_must_disarm(2, 0, true).unwrap(), true, "admin: disarm, do not refuse");
        assert!(revocation_must_disarm(2, 0, false).is_err(), "attestor may not empty an armed roster");
        assert_eq!(revocation_must_disarm(2, 1, false).unwrap(), false, "not the last: no scope change");
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
        // lie, so refusing and being noticed is the correct answer.
        assert_eq!(count_after_revocation(1).unwrap(), 0);
        assert_eq!(count_after_revocation(9).unwrap(), 8);
        assert!(count_after_revocation(0).is_err(), "must refuse, not saturate to 0");
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
