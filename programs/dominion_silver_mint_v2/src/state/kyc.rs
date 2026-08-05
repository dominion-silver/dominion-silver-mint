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
}
