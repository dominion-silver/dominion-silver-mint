use anchor_lang::prelude::*;

use crate::state::config::{GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS, MIN_ACTIVE_GUARDIANS};

/// Current GuardianAccount schema. Bumped whenever a field's meaning changes.
pub const GUARDIAN_ACCOUNT_VERSION: u8 = 1;

#[account]
pub struct GuardianAccount {
    pub guardian: Pubkey,
    pub added_at: i64,
    pub cooldown_until: i64, // 0 if active. Non-zero after removal: re-add requires now > cooldown_until
    // Unix timestamp at which `finalize_guardian_removal` may be applied, 0 when no
    // removal is scheduled. INVARIANT: the guardian stays ACTIVE for the whole
    // window, because every authorization site tests `cooldown_until == 0` and this
    // field does not touch that. That is what lets a targeted guardian pause, cancel
    // the action the removal was clearing the way for, and veto its own removal.
    pub pending_removal_at: i64,
    // Consumed the first time the TARGET cancels its own removal, capping the
    // self-veto at one use. Unlimited self-cancels would make a rogue guardian
    // permanently unremovable and hand it an indefinite halt (it may `pause`
    // repeatedly while `unpause` is admin-only). Reset only by a fresh appointment,
    // so a guardian can never restore its own budget.
    pub self_cancel_used: bool,
    pub version: u8,
    // Reserved so the next field is a logic change only. Growing this account
    // without realloc bricks every guardian path with AccountDidNotDeserialize while
    // admin-only paths keep working, which is an asymmetric brick.
    pub reserved: [u8; 32],
}

impl GuardianAccount {
    pub const SIZE: usize = 8 // discriminator
        + 32 // guardian
        + 8  // added_at
        + 8  // cooldown_until
        + 8  // pending_removal_at
        + 1  // self_cancel_used
        + 1  // version
        + 32; // reserved

    /// True only while the guardian is active AND is not itself the current admin.
    /// The admin exclusion is needed because admin-ship can move by admin transfer
    /// after an appointment, which `add_guardian` cannot see.
    // OPEN RESIDUAL: the floor checks count REGISTRATIONS and are blind to this
    // predicate, so an admin holding a second key K can appoint K, transfer
    // admin-ship to K, then remove the honest guardians. Every check still passes
    // while the surviving guardian is inert, so `guardian_count` overstates the veto.
    // Nothing is bricked (pause and cancel accept `is_admin || is_guardian`); the
    // INDEPENDENT veto is what is lost. Fix, not taken because it changes a
    // governance ABI: `accept_admin_transfer` should take the incoming admin's
    // guardian PDA and refuse while it is active. The admin console marks it INERT.
    pub fn may_act(&self, signer: &Pubkey, admin: &Pubkey) -> bool {
        self.guardian == *signer && self.cooldown_until == 0 && self.guardian != *admin
    }
}

/// Guardians that are active and NOT already scheduled for removal.
pub fn active_not_pending(guardian_count: u8, pending_removal_count: u8) -> u8 {
    guardian_count.saturating_sub(pending_removal_count)
}

/// Whether a NEW removal may be scheduled. The floor counts only guardians not
/// already under notice, so scheduling alone can never drive the set able to react
/// to zero: testing `guardian_count` alone would let one 24h window purge all of them.
pub fn may_schedule_removal(guardian_count: u8, pending_removal_count: u8) -> bool {
    active_not_pending(guardian_count, pending_removal_count) > MIN_ACTIVE_GUARDIANS
}

/// Whether a scheduled removal has aged out of its execution window. Without the
/// window a matured schedule stays armed forever, which is a stored instant-removal
/// coupon: pre-arm while quiet, evict later with no reaction time.
pub fn removal_schedule_expired(scheduled_at: i64, now: i64) -> bool {
    scheduled_at != 0 && now > scheduled_at.saturating_add(GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADMIN: Pubkey = Pubkey::new_from_array([1u8; 32]);
    const G: Pubkey = Pubkey::new_from_array([2u8; 32]);

    fn guardian(cooldown_until: i64) -> GuardianAccount {
        GuardianAccount {
            guardian: G,
            added_at: 1,
            cooldown_until,
            pending_removal_at: 0,
            self_cancel_used: false,
            version: GUARDIAN_ACCOUNT_VERSION,
            reserved: [0u8; 32],
        }
    }

    #[test]
    fn size_matches_the_struct() {
        assert_eq!(GuardianAccount::SIZE, 8 + 32 + 8 + 8 + 8 + 1 + 1 + 32);
        assert_eq!(GuardianAccount::SIZE, 98);
    }

    #[test]
    fn may_act_requires_active() {
        assert!(guardian(0).may_act(&G, &ADMIN));
        assert!(!guardian(12_345).may_act(&G, &ADMIN)); // in cooldown
    }

    #[test]
    fn may_act_rejects_a_foreign_signer() {
        let other = Pubkey::new_from_array([9u8; 32]);
        assert!(!guardian(0).may_act(&other, &ADMIN));
    }

    #[test]
    fn may_act_rejects_the_admin_wearing_both_hats() {
        assert!(!guardian(0).may_act(&G, &G));
    }

    #[test]
    fn floor_counts_only_guardians_not_under_notice() {
        assert_eq!(MIN_ACTIVE_GUARDIANS, 1);
        assert_eq!(active_not_pending(3, 1), 2);
        assert_eq!(active_not_pending(1, 5), 0); // saturating, never wraps

        assert!(may_schedule_removal(3, 0)); // 3 free
        assert!(may_schedule_removal(3, 1)); // 2 free
        assert!(!may_schedule_removal(3, 2)); // 1 free: scheduling it would leave 0
        assert!(!may_schedule_removal(2, 1)); // 1 free
        assert!(!may_schedule_removal(1, 0)); // already at the floor
        assert!(!may_schedule_removal(0, 0));
    }

    #[test]
    fn the_parallel_purge_from_the_review_is_now_blocked() {
        // All three must not be schedulable inside one window.
        let count = 3u8;
        let mut pending = 0u8;
        assert!(may_schedule_removal(count, pending));
        pending += 1;
        assert!(may_schedule_removal(count, pending));
        pending += 1;
        assert!(!may_schedule_removal(count, pending));
    }

    #[test]
    fn expiry_window_bounds_a_matured_schedule() {
        let eta = 1_000_000i64;
        assert!(!removal_schedule_expired(eta, eta - 1)); // not yet due
        assert!(!removal_schedule_expired(eta, eta)); // due, still valid
        assert!(!removal_schedule_expired(
            eta,
            eta + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS
        )); // last valid instant
        assert!(removal_schedule_expired(
            eta,
            eta + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS + 1
        ));
        // 0 means "nothing scheduled", which is never expired.
        assert!(!removal_schedule_expired(0, i64::MAX));
    }

    #[test]
    fn expiry_does_not_overflow_at_the_extremes() {
        assert!(!removal_schedule_expired(i64::MAX, i64::MAX));
    }

    // A model of the three handlers over (guardian_count, pending_removal_count,
    // pending_removal_at). Their INTERACTION is the only place the counter can
    // desynchronise, and the expired-re-arm branch skips both the floor check and
    // the increment, which would otherwise need a 31-day clock to reach on chain.
    const TIMELOCK: i64 = 86_400;

    #[derive(Debug, Clone, Copy, PartialEq)]
    struct Model {
        count: u8,
        pending: u8,
        /// pending_removal_at of the single guardian we track.
        at: i64,
    }

    impl Model {
        /// Mirrors remove_handler.
        fn schedule(&mut self, now: i64) -> core::result::Result<(), &'static str> {
            let existing = self.at;
            if !(existing == 0 || removal_schedule_expired(existing, now)) {
                return Err("AlreadyScheduled");
            }
            if existing == 0 {
                if !may_schedule_removal(self.count, self.pending) {
                    return Err("FloorBreached");
                }
                self.pending += 1;
            }
            self.at = now + TIMELOCK;
            Ok(())
        }
        /// Mirrors finalize_removal_handler.
        fn finalize(&mut self, now: i64) -> core::result::Result<(), &'static str> {
            if self.at == 0 {
                return Err("NotScheduled");
            }
            if now < self.at {
                return Err("NotElapsed");
            }
            if removal_schedule_expired(self.at, now) {
                return Err("Expired");
            }
            if self.count <= MIN_ACTIVE_GUARDIANS {
                return Err("FloorBreached");
            }
            self.at = 0;
            self.count -= 1;
            self.pending = self.pending.checked_sub(1).expect("underflow");
            Ok(())
        }
        /// Mirrors cancel_removal_handler.
        fn cancel(&mut self) -> core::result::Result<(), &'static str> {
            if self.at == 0 {
                return Err("NotScheduled");
            }
            self.at = 0;
            self.pending = self.pending.checked_sub(1).expect("underflow");
            Ok(())
        }
    }

    #[test]
    fn re_arming_an_expired_notice_does_not_double_count() {
        let mut m = Model {
            count: 2,
            pending: 0,
            at: 0,
        };
        m.schedule(1_000).unwrap();
        assert_eq!(m.pending, 1);
        // Already counted as pending, so re-arming must not increment again.
        let later = 1_000 + TIMELOCK + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS + 1;
        m.schedule(later).unwrap();
        assert_eq!(m.pending, 1, "re-arming double-counted the pending removal");
        assert_eq!(m.at, later + TIMELOCK); // a full fresh window, no zero-notice removal
    }

    #[test]
    fn re_arm_then_cancel_returns_the_counter_to_zero() {
        let mut m = Model {
            count: 2,
            pending: 0,
            at: 0,
        };
        m.schedule(1_000).unwrap();
        let later = 1_000 + TIMELOCK + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS + 1;
        m.schedule(later).unwrap();
        m.cancel().unwrap();
        assert_eq!(m.pending, 0);
        assert_eq!(m.at, 0);
    }

    #[test]
    fn an_expired_notice_cannot_be_finalized() {
        let mut m = Model {
            count: 2,
            pending: 0,
            at: 0,
        };
        m.schedule(1_000).unwrap();
        let dead = 1_000 + TIMELOCK + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS + 1;
        assert_eq!(m.finalize(dead), Err("Expired"));
        // Armed but dead: the counter stays at 1 until someone clears it.
        assert_eq!(m.pending, 1);
        m.cancel().unwrap();
        assert_eq!(m.pending, 0);
    }

    #[test]
    fn the_counter_never_underflows_across_any_ordering() {
        // Every ordering of the three transitions from a clean 2-guardian state.
        for ops in [
            vec!["s", "c", "s", "f"],
            vec!["s", "f", "s"],
            vec!["c", "s", "c"],
            vec!["f", "s", "c", "s"],
            vec!["s", "s", "c", "c"],
        ] {
            let mut m = Model {
                count: 2,
                pending: 0,
                at: 0,
            };
            let mut now = 1_000i64;
            for op in ops {
                let _ = match op {
                    "s" => m.schedule(now),
                    "f" => m.finalize(now),
                    _ => m.cancel(),
                };
                now += TIMELOCK + 1; // always past the ETA, never past the expiry
                assert!(
                    m.pending <= m.count,
                    "pending {} exceeded count {}",
                    m.pending,
                    m.count
                );
            }
        }
    }

    #[test]
    fn the_last_guardian_can_never_be_put_under_notice() {
        // count == 1 implies pending == 0, so the no-floor-check re-arm branch
        // can never apply to the last guardian.
        let mut m = Model {
            count: 1,
            pending: 0,
            at: 0,
        };
        assert_eq!(m.schedule(1_000), Err("FloorBreached"));
        assert_eq!(m.pending, 0);
        assert_eq!(m.at, 0);
    }
}
