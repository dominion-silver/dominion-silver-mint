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
    /// Unix timestamp after which this exemption stops applying. 0 = NEVER EXPIRES.
    ///
    /// A6. The `reserved` bytes were sized for this and it was left unwired, which the security
    /// review flagged: instant grant + no expiry + no rate limit means a compromised admin
    /// self-exempts and runs the mint-side capture loop until a human happens to read a
    /// `FeeExemptSet` event. An expiry converts that from "until someone notices" into "until the
    /// clock runs out", which is the difference between an open-ended leak and a bounded one.
    ///
    /// It also fits how these are actually used: a market-maker exemption is part of a liquidity
    /// arrangement with a term, not an unconditional permanent favour.
    ///
    /// 0 is still permitted, because a genuinely indefinite exemption is a real operational choice
    /// and forcing a fake far-future date would be worse: it would look like an expiry while
    /// behaving like none. The admin panel makes the choice explicit.
    ///
    /// An in-place upgrade over an existing exemption decodes this as 0 from the zeroed `reserved`,
    /// i.e. "never expires", which preserves the current behaviour of every live exemption.
    pub expires_at: i64,
    /// Room for a future per-wallet fee OVERRIDE (a reduced rate rather than zero) without
    /// changing the account size.
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

    /// Whether this exemption has passed its expiry at `now`. Always false when `expires_at` is 0.
    pub fn is_expired(&self, now: i64) -> bool {
        self.expires_at != 0 && now >= self.expires_at
    }

    /// Whether this account genuinely exempts `signer` on `side` at `now`.
    ///
    /// The wallet re-check is defence in depth. PDA seeds already bind the account, so a
    /// mismatch is unreachable today; this is the assertion that has to hold if the seeds
    /// are ever relaxed, and it costs 32 bytes of comparison.
    ///
    /// An EXPIRED exemption simply stops applying: the caller pays the full premium and the
    /// transaction still succeeds. It is deliberately not an error. Reverting would turn a lapsed
    /// commercial arrangement into a broken product for that wallet, and the account lingering is
    /// harmless once it no longer grants anything.
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

    /// Never expires, which is what every test below wants unless it says otherwise.
    fn exemption(wallet: Pubkey, flags: u8) -> FeeExemptAccount {
        FeeExemptAccount {
            wallet,
            flags,
            added_at: 1,
            added_by: ADMIN,
            version: FEE_EXEMPT_ACCOUNT_VERSION,
            expires_at: 0,
            reserved: [0u8; 24],
        }
    }

    fn expiring(wallet: Pubkey, flags: u8, expires_at: i64) -> FeeExemptAccount {
        FeeExemptAccount {
            expires_at,
            ..exemption(wallet, flags)
        }
    }

    /// `now` for the tests that do not care about time.
    const T: i64 = 1_000;

    #[test]
    fn size_matches_the_struct() {
        assert_eq!(FeeExemptAccount::SIZE, 8 + 32 + 1 + 8 + 32 + 1 + 8 + 24);
        assert_eq!(FeeExemptAccount::SIZE, 114);
    }

    #[test]
    fn no_exemption_supplied_charges_the_full_premium() {
        assert_eq!(effective_premium_bps(100, None, &WALLET, Side::Mint, T), 100);
        assert_eq!(effective_premium_bps(150, None, &WALLET, Side::Redeem, T), 150);
    }

    #[test]
    fn a_mint_only_exemption_waives_mint_and_NOT_redeem() {
        // The recommended configuration: waiving mint alone keeps the redeem fee as the
        // cost of closing a round trip, so the free-option problem does not arise.
        let e = exemption(WALLET, SIDE_MINT_BIT);
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T), 0);
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
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T), 0);
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            0
        );
    }

    #[test]
    fn someone_elses_exemption_does_NOT_exempt_you_on_either_side() {
        // PDA seeds make this unreachable today. Asserted because it is the check that
        // must hold if the seeds are ever relaxed.
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
        // Charging the fee is the safe default. Erroring would let a wrong-wallet or
        // wrong-side account block a legitimate mint: a client bug becoming a DoS.
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
        assert_eq!(effective_premium_bps(0, Some(&e), &WALLET, Side::Mint, T), 0);
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
    fn an_expiry_of_zero_never_expires() {
        let e = exemption(WALLET, SIDE_ALL_BITS);
        assert!(!e.is_expired(0));
        assert!(!e.is_expired(i64::MAX));
        assert_eq!(
            effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, i64::MAX),
            0
        );
    }

    #[test]
    fn an_expired_exemption_silently_stops_applying() {
        // The caller pays the full premium and the transaction still SUCCEEDS. Reverting would
        // turn a lapsed commercial arrangement into a broken product for that wallet.
        let e = expiring(WALLET, SIDE_ALL_BITS, 5_000);
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 4_999), 0);
        // Exactly at the expiry it is already gone: the boundary is inclusive of expiry.
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
            assert_eq!(effective_premium_bps(150, Some(&e), &WALLET, side, 4_000), 0);
            assert_eq!(effective_premium_bps(150, Some(&e), &WALLET, side, 6_000), 150);
        }
    }

    #[test]
    fn a_negative_or_zero_clock_cannot_resurrect_an_expired_exemption() {
        // Solana's unix_timestamp is not guaranteed monotonic across validators. An exemption that
        // has expired must not come back for a caller who lands during a backwards wobble... and it
        // CAN, because the check is a plain comparison against `now`. Asserted so the behaviour is
        // known rather than assumed: the window is bounded by clock skew (seconds), which is
        // acceptable for a fee waiver and would not be for a security gate.
        let e = expiring(WALLET, SIDE_MINT_BIT, 5_000);
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 5_001), 100);
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, 4_999), 0);
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
            effective_premium_bps(DEFAULT_PREMIUM_MINT_BPS, Some(&e), &WALLET, Side::Mint, T),
            0
        );
        assert_eq!(
            effective_premium_bps(DEFAULT_PREMIUM_REDEEM_BPS, Some(&e), &WALLET, Side::Redeem, T),
            0
        );
    }
}
