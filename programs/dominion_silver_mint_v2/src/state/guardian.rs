use anchor_lang::prelude::*;

use crate::state::config::{GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS, MIN_ACTIVE_GUARDIANS};

/// Current GuardianAccount schema. Bumped whenever a field's meaning changes.
pub const GUARDIAN_ACCOUNT_VERSION: u8 = 1;

#[account]
pub struct GuardianAccount {
    pub guardian: Pubkey,
    pub added_at: i64,
    pub cooldown_until: i64, // 0 if active. Non-zero after removal: re-add requires now > cooldown_until
    // AUDIT action 0.12b (DOM-007 real fix): deferred removal. 0 means no removal
    // is scheduled. Non-zero is the timestamp at which `finalize_guardian_removal`
    // may be applied. Crucially the guardian stays ACTIVE while this is pending,
    // because every authorization site tests `cooldown_until == 0` and this field
    // does not touch that. So a guardian targeted by a compromised admin keeps its
    // pause and cancel powers for the whole window and can veto its own removal.
    pub pending_removal_at: i64,
    // AUDIT review of daac4ac (P0, found independently by two reviewers): the
    // self-veto was originally UNLIMITED, which made a rogue guardian permanently
    // unremovable and handed it an indefinite protocol halt (a guardian may `pause`
    // repeatedly while `unpause` is admin-only). One self-cancel is enough to defeat
    // a single opportunistic removal and to force the admin to re-commit publicly;
    // unlimited self-cancels invert the model the deferral exists to serve.
    // Consumed the first time the TARGET cancels its own removal. Reset only by a
    // fresh appointment (add_guardian, which is admin-only and requires the removal
    // cooldown to have elapsed), so a guardian can never restore its own budget.
    pub self_cancel_used: bool,
    pub version: u8,
    // AUDIT review of daac4ac (P1): this account grew 56 -> 64 with no realloc and no
    // version byte, so the first in-place upgrade over a deployment that already held
    // guardians would have bricked every guardian path with AccountDidNotDeserialize
    // while leaving admin-only paths working: an asymmetric brick. Reserved space and
    // a version byte so the next field is a logic change only. ConfigAccount has had
    // both from the start for exactly this reason; this account should have too.
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

    /// A guardian may exercise its powers only while active AND while it is not
    /// itself the current admin.
    ///
    /// The second half closes the appointment-then-transfer overlap a reviewer
    /// raised: `add_guardian` refuses `config.admin`, but admin-ship can move
    /// afterwards via propose/accept_admin_transfer, so without this check one key
    /// could hold both roles and "the admin is not a guardian" would silently stop
    /// being true. It costs nothing operationally, because every guardian power
    /// (pause, cancel_timelocked_action, cancel_admin_transfer) is already available
    /// to the admin directly.
    ///
    /// RESIDUAL, found by the review-of-fixes and NOT closed here. Both floor checks
    /// count REGISTRATIONS, and this predicate is invisible to them. So an admin
    /// holding a second key K can: add K as a guardian (legal, no transfer pending),
    /// transfer admin-ship to K, then remove the honest guardians. The end state
    /// passes every check: `guardian_count == MIN_ACTIVE_GUARDIANS`,
    /// `pending_removal_count == 0`, no error, no event, and the surviving "guardian"
    /// is the admin, whose powers this predicate refuses. The config then claims a
    /// veto that no independent key can exercise.
    ///
    /// Scope of the harm, precisely: the ADMIN can still pause and cancel (every such
    /// site checks `is_admin || is_guardian`), so nothing is bricked. What is lost is
    /// the INDEPENDENT veto, and what is wrong is that `guardian_count`
    /// misrepresents it. This is the same end state as the residual already documented
    /// in the MIN_ACTIVE_GUARDIANS comment (an admin can appoint puppets it controls);
    /// this path merely makes the puppet inert rather than active.
    ///
    /// Structural fix, recommended and deliberately not taken in this pass because it
    /// changes a governance instruction's ABI: `accept_admin_transfer` should take the
    /// incoming admin's guardian PDA as a seeds-bound account and refuse to complete
    /// while that guardian is active. Raising MIN_ACTIVE_GUARDIANS does not help, the
    /// same trick works one step later. Until then the guardian roster in the admin
    /// console marks a guardian whose key equals the admin as INERT, so an operator
    /// can at least see the state.
    pub fn may_act(&self, signer: &Pubkey, admin: &Pubkey) -> bool {
        self.guardian == *signer && self.cooldown_until == 0 && self.guardian != *admin
    }
}

/// Guardians that are active and NOT already scheduled for removal.
pub fn active_not_pending(guardian_count: u8, pending_removal_count: u8) -> u8 {
    guardian_count.saturating_sub(pending_removal_count)
}

/// Whether a NEW removal may be scheduled.
///
/// AUDIT review of daac4ac (P1): the floor used to be tested against
/// `guardian_count` alone, so with 3 guardians an admin could schedule all 3 (each
/// passing `3 > 1`) and the whole purge cost ONE 24h window instead of three. The
/// floor now counts only guardians not already under notice, so the set of guardians
/// able to react can never be driven to zero by scheduling alone.
pub fn may_schedule_removal(guardian_count: u8, pending_removal_count: u8) -> bool {
    active_not_pending(guardian_count, pending_removal_count) > MIN_ACTIVE_GUARDIANS
}

/// Whether a scheduled removal has aged out of its execution window.
///
/// AUDIT review of daac4ac (P1): `finalize` only checked `now >= scheduled`, so a
/// matured schedule stayed armed forever. That turned an old schedule into a stored
/// instant-removal coupon: pre-arm during quiet operation, then evict with zero
/// reaction window whenever convenient. `pending_admin_expires_at` already solved
/// exactly this for the sibling admin-transfer mechanism.
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
        // The overlap add_guardian cannot prevent, because admin-ship can move
        // after the appointment.
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
        // 3 guardians. Before this fix all three could be scheduled inside one
        // window, so the entire guardian set could be cleared for the price of a
        // single 24h delay.
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

    // ---------------------------------------------------------------------
    // The review-of-fixes noted that `may_schedule_removal` and
    // `removal_schedule_expired` were each tested as pure predicates, but their
    // INTERACTION inside remove_handler is the only place `pending_removal_count`
    // can desynchronise, and it had no coverage at all (the expired-re-arm branch
    // skips BOTH the floor check and the increment, and needs a 31-day clock to
    // reach on-chain). This is a model of the three handlers over
    // (guardian_count, pending_removal_count, pending_removal_at) so the
    // interaction is exercised without a validator.
    // ---------------------------------------------------------------------
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
        // Let it expire, then re-arm. The guardian was already counted as pending,
        // so the counter must NOT increment again.
        let later = 1_000 + TIMELOCK + GUARDIAN_REMOVAL_EXEC_WINDOW_SECONDS + 1;
        m.schedule(later).unwrap();
        assert_eq!(m.pending, 1, "re-arming double-counted the pending removal");
        // And the fresh ETA is a full timelock away: no zero-notice removal.
        assert_eq!(m.at, later + TIMELOCK);
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
        // Still armed-but-dead, and the counter is still 1 until someone clears it.
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
        // Corollary the review verified by hand: count == 1 implies pending == 0, so
        // the no-floor-check re-arm branch can never apply to the last guardian.
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
