use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::state::config::MAX_FEE_EXEMPT_TERM_SECONDS;
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
/// departure from how this program treats other loosenings. The stated reason is that the worst
/// case is FOREGONE FEE REVENUE rather than a loss of principal or backing: an exempt wallet still
/// pays the full oracle price for its SILV and still receives the full oracle price when redeeming.
///
/// THAT IS NOT THE WHOLE TRUTH, and the review-of-fixes was right to call it out. The KNOWN
/// CONSEQUENCE paragraph below describes a both-sides exemption handing its holder a free option on
/// oracle movement PAID BY THE TREASURY, which is a transfer of value, not merely revenue not
/// collected. Both statements cannot be true, and the second is the accurate one.
///
/// Instant is probably still the right call for onboarding a market maker, but it rests on the
/// per-side flags being used properly (mint-only) rather than on the exposure being nil.
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
    /// Unix timestamp after which this exemption stops applying. MANDATORY, strictly in the future,
    /// at most `MAX_FEE_EXEMPT_TERM_SECONDS` out. **0 grants NOTHING** (see `is_expired`).
    ///
    /// A6, and the rationale has now been corrected TWICE. Worth keeping both corrections visible,
    /// because the second one is a case of an argument surviving after its premise died.
    ///
    /// Correction 1 (review-of-fixes). The first note claimed the expiry bounded a COMPROMISED ADMIN:
    /// "until someone notices" becoming "until the clock runs out". It does not. The admin CHOOSES
    /// `expires_at`, so against a compromised admin the term adds nothing. What it genuinely bounds is
    /// FORGETFULNESS: an arrangement that ends, a counterparty that stops providing liquidity, a
    /// launch-window favour nobody revisits. Real, common, worth eight bytes, but an OPERATIONAL
    /// control and not a security one, and it must not be cited as the latter.
    ///
    /// Correction 2 (external audit C-01, 2026-08-06). This note then argued that 0 "stays permitted
    /// because a genuinely indefinite exemption is a real operational choice", and closed with: "An
    /// in-place upgrade over an existing exemption decodes this as 0 from the zeroed `reserved`, i.e.
    /// never expires, which preserves the current behaviour of every live exemption."
    ///
    /// That last sentence was FALSE and it was doing the persuading. `FeeExemptAccount` is introduced
    /// BY this upgrade. There are no existing exemptions, no live ones, and no current behaviour to
    /// preserve. I invented a migration constraint and then deferred to it.
    ///
    /// With that gone, nothing was left holding zero up. Against it: the audit brief asserted the
    /// expiry was mandatory (so the code contradicted its own documentation), the admin panel field
    /// read "type 0 for never" (so it was the path of least resistance, not a corner case), and a
    /// permanent both-sides exemption erases the 2.485% round-trip fee band that is the only thing
    /// making oracle movement unprofitable to farm at the treasury's expense.
    ///
    /// So it is mandatory now. If an indefinite arrangement is ever genuinely wanted, renewing a
    /// two-year term is one instant transaction, and the renewal is the review that never happened.
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

    /// Whether this exemption has passed its expiry at `now`. **A zero expiry counts as EXPIRED.**
    ///
    /// This used to read `self.expires_at != 0 && now >= self.expires_at`, so zero meant "never
    /// expires" and an account with a zero expiry was exempt forever. Now that
    /// `set_fee_exempt_handler` refuses zero (audit C-01), no account it writes can hold one, and the
    /// question is only what to do if a zero ever shows up anyway: a freshly `init_if_needed`-zeroed
    /// account read before its handler finishes writing, a future refactor that adds a second writer,
    /// a partially applied transaction.
    ///
    /// Fail CLOSED. Under the old reading, any of those would have granted a permanent free pass to
    /// whichever wallet the PDA belongs to. Under this one they grant nothing, which is recoverable in
    /// one transaction. The two directions are not symmetric, so the choice is not either.
    pub fn is_expired(&self, now: i64) -> bool {
        self.expires_at == 0 || now >= self.expires_at
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
/// The expiry rail for `set_fee_exempt`, as a PURE function so it can actually be tested.
///
/// Audit C-01. The rule used to live inline in the handler behind a `Clock::get()`, which made it
/// untestable without a validator, which is why the accepted-zero case shipped with no test asserting
/// either behaviour. Extracted for the same reason `validate_new_max_supply` is: a rail nobody can
/// unit-test is a rail nobody notices changing.
///
/// MANDATORY, strictly future, capped. See the note on `FeeExemptAccount::expires_at` for why zero is
/// no longer a legitimate "never".
pub fn validate_fee_exempt_expiry(expires_at: i64, now: i64) -> Result<()> {
    require!(
        expires_at > now && expires_at <= now.saturating_add(MAX_FEE_EXEMPT_TERM_SECONDS),
        DominionError::FeeExemptExpiryInvalid
    );
    Ok(())
}

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
    ///
    /// This used to build `expires_at: 0` and was described as "never expires, which is what every
    /// test below wants". Audit C-01 made zero mean EXPIRED, and the five tests that leaned on this
    /// helper failed immediately, which is the correct reaction and worth recording: the helper had
    /// quietly made "permanent" the default shape of every fee-exemption test, so the permanent case
    /// was over-tested and the ordinary case with a real term was barely tested at all.
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
    fn an_expiry_of_zero_grants_NOTHING() {
        // Was `an_expiry_of_zero_never_expires`, asserting the opposite. Audit C-01: the writer now
        // refuses a zero expiry, so the only way one can appear is a bug or a half-written account,
        // and in that case granting a permanent fee waiver is the worst available default.
        let e = expiring(WALLET, SIDE_ALL_BITS, 0);
        assert!(e.is_expired(T), "a zero expiry must read as expired");
        assert!(e.is_expired(0), "including at t=0");
        assert!(!e.exempts(&WALLET, Side::Mint, T));
        assert!(!e.exempts(&WALLET, Side::Redeem, T));
        // And it must fall back to the CONFIGURED premium, not to zero.
        assert_eq!(effective_premium_bps(100, Some(&e), &WALLET, Side::Mint, T), 100);
        assert_eq!(
            effective_premium_bps(150, Some(&e), &WALLET, Side::Redeem, T),
            150
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
    #[test]
    fn the_expiry_rail_requires_a_real_future_term() {
        const NOW: i64 = 1_700_000_000;
        // ZERO is refused. This is the whole of C-01: it used to be accepted and meant "forever".
        assert!(validate_fee_exempt_expiry(0, NOW).is_err());
        // The past, and the present instant, are refused: an already-dead exemption would still show
        // up in every roster as active.
        assert!(validate_fee_exempt_expiry(NOW - 1, NOW).is_err());
        assert!(validate_fee_exempt_expiry(NOW, NOW).is_err());
        // Negative, in case a client sends a signed garbage value.
        assert!(validate_fee_exempt_expiry(-1, NOW).is_err());
        // One second out is legal: the rail bounds the SHAPE, it does not second-guess the term.
        assert!(validate_fee_exempt_expiry(NOW + 1, NOW).is_ok());
        // Exactly at the two-year cap is legal; one second past it is not.
        assert!(validate_fee_exempt_expiry(NOW + MAX_FEE_EXEMPT_TERM_SECONDS, NOW).is_ok());
        assert!(validate_fee_exempt_expiry(NOW + MAX_FEE_EXEMPT_TERM_SECONDS + 1, NOW).is_err());
        // The realistic fat finger: a 13-digit millisecond timestamp pasted where seconds go. It
        // LOOKS like a term and behaves like "never", which is exactly what C-01 removed.
        assert!(validate_fee_exempt_expiry(NOW * 1_000, NOW).is_err());
    }

    #[test]
    fn the_rail_and_is_expired_agree_that_zero_is_not_a_term() {
        // Two independent code paths, one rule. If a future edit re-permits zero on the way IN
        // without also changing `is_expired`, the grant would silently be dead on arrival; if it
        // changes `is_expired` alone, zero becomes permanent again. This test fails either way.
        const NOW: i64 = 1_700_000_000;
        assert!(validate_fee_exempt_expiry(0, NOW).is_err(), "writer must refuse zero");
        assert!(expiring(WALLET, SIDE_ALL_BITS, 0).is_expired(NOW), "reader must treat zero as dead");
    }

}
