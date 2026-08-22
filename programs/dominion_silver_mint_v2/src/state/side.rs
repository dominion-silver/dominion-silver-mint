//! Which user-facing action a per-wallet flag applies to.
//! Two different per-wallet mechanisms landed in the same batch (2026-08-05) and both are
//! per-SIDE rather than global:
//!   - the fee-exemption whitelist, where the admin panel must be able to waive the mint
//!     fee, the redeem fee, or both (, 2026-08-05);
//!   - the dormant KYC gate, where Mark's likely first step is redeem-only, keeping public
//!     mint open so DEX arbitrage still works.
//! Both are stored as a `u8` bitfield, and BOTH USE THE SAME BIT LAYOUT on purpose. This
//! module is the single place that layout is defined, so the two cannot drift into
//! disagreeing about which bit means "mint". Without it, `flags & 1` would appear in four
//! separate files and one of them would eventually be wrong.
//! The `Side` enum exists so that call sites pass a MEANING rather than a number. Passing
//! a raw bit works right up until somebody passes `1` for redeem.

// No anchor imports on purpose: this module is pure bit logic with no dependency on the
// error enum or on Anchor's Result alias, so it can be reasoned about and tested in
// isolation. Callers turn a `false` here into their own error.

/// Bit 0: the mint path.
pub const SIDE_MINT_BIT: u8 = 1 << 0;
/// Bit 1: the redeem path.
pub const SIDE_REDEEM_BIT: u8 = 1 << 1;
/// Every bit this program understands. Anything outside it is rejected on write, so an
/// unknown bit can never be stored and later reinterpreted by a future version.
pub const SIDE_ALL_BITS: u8 = SIDE_MINT_BIT | SIDE_REDEEM_BIT;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Mint,
    Redeem,
}

impl Side {
    pub fn bit(self) -> u8 {
        match self {
            Side::Mint => SIDE_MINT_BIT,
            Side::Redeem => SIDE_REDEEM_BIT,
        }
    }

    /// Whether `flags` selects this side.
    pub fn is_set_in(self, flags: u8) -> bool {
        (flags & self.bit()) != 0
    }
}

/// Whether `flags` is a usable non-empty selection.
/// Empty is rejected because both callers treat "no bits" as a mistake rather than as a
/// value: an exemption account that exempts nothing is dead rent, and it still reads as an
/// active exemption in any roster listing. Revoking is a separate instruction.
/// Unknown bits are rejected so a value written today cannot acquire a NEW meaning when a
/// future version defines bit 2. Storing bits nobody validates is how a dormant flag
/// becomes a live one by accident during an upgrade.
/// Returns a plain bool rather than `Result`, and takes no error code, deliberately. Two
/// reasons: this module stays free of any coupling to `DominionError`, so the bit layout
/// can be reasoned about on its own; and each caller raises its OWN error as a literal,
/// which is what keeps the variant name intact in logs. Threading the error code in as a
/// parameter does not even compile here, because Anchor's `require!` needs a path, not a
/// runtime value.
pub fn side_flags_valid_nonempty(flags: u8) -> bool {
    flags != 0 && (flags & !SIDE_ALL_BITS) == 0
}

/// Whether `flags` carries only defined bits. ALLOWS zero.
/// Used by the KYC scope, where 0 is meaningful and is in fact the launch posture: KYC
/// required on neither side. Turning the gate off entirely must not need its own
/// instruction.
pub fn side_flags_valid_allow_empty(flags: u8) -> bool {
    (flags & !SIDE_ALL_BITS) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_are_distinct_and_cover_all() {
        assert_eq!(Side::Mint.bit(), 1);
        assert_eq!(Side::Redeem.bit(), 2);
        assert_ne!(Side::Mint.bit(), Side::Redeem.bit());
        assert_eq!(SIDE_ALL_BITS, 3);
    }

    #[test]
    fn is_set_in_reads_only_its_own_bit() {
        assert!(Side::Mint.is_set_in(SIDE_MINT_BIT));
        assert!(!Side::Redeem.is_set_in(SIDE_MINT_BIT));
        assert!(Side::Redeem.is_set_in(SIDE_REDEEM_BIT));
        assert!(!Side::Mint.is_set_in(SIDE_REDEEM_BIT));
        assert!(Side::Mint.is_set_in(SIDE_ALL_BITS));
        assert!(Side::Redeem.is_set_in(SIDE_ALL_BITS));
        assert!(!Side::Mint.is_set_in(0));
        assert!(!Side::Redeem.is_set_in(0));
    }

    #[test]
    fn nonempty_validator_rejects_zero_and_unknown_bits() {
        assert!(side_flags_valid_nonempty(SIDE_MINT_BIT));
        assert!(side_flags_valid_nonempty(SIDE_REDEEM_BIT));
        assert!(side_flags_valid_nonempty(SIDE_ALL_BITS));
        assert!(!side_flags_valid_nonempty(0));
        // Bit 2 is not defined. A future version might define it; today it must not store.
        assert!(!side_flags_valid_nonempty(0b100));
        assert!(!side_flags_valid_nonempty(0xFF));
        // A valid bit ORed with an invalid one is still rejected, not silently masked.
        assert!(!side_flags_valid_nonempty(SIDE_MINT_BIT | 0b100));
    }

    #[test]
    fn allow_empty_validator_accepts_zero_but_still_rejects_unknown_bits() {
        assert!(side_flags_valid_allow_empty(0));
        assert!(side_flags_valid_allow_empty(SIDE_ALL_BITS));
        assert!(!side_flags_valid_allow_empty(0b100));
        assert!(!side_flags_valid_allow_empty(SIDE_REDEEM_BIT | 0b1000));
    }
}
