use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::config::MAX_FEE_EXEMPT_TERM_SECONDS;
use crate::state::side::{side_flags_valid_nonempty, Side};

/// Current FeeExemptAccount schema.
pub const FEE_EXEMPT_ACCOUNT_VERSION: u8 = 1;

/// Waives the mint premium, the redeem premium, or both, for ONE wallet. One account per wallet,
/// PDA-derived FROM that wallet, so the seeds bind it and nothing can be spoofed. Mint and redeem
/// take it as an OPTION: omitting it pays the full fee, which is the safe default.
///
/// Grant and revoke are both INSTANT, and the exposure is NOT nil. A wallet exempt on BOTH sides
/// mints and redeems at exact spot, so its round trip is free and it holds a free option on oracle
/// movement paid by the treasury: normally a round trip must clear the ~2.485% fee band first.
/// Prefer `SIDE_MINT_BIT` alone, which leaves the redeem fee as the cost of closing the loop.
#[account]
pub struct FeeExemptAccount {
    /// The exempt wallet. Always equals the PDA seed; re-checked in `exempts`.
    pub wallet: Pubkey,
    /// Bitfield over `Side` (state/side.rs): 1 = mint, 2 = redeem, 3 = both. Never zero, since a
    /// zero-flag exemption would be dead rent that still shows up in a roster.
    pub flags: u8,
    pub added_at: i64,
    /// Who granted it. Kept for forensics, since the event alone ages out with the RPC logs.
    pub added_by: Pubkey,
    pub version: u8,
    /// Unix timestamp after which this exemption stops applying. MANDATORY, strictly in the future,
    /// at most `MAX_FEE_EXEMPT_TERM_SECONDS` out. **0 grants NOTHING** (see `is_expired`).
    ///
    /// The term bounds FORGETTING (an arrangement that ends, a launch-window favour nobody revisits),
    /// not a compromised admin, who picks the number. An indefinite arrangement is renewed by one
    /// instant transaction, and that renewal is the review the term exists to force.
    pub expires_at: i64,
    /// Room for a future per-wallet fee OVERRIDE (a reduced rate rather than zero).
    pub reserved: [u8; 24],
}

impl FeeExemptAccount {
    pub const SIZE: usize = 8 // discriminator
        + 32 // wallet
        + 1  // flags
        + 8  // added_at
        + 32 // added_by
        + 1  // version
        + 8  // expires_at
        + 24; // reserved

    /// Whether this exemption has passed its expiry at `now`. **A zero expiry counts as EXPIRED**,
    /// which fails CLOSED: the writer refuses zero, so a zero can only come from a half-written or
    /// zeroed account, and granting a permanent free pass there is the unrecoverable direction.
    pub fn is_expired(&self, now: i64) -> bool {
        self.expires_at == 0 || now >= self.expires_at
    }

    /// Whether this account genuinely exempts `signer` on `side` at `now`. The wallet re-check is
    /// unreachable while the PDA seeds bind the account; it is the assertion that must hold if the
    /// seeds are ever relaxed. An EXPIRED exemption is not an error: the caller pays the full premium
    /// and the transaction still succeeds, so a lapsed arrangement is not a broken product.
    pub fn exempts(&self, signer: &Pubkey, side: Side, now: i64) -> bool {
        self.wallet == *signer && side.is_set_in(self.flags) && !self.is_expired(now)
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

/// The expiry rail for `set_fee_exempt`, as a PURE function so it is unit-testable without a
/// validator. MANDATORY, strictly future, capped at `MAX_FEE_EXEMPT_TERM_SECONDS`. See the note on
/// `FeeExemptAccount::expires_at` for why zero is not a legitimate "never".
pub fn validate_fee_exempt_expiry(expires_at: i64, now: i64) -> Result<()> {
    require!(
        expires_at > now && expires_at <= now.saturating_add(MAX_FEE_EXEMPT_TERM_SECONDS),
        DominionError::FeeExemptExpiryInvalid
    );
    Ok(())
}

/// Resolve the premium to charge, given an optional exemption. A supplied but UNPROVABLE exemption
/// (wrong wallet, wrong side, expired) falls through to the full premium rather than erroring:
/// charging the fee is always safe, while erroring would turn a client bug into a denial of service.
/// The KYC gate resolves the same ambiguity the other way, because there fail-closed means denying.
pub fn effective_premium_bps(
    configured_bps: u16,
    exemption: Option<&FeeExemptAccount>,
    signer: &Pubkey,
    side: Side,
    now: i64,
) -> u16 {
    match exemption {
        Some(e) if e.exempts(signer, side, now) => 0,
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

    /// A LIVE exemption: valid at `T` and for a long while after.
    fn exemption(wallet: Pubkey, flags: u8) -> FeeExemptAccount {
        FeeExemptAccount {
            wallet,
            flags,
            added_at: 1,
            added_by: ADMIN,
            version: FEE_EXEMPT_ACCOUNT_VERSION,
            expires_at: T + 86_400,
            reserved: [0u8; 24],
        }
    }

    fn expiring(wallet: Pubkey, flags: u8, expires_at: i64) -> FeeExemptAccount {
        FeeExemptAccount {
            expires_at,
            ..exemption(wallet, flags)
        }
    }

    const T: i64 = 1_000;

    #[test]
    fn size_matches_the_struct() {
        assert_eq!(FeeExemptAccount::SIZE, 8 + 32 + 1 + 8 + 32 + 1 + 8 + 24);
        assert_eq!(FeeExemptAccount::SIZE, 114);
    }

    #[test]
    fn no_exemption_supplied_charges_the_full_premium() {
        assert_eq!(
            effective_premium_bps(100, None, &WALLET, Side::Mint, T),
            100
        );
        assert_eq!(
            effective_premium_bps(150, None, &WALLET, Side::Redeem, T),
            150
        );
    }

    #[test]
    fn a_mint_only_exemption_waives_mint_and_NOT_redeem() {
        let e = exemption(WALLET, SIDE_MINT_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T),
            0
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            150
        );
    }

    #[test]
    fn a_redeem_only_exemption_waives_redeem_and_NOT_mint() {
        let e = exemption(WALLET, SIDE_REDEEM_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T),
            100
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            0
        );
    }

    #[test]
    fn a_both_sides_exemption_waives_both() {
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T),
            0
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            0
        );
    }

    #[test]
    fn someone_elses_exemption_does_NOT_exempt_you_on_either_side() {
        // Unreachable while the PDA seeds bind the account; asserted for if they are ever relaxed.
        let e = exemption(OTHER, SIDE_ALL_BITS);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T),
            100
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            150
        );
    }

    #[test]
    fn an_unprovable_exemption_falls_through_rather_than_erroring() {
        // Charging the fee is the safe default: erroring would let a client bug become a DoS.
        let wrong_wallet = exemption(OTHER, SIDE_MINT_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&wrong_wallet), &WALLET, Side::Mint, T),
            100
        );
        let wrong_side = exemption(WALLET, SIDE_REDEEM_BIT);
        assert_eq!(
            effective_premium_bps(100, Some(&wrong_side), &WALLET, Side::Mint, T),
            100
        );
    }

    #[test]
    fn a_zero_configured_premium_stays_zero_either_way() {
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert_eq!(effective_premium_bps(0, None, &WALLET, Side::Mint, T), 0);
        assert_eq!(
            effective_premium_bps(0, Some(&e), &WALLET, Side::Mint, T),
            0
        );
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
    fn an_expiry_of_zero_grants_NOTHING() {
        // The writer refuses zero, so one can only appear via a half-written account.
        let e = expiring(WALLET, SIDE_ALL_BITS, 0);
        assert!(e.is_expired(T), "a zero expiry must read as expired");
        assert!(e.is_expired(0), "including at t=0");
        assert!(!e.exempts(&WALLET, Side::Mint, T));
        assert!(!e.exempts(&WALLET, Side::Redeem, T));
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T),
            100
        );
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            150
        );
    }

    #[test]
    fn an_expired_exemption_silently_stops_applying() {
        let e = expiring(WALLET, SIDE_ALL_BITS, 5_000);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 4_999),
            0
        );
        // Exactly at the expiry it is already gone: the boundary is inclusive.
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 5_000),
            100
        );
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 9_999),
            100
        );
    }

    #[test]
    fn expiry_applies_to_both_sides_independently_of_the_flags() {
        let e = expiring(WALLET, SIDE_ALL_BITS, 5_000);
        for side in [Side::Mint, Side::Redeem] {
            assert_eq!(
                effective_premium_bps(150, Some(&e), &WALLET, side, 4_000),
                0
            );
            assert_eq!(
                effective_premium_bps(150, Some(&e), &WALLET, side, 6_000),
                150
            );
        }
    }

    #[test]
    fn a_negative_or_zero_clock_cannot_resurrect_an_expired_exemption() {
        // `unix_timestamp` is not monotonic across validators and the check is a plain comparison, so
        // an expired exemption CAN come back during a backwards wobble, bounded by clock skew.
        let e = expiring(WALLET, SIDE_MINT_BIT, 5_000);
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 5_001),
            100
        );
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 4_999),
            0
        );
    }

    #[test]
    fn the_launch_fees_are_the_ones_being_waived() {
        use crate::state::config::{DEFAULT_PREMIUM_MINT_BPS, DEFAULT_PREMIUM_REDEEM_BPS};
        assert_eq!(DEFAULT_PREMIUM_MINT_BPS, 100);
        assert_eq!(DEFAULT_PREMIUM_REDEEM_BPS, 150);
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert_eq!(
            effective_premium_bps(DEFAULT_PREMIUM_MINT_BPS, Some(&e), &WALLET, Side::Mint, T),
            0
        );
        assert_eq!(
            effective_premium_bps(
                DEFAULT_PREMIUM_REDEEM_BPS,
                Some(&e),
                &WALLET,
                Side::Redeem,
                T
            ),
            0
        );
    }
    #[test]
    fn the_expiry_rail_requires_a_real_future_term() {
        const NOW: i64 = 1_700_000_000;
        // ZERO is refused: it used to be accepted and meant "forever" (audit C-01).
        assert!(validate_fee_exempt_expiry(0, NOW).is_err());
        // The past and the present instant are refused: a dead exemption would still show as active.
        assert!(validate_fee_exempt_expiry(NOW - 1, NOW).is_err());
        assert!(validate_fee_exempt_expiry(NOW, NOW).is_err());
        assert!(validate_fee_exempt_expiry(-1, NOW).is_err());
        // One second out is legal: the rail bounds the SHAPE, it does not second-guess the term.
        assert!(validate_fee_exempt_expiry(NOW + 1, NOW).is_ok());
        assert!(validate_fee_exempt_expiry(NOW + MAX_FEE_EXEMPT_TERM_SECONDS, NOW).is_ok());
        assert!(validate_fee_exempt_expiry(NOW + MAX_FEE_EXEMPT_TERM_SECONDS + 1, NOW).is_err());
        // The realistic fat finger: a 13-digit millisecond timestamp pasted where seconds go.
        assert!(validate_fee_exempt_expiry(NOW * 1_000, NOW).is_err());
    }

    #[test]
    fn the_rail_and_is_expired_agree_that_zero_is_not_a_term() {
        // Two code paths, one rule: changing only one of them breaks the grant or makes it permanent.
        const NOW: i64 = 1_700_000_000;
        assert!(
            validate_fee_exempt_expiry(0, NOW).is_err(),
            "writer must refuse zero"
        );
        assert!(
            expiring(WALLET, SIDE_ALL_BITS, 0).is_expired(NOW),
            "reader must treat zero as dead"
        );
    }
}
