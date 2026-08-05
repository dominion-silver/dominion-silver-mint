use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::side::{side_flags_valid_nonempty, Side};

/// Current FeeExemptAccount schema.
pub const FEE_EXEMPT_ACCOUNT_VERSION: u8 = 1;

/// Waives the mint premium, the redeem premium, or both, for ONE wallet.
///
/// Requested by Mark 2026-07-30 ("we need to be able to whitelist specific wallets to
/// bypass the fee"), with the per-side split added by Thomas 2026-08-05 so the admin panel
/// chooses which fee is waived. Market makers seeding and rebalancing the DEX pool are the
/// motivating case: charging them 1% each way widens the spread they can quote for
/// everybody else.
///
/// One account PER wallet, PDA-derived FROM that wallet. That shape is deliberate:
///
///   - It scales without bound. A fixed-size array inside ConfigAccount would cap the list
///     and eat the `reserved` bytes Phase 2 still needs.
///   - The PDA seeds BIND the account to the wallet, so a caller cannot present somebody
///     else's exemption. There is nothing to spoof.
///   - Mint and redeem take it as an OPTION. A caller who omits it simply pays the fee,
///     which is the safe default: forgetting the account can never accidentally exempt
///     anyone, and the fee-paying path is the one that needs no privileges.
///
/// Both add and remove are INSTANT admin actions, deliberately NOT timelocked, which is a
/// departure from how this program treats other loosenings. The reason is that the worst
/// case here is FOREGONE FEE REVENUE, not a loss of principal, backing, or user funds: an
/// exempt wallet still pays the full oracle price for its SILV and still receives the full
/// oracle price when redeeming. Compare the loosenings that ARE timelocked (opening the
/// mint, raising the redeem budget, changing the oracle feed), every one of which can move
/// value or change what users are charged. A day-long ceremony to onboard a market maker
/// would buy nothing.
///
/// KNOWN CONSEQUENCE, flagged to Thomas 2026-08-05 and accepted: a wallet exempt on BOTH
/// sides can mint at exact spot and redeem at exact spot, so its round trip is free. That
/// hands it a free option on oracle movement, paid by the treasury: with the normal fees a
/// round trip must overcome ~2.5% before it profits, at 0% any favourable move is profit.
/// The per-side flags are the mitigation, because exempting the MINT side only leaves the
/// redeem fee as the cost of closing the loop. Prefer `SIDE_MINT_BIT` alone unless there is
/// a specific reason to waive both.
#[account]
pub struct FeeExemptAccount {
    /// The exempt wallet. Always equals the PDA seed; re-checked in `exempts`.
    pub wallet: Pubkey,
    /// Bitfield over `Side`. See state/side.rs. Never zero: a zero-flag exemption is
    /// rejected on write, because it would be dead rent that still shows up in a roster.
    pub flags: u8,
    pub added_at: i64,
    /// Who granted it. Kept for forensics: an unexplained exemption is a red flag, and the
    /// event alone stops being enough once RPC logs age out.
    pub added_by: Pubkey,
    pub version: u8,
    /// Room for a future per-wallet fee OVERRIDE (a reduced rate rather than zero) or an
    /// expiry, without changing the account size. Learned from GuardianAccount, which grew
    /// twice and had neither.
    pub reserved: [u8; 32],
}

impl FeeExemptAccount {
    pub const SIZE: usize = 8 // discriminator
        + 32 // wallet
        + 1  // flags
        + 8  // added_at
        + 32 // added_by
        + 1  // version
        + 32; // reserved

    /// Whether this account genuinely exempts `signer` on `side`.
    ///
    /// The wallet re-check is defence in depth. PDA seeds already bind the account, so a
    /// mismatch is unreachable today; this is the assertion that has to hold if the seeds
    /// are ever relaxed, and it costs 32 bytes of comparison.
    pub fn exempts(&self, signer: &Pubkey, side: Side) -> bool {
        self.wallet == *signer && side.is_set_in(self.flags)
    }
}

/// Reject exemption flags that are empty or carry undefined bits.
pub fn validate_fee_exempt_flags(flags: u8) -> Result<()> {
    require!(
        side_flags_valid_nonempty(flags),
        DominionError::FeeExemptFlagsInvalid
    );
    Ok(())
}

/// Resolve the premium to charge, given an optional exemption.
///
/// A free function rather than a method so the decision is unit-testable without a
/// Context, and so mint and redeem cannot drift apart on the rule.
///
/// Note what a supplied-but-INVALID exemption does: it falls through to the full premium
/// rather than erroring. That is intentional and it is the fail-closed direction for this
/// mechanism. Erroring would let a mismatched or wrong-side account block an otherwise
/// valid mint, turning a cosmetic client bug into a denial of service. When an exemption
/// cannot be proven, charging the fee is always safe.
///
/// The KYC gate resolves the same ambiguity the OPPOSITE way (an unprovable attestation
/// denies the action), because there "fail closed" means denying rather than charging. The
/// two are consistent in intent, not in outcome.
pub fn effective_premium_bps(
    configured_bps: u16,
    exemption: Option<&FeeExemptAccount>,
    signer: &Pubkey,
    side: Side,
) -> u16 {
    match exemption {
        Some(e) if e.exempts(signer, side) => 0,
        _ => configured_bps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::side::{SIDE_ALL_BITS, SIDE_MINT_BIT, SIDE_REDEEM_BIT};

    const WALLET: Pubkey = Pubkey::new_from_array([7u8; 32]);
    const OTHER: Pubkey = Pubkey::new_from_array([9u8; 32]);
    const ADMIN: Pubkey = Pubkey::new_from_array([1u8; 32]);

    fn exemption(wallet: Pubkey, flags: u8) -> FeeExemptAccount {
        FeeExemptAccount {
            wallet,
            flags,
            added_at: 1,
            added_by: ADMIN,
            version: FEE_EXEMPT_ACCOUNT_VERSION,
            reserved: [0u8; 32],
        }
    }

    #[test]
    fn size_matches_the_struct() {
        assert_eq!(FeeExemptAccount::SIZE, 8 + 32 + 1 + 8 + 32 + 1 + 32);
        assert_eq!(FeeExemptAccount::SIZE, 114);
    }

    #[test]
    fn no_exemption_supplied_charges_the_full_premium() {
        assert_eq!(effective_premium_bps(100, None, &WALLET, Side::Mint), 100);
        assert_eq!(effective_premium_bps(150, None, &WALLET, Side::Redeem), 150);
    }

    #[test]
    fn a_mint_only_exemption_waives_mint_and_NOT_redeem() {
        // The recommended configuration: waiving mint alone keeps the redeem fee as the
        // cost of closing a round trip, so the free-option problem does not arise.
        let e = exemption(WALLET, SIDE_MINT_BIT);
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint), 0);
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem),
            150
        );
    }

    #[test]
    fn a_redeem_only_exemption_waives_redeem_and_NOT_mint() {
        let e = exemption(WALLET, SIDE_REDEEM_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint),
            100
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem),
            0
        );
    }

    #[test]
    fn a_both_sides_exemption_waives_both() {
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint), 0);
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem),
            0
        );
    }

    #[test]
    fn someone_elses_exemption_does_NOT_exempt_you_on_either_side() {
        // PDA seeds make this unreachable today. Asserted because it is the check that
        // must hold if the seeds are ever relaxed.
        let e = exemption(OTHER, SIDE_ALL_BITS);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint),
            100
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem),
            150
        );
    }

    #[test]
    fn an_unprovable_exemption_falls_through_rather_than_erroring() {
        // Charging the fee is the safe default. Erroring would let a wrong-wallet or
        // wrong-side account block a legitimate mint: a client bug becoming a DoS.
        let wrong_wallet = exemption(OTHER, SIDE_MINT_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&wrong_wallet), &WALLET, Side::Mint),
            100
        );
        let wrong_side = exemption(WALLET, SIDE_REDEEM_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&wrong_side), &WALLET, Side::Mint),
            100
        );
    }

    #[test]
    fn a_zero_configured_premium_stays_zero_either_way() {
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert_eq!(effective_premium_bps(0, None, &WALLET, Side::Mint), 0);
        assert_eq!(effective_premium_bps(0, Some(&e), &WALLET, Side::Mint), 0);
    }

    #[test]
    fn flag_validation_refuses_empty_and_undefined_bits() {
        assert!(validate_fee_exempt_flags(SIDE_MINT_BIT).is_ok());
        assert!(validate_fee_exempt_flags(SIDE_REDEEM_BIT).is_ok());
        assert!(validate_fee_exempt_flags(SIDE_ALL_BITS).is_ok());
        // Revoking is remove_fee_exempt, not a zero-flag write.
        assert!(validate_fee_exempt_flags(0).is_err());
        assert!(validate_fee_exempt_flags(0b100).is_err());
    }

    #[test]
    fn the_launch_fees_are_the_ones_being_waived() {
        // Mark 2026-07-30: 1% mint, 1.5% redeem. Pinned so that changing the launch fees
        // cannot silently drift away from the cases exercised here.
        use crate::state::config::{DEFAULT_PREMIUM_MINT_BPS, DEFAULT_PREMIUM_REDEEM_BPS};
        assert_eq!(DEFAULT_PREMIUM_MINT_BPS, 100);
        assert_eq!(DEFAULT_PREMIUM_REDEEM_BPS, 150);
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert_eq!(
            effective_premium_bps(DEFAULT_PREMIUM_MINT_BPS, Some(&e), &WALLET, Side::Mint),
            0
        );
        assert_eq!(
            effective_premium_bps(DEFAULT_PREMIUM_REDEEM_BPS, Some(&e), &WALLET, Side::Redeem),
            0
        );
    }
}
