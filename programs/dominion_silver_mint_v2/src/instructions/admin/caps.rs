// Instant admin parameter setters. The remaining instant surface after FIX A
// (launch spec 2026-07):
//   - set_max_silv_supply: TIGHTEN-ONLY (lower instant; raise blocked entirely).
//   - set_redemptions_enabled: FALSE-ONLY (disable instant; enable blocked at
//     launch, Codex P0-01).
//   - emergency_tighten_redeem_limits: the SINGLE instant fast-lane for the four
//     redeem throttles, and it accepts SAFE-DIRECTION values only. LOOSENING any
//     of the four goes through the 24h-timelocked SetRedeemLimits (propose.rs /
//     execute.rs). This closes the head-dev "one-block drain": an admin can no
//     longer strip the redemption rate-limits in a single instant tx.
//   - set_min_operation_usdc: BOTH directions instant, bounded by
//     MIN_OPERATION_CEILING_USDC (round 5 P1-04). The one setter here with no
//     direction asymmetry, because neither direction risks value; the reasoning is
//     written out at the handler.
//
// The four individual instant throttle setters (set_instant_redeem_budget /
// _window, set_large_redeem_threshold, set_redeem_queue_delay) were REMOVED in
// favour of the single tighten-only entrypoint above (CORRECTION-2 clean shape:
// one place for the counter-intuitive direction logic instead of four).
//
// Float (treasury_min_float_usdc) and premiums/oracle-guards remain 24h-timelocked
// (propose/execute), as before.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint as InterfaceMint;

use crate::errors::DominionError;
use crate::events::{
    MaxSupplyChanged, MinOperationChanged, PublicMintEnabledChanged, RedeemLimitsTightened,
    RedemptionsEnabledChanged,
};
use crate::instructions::admin::execute::{
    redeem_limits_all_tighten, redeem_limits_any_set, redeem_limits_effective_change,
    validate_redeem_limits_ceilings, RedeemLimitsArgs,
};
use crate::state::*;

/// AUDIT A-31: set_max_silv_supply needs to read the LIVE mint supply, so it gets
/// its own Accounts struct rather than adding a required account to the shared
/// `SetParam` (which would change the ABI of set_redemptions_enabled and
/// emergency_tighten_redeem_limits too, for no reason).
#[derive(Accounts)]
pub struct SetMaxSupply<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,

    /// Read-only, pinned to the configured SILV mint so the supply cannot be
    /// spoofed by passing a different mint.
    #[account(address = config.silv_mint @ DominionError::WrongMint)]
    pub silv_mint: InterfaceAccount<'info, InterfaceMint>,
}

#[derive(Accounts)]
pub struct SetParam<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,
}

/// D2 (launch spec 2026-07): the HARD SILV supply cap, atomic SILV (oz * 1e6).
/// TIGHTEN-ONLY: lowering the cap is instant (a safety action), but RAISING it is
/// rejected. At launch the cap is fixed at the physical allocation (100k oz) and
/// there is no live PoR, so an instant raise would let a compromised admin
/// pre-mint unbacked SILV. Raising the cap comes later, driven by the PoR feed
/// (Phase 2) or a timelocked setter (Phase 1); `pending_max_supply_nonce` is
/// reserved for that path.
pub fn set_max_silv_supply_handler(ctx: Context<SetMaxSupply>, new_max: u64) -> Result<()> {
    let old_max = ctx.accounts.config.max_silv_supply;
    let live_supply = ctx.accounts.silv_mint.supply;
    validate_new_max_supply(new_max, old_max, live_supply)?;
    ctx.accounts.config.max_silv_supply = new_max;
    // SolidProof LOW #3: this setter was silent. The cap is TIGHTEN-ONLY, so every
    // change here is irreversible and belongs in the log.
    emit!(MaxSupplyChanged {
        old_max,
        new_max,
        live_supply,
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}

/// The whole decision, extracted so it is unit-testable without a Context.
///
/// AUDIT review of daac4ac (P1, raised by two reviewers): a comment in
/// `scripts/e2e-fixa-devnet.ts` claimed the success branch of the invariant below was
/// "covered by the caps.rs unit tests instead". It was not. This file had no test
/// module at all, so `>=` written as `>` would have shipped undetected, taking with it
/// the documented ability to shrink headroom all the way to the live supply.
pub fn validate_new_max_supply(new_max: u64, current_cap: u64, live_supply: u64) -> Result<()> {
    require!(
        new_max <= MAX_SILV_SUPPLY_CEILING,
        DominionError::AboveMaximum
    );
    require!(new_max <= current_cap, DominionError::SupplyCapRaiseBlocked);
    // AUDIT A-31: because raising the cap is blocked, lowering it BELOW the live
    // supply is irreversible from the panel and permanently kills admin_premint,
    // the only mint path at launch. The only exit would be a program upgrade. The
    // minimal invariant the review recommended: never let the cap fall under what
    // is already minted. Headroom can still be shrunk all the way to the current
    // supply, so the emergency "stop issuing more" action is preserved; what is
    // refused is the fat-finger that bricks the instruction.
    //
    // Read from the REAL mint rather than a tracked counter, so the check cannot
    // drift. If a deliberate permanent halt is ever wanted, it should be a separate,
    // explicitly named, separately confirmed instruction, not a side effect of this
    // setter (open product decision, see the master audit doc section 13.4).
    require!(new_max >= live_supply, DominionError::SupplyCapBelowSupply);
    Ok(())
}

/// The manual redemptions switch is FALSE-ONLY on this lane: DISABLING is instant, ENABLING always
/// reverts `RedemptionsEnableBlocked`. That asymmetry is the whole point and it has not moved.
///
/// ROUND 8 T8-08 CORRECTS WHAT THIS COMMENT USED TO CLAIM. It said redemptions were
/// "cryptographically off at launch" and that enabling would need a Phase 1 UPGRADE. Both were
/// false, and the second was false even when it was written: the 24h-timelocked `SetRedeemLimits`
/// action carries `redemptions_enabled` and `execute.rs` writes it, so opening has always been a
/// governance action and never a code change. Since the 2026-08-09 posture change `initialize` also
/// ships the switch OPEN, so there is nothing "off" here to begin with.
///
/// What this refusal actually buys, stated without the overclaim: a compromised admin cannot REOPEN
/// redemptions in one transaction after an emergency close. It must announce the reopen, wait the
/// full 24h and survive a guardian cancel. It does NOT stop that admin from draining an already-open
/// protocol, and it never did: the rolling budget is the only brake there, and it bounds the RATE,
/// not the total. See `redeem_window.rs` and the D11 custody note in config/mainnet-authorities.json.
pub fn set_redemptions_enabled_handler(ctx: Context<SetParam>, enabled: bool) -> Result<()> {
    require!(!enabled, DominionError::RedemptionsEnableBlocked);
    // NO-OP GUARD, mirroring `set_public_mint_enabled_handler`. Its absence was not cosmetic: this
    // handler DISARMS any pending open (below), so calling it while redemptions were already closed
    // succeeded and silently destroyed a queued proposal. A defensive "let me confirm redemptions are
    // off" click during pre-launch cost 24 hours. That was the reachable half of the cancel-wipes-a-
    // live-proposal sequence the review-of-fixes found.
    require!(
        ctx.accounts.config.redemptions_enabled,
        DominionError::ProposalNoOp
    );
    let old_enabled = ctx.accounts.config.redemptions_enabled;
    ctx.accounts.config.redemptions_enabled = enabled;
    // DISARM any pending SetRedeemLimits proposal, mirroring what
    // `set_public_mint_enabled_handler` does for its own nonce and for the same stated reason:
    // leaving one armed after a deliberate emergency close would let the open land later
    // without a fresh decision.
    //
    // This is only effective because `execute_set_redeem_limits` now REQUIRES
    // `pending_redeem_limits_nonce == Some(nonce)`. Before that check existed, clearing this
    // field did nothing at all: the execute handler never read it.
    //
    // Yes, this also discards any unrelated numeric loosening the proposal carried. That is the
    // right trade during an incident: losing a queued budget raise costs one re-proposal, while
    // keeping it armed costs an unwanted re-open at the worst possible moment.
    if let Some(orphan) = ctx.accounts.config.pending_redeem_limits_nonce {
        // Breadcrumb, because disarming the slot leaves the timelock ACCOUNT alive and it still
        // counts toward MAX_ACTIVE_PROPOSALS. The only exit is `cancel_timelocked_action(orphan)`,
        // which needs the nonce, and which CLOSES the account. (This used to say a rent sweeper
        // refused the orphan; that sweeper is gone, because every path that could have fed it closes
        // the account itself. The exit is the same one it always was.) Without this the operator would have to enumerate every surviving timelock account
        // to find it. Repeated disarm-then-re-propose cycles otherwise leak count slots until every
        // propose_* reverts TooManyActiveProposals.
        msg!(
            "disarmed pending redeem-limits proposal nonce {}: cancel_timelocked_action({}) to free the slot and reclaim rent",
            orphan,
            orphan
        );
    }
    ctx.accounts.config.pending_redeem_limits_nonce = None;
    // SolidProof LOW #3.
    emit!(RedemptionsEnabledChanged {
        old_enabled,
        new_enabled: enabled,
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}

/// Instant CLOSE of the public mint path. FALSE-ONLY, mirroring
/// `set_redemptions_enabled` and the FIX A tighten-fast/loosen-slow asymmetry.
///
/// Closing is the emergency direction and must take one transaction: if the Lazer feed
/// misbehaves, or a publisher set degrades, or a price band looks wrong, public minting
/// has to stop NOW rather than in 24 hours. OPENING goes through
/// `propose_set_public_mint` + `execute_set_public_mint` so it is announced, delayed and
/// guardian-cancellable.
///
/// Note what this does NOT touch: the pre-mint path. `admin_premint` has never depended
/// on `public_mint_enabled`, so closing public mint in an emergency does not block
/// inventory operations, and pausing the protocol (which does block them) stays a
/// separate, coarser lever.
pub fn set_public_mint_enabled_handler(ctx: Context<SetParam>, enabled: bool) -> Result<()> {
    require!(!enabled, DominionError::PublicMintOpenRequiresTimelock);
    let old_enabled = ctx.accounts.config.public_mint_enabled;
    require!(old_enabled != enabled, DominionError::PublicMintUnchanged);
    ctx.accounts.config.public_mint_enabled = enabled;
    // Also clear any in-flight OPEN proposal: leaving one pending after a deliberate
    // emergency close would let the open land later without a fresh decision.
    // NOTE ON REACHABILITY, from the review-of-fixes. This clear can never fire on a LIVE nonce:
    // `propose_set_public_mint` requires `new_value != public_mint_enabled` with `new_value` forced
    // true, so a pending open can only exist while the mint is CLOSED, and this handler requires
    // `old_enabled != enabled`, so it reverts PublicMintUnchanged when the mint is already closed.
    // The two states are mutually exclusive.
    //
    // Kept for uniformity with the redeem switch, and harmless. But commit 1851324's headline
    // justification for the A7 bind ("closing the public mint did not disarm a pending open, so the
    // mint would re-open on its own schedule") described a sequence that cannot occur. The bind is
    // still right and still buys a redundant second reason for a cancelled proposal to fail; it was
    // not the urgent one, and the redeem switch was.
    ctx.accounts.config.pending_public_mint_nonce = None;
    emit!(PublicMintEnabledChanged {
        old_enabled,
        new_enabled: enabled,
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}

/// ROUND 5 P1-04: the minimum size of a priced operation, atomic USDC, on BOTH sides. INSTANT IN
/// BOTH DIRECTIONS,
/// bounded by `MIN_OPERATION_CEILING_USDC`, and that asymmetry-free shape is deliberate.
///
/// Why it exists: D2 made the Lazer anti-replay strict, so `last_used_feed_update_timestamp_us` is
/// one global slot in a writable config and the first operation on each print blocks the rest. With
/// no floor a 60 micro-USDC mint captured that slot (the derivation is on the config field), which
/// turned the anti-replay invariant into a permissionless denial primitive.
///
/// Why it is NOT timelocked, and the honest form of that argument. The timelock announces actions that
/// put VALUE at risk; this field puts none at risk in either direction. Raising it prices small
/// operations out; lowering it re-cheapens print capture. Both cost availability, neither costs
/// principal.
///
/// A REVIEW PASS CORRECTED THE FIRST VERSION OF THIS NOTE, which claimed the setter "grants strictly
/// less power than `set_public_mint_enabled(false)`, which the same admin can already call instantly".
/// That is true of the TIGHTENING direction only. Every other instant path in this file is
/// one-directional by construction: the supply cap tightens only, both switches close only, the redeem
/// throttles accept safe-direction values only. This is the one instant LOOSENING of a protection in
/// the file, and a compromised admin can set it to zero, run the dust capture it exists to price out,
/// and restore it, all inside one slot with no window for a guardian to cancel.
///
/// It is still not timelocked, deliberately, and the reason is proportion rather than symmetry: the
/// worst case is a denial of the priced path, which that key can already achieve instantly and more
/// completely with `set_public_mint_enabled(false)` plus `pause()`. A twelfth `TimelockAction` would
/// put more new surface in the mainnet binary than that buys. What the asymmetry does buy is
/// OBSERVABILITY, which is why `MinOperationChanged` carries the old value, the new value and the
/// signer: an admin that zeroes the floor is visible in one event.
///
/// `MIN_OPERATION_CEILING_USDC` is the rail on the lockout direction, and zero is legal: it means
/// no floor, which is what an in-place upgrade of an existing config decodes out of `reserved`.
pub fn set_min_operation_usdc_handler(ctx: Context<SetParam>, new_min_usdc: u64) -> Result<()> {
    let old_min_usdc = ctx.accounts.config.min_operation_usdc;
    validate_min_operation(old_min_usdc, new_min_usdc)?;
    ctx.accounts.config.min_operation_usdc = new_min_usdc;
    emit!(MinOperationChanged {
        old_min_usdc,
        new_min_usdc,
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}

/// Split out of the handler so the unit tests below exercise the real predicate rather than a
/// paraphrase of it. Round 4's lesson: a test that restates the rule passes when the rule is deleted.
pub(crate) fn validate_min_operation(current: u64, requested: u64) -> Result<()> {
    require!(
        requested <= MIN_OPERATION_CEILING_USDC,
        DominionError::MinOperationTooHigh
    );
    require!(current != requested, DominionError::MinOperationUnchanged);
    Ok(())
}

/// FIX A (launch spec 2026-07): the SINGLE instant fast-lane for the four redeem
/// throttles - instant TIGHTENING only. Every provided field must move its
/// throttle in the safe (tighten) direction vs the current config, else
/// `LooseningRequiresTimelock`; loosening any of them goes through the
/// 24h-timelocked `propose_set_redeem_limits` / `execute_set_redeem_limits`.
///
/// Covers: instant_redeem_budget_usdc (D10), instant_redeem_window_seconds (D10),
/// large_redeem_threshold_usdc (D10), redeem_queue_delay_seconds (D8). It does
/// NOT touch max_silv_supply (raise-blocked via set_max_silv_supply) or
/// redemptions_enabled (enable-blocked via set_redemptions_enabled) - those keep
/// their stricter dedicated setters.
///
/// Direction semantics (see `redeem_limits_all_tighten`): budget down, window UP
/// (longer = lower drain rate), threshold down (more forced to the queue), queue
/// delay UP. Fat-finger ceilings still apply. No pause interaction (only tightens
/// safety limits, so safe regardless of pause state). Note (accepted): lengthening
/// the window toward the 7d max is a denial-of-instant-redemption grief, not a
/// drain. ROUND 8 T8-08: it is no longer "doubly moot because public redeem is
/// closed". Redeem is OPEN from `initialize`, so this grief is reachable on a live
/// protocol and the only thing standing against it is that the same guardian who
/// can cancel a loosening can also pause.
pub fn emergency_tighten_redeem_limits_handler(
    ctx: Context<SetParam>,
    args: RedeemLimitsArgs,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        redeem_limits_any_set(&args),
        DominionError::RedeemLimitsAllNone
    );
    validate_redeem_limits_ceilings(&args)?;
    require!(
        redeem_limits_all_tighten(
            &args,
            config.instant_redeem_budget_usdc,
            config.instant_redeem_window_seconds,
            config.large_redeem_threshold_usdc,
            config.redeem_queue_delay_seconds,
        ),
        DominionError::LooseningRequiresTimelock
    );
    // RE-AUDIT P2. This is the THIRD entry point to the redeem limits, and it was the one left behind: the
    // timelocked path gained `redeem_limits_effective_change` and this one still only checked `any_set`
    // plus direction. `redeem_limits_all_tighten` accepts EQUALITY on purpose (tightening to the current
    // value is not a loosening), so `{ instant_redeem_budget_usdc: Some(B) }` with B already the budget
    // succeeded and emitted `RedeemLimitsTightened` while nothing moved.
    //
    // That matters more here than on the timelocked path, not less: this is the EMERGENCY action. Its
    // event is what an incident timeline is reconstructed from afterwards, and a successful no-op in that
    // log reads as "the throttle was tightened at 03:12" when it was not.
    require!(
        redeem_limits_effective_change(
            &args,
            config.instant_redeem_budget_usdc,
            config.instant_redeem_window_seconds,
            config.large_redeem_threshold_usdc,
            config.redeem_queue_delay_seconds,
            config.redemptions_enabled,
        ),
        DominionError::ProposalNoOp
    );

    if let Some(v) = args.instant_redeem_budget_usdc {
        config.instant_redeem_budget_usdc = v;
    }
    if let Some(v) = args.instant_redeem_window_seconds {
        config.instant_redeem_window_seconds = v;
    }
    if let Some(v) = args.large_redeem_threshold_usdc {
        config.large_redeem_threshold_usdc = v;
    }
    if let Some(v) = args.redeem_queue_delay_seconds {
        config.redeem_queue_delay_seconds = v;
    }
    // THE REDEEM SWITCH. This arm was MISSING when the field shipped, and its absence was the
    // worst failure mode in the batch: `redeem_limits_all_tighten` accepts `Some(false)`, so an
    // emergency close SUCCEEDED, emitted an event, and left `redemptions_enabled` untouched.
    // An operator responding to a bad oracle print would see a confirmed emergency action while
    // redemptions kept paying out. A silent no-op on an emergency lever is worse than a revert.
    //
    // Same root cause as the propose.rs P0 fixed in the same pass: a new field added to the
    // VALIDATORS and not to the APPLY block. Adding a field to `RedeemLimitsArgs` means touching
    // FOUR places, and they are deliberately cross-referenced in each other's comments:
    //   1. `redeem_limits_any_set`            (execute.rs) - is anything provided
    //   2. `redeem_limits_effective_change`   (execute.rs) - does anything differ from current
    //   3. `redeem_limits_all_tighten`        (execute.rs) - is the direction safe
    //   4. BOTH apply blocks: here, and `execute_set_redeem_limits_handler`
    if let Some(v) = args.redemptions_enabled {
        let old_enabled = config.redemptions_enabled;
        config.redemptions_enabled = v;
        // Same disarm as the dedicated setter. `redeem_limits_all_tighten` only admits
        // `Some(false)` here, so this branch is always a CLOSE and disarming is unconditionally
        // correct: an operator closing redemptions in an emergency must not leave a pending open
        // armed behind them.
        config.pending_redeem_limits_nonce = None;
        // Same event the dedicated setter and the timelocked path emit, so a monitor watching the
        // redeem switch sees every path that can move it without knowing which one ran.
        emit!(crate::events::RedemptionsEnabledChanged {
            old_enabled,
            new_enabled: v,
            by: ctx.accounts.admin.key(),
        });
    }
    // SolidProof LOW #3: the instant fast lane was silent. Reports the RESULTING
    // values, not the supplied Options, so a monitor sees the live throttle state.
    emit!(RedeemLimitsTightened {
        instant_redeem_budget_usdc: config.instant_redeem_budget_usdc,
        instant_redeem_window_seconds: config.instant_redeem_window_seconds,
        large_redeem_threshold_usdc: config.large_redeem_threshold_usdc,
        redeem_queue_delay_seconds: config.redeem_queue_delay_seconds,
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors DEFAULT_MAX_SILV_SUPPLY. Kept as a local so the boundary cases below read
    // clearly, and pinned to the real constant by the_shipped_launch_cap_is_the_one_being_tested
    // so it can never silently drift again (it caught the 100k -> 150k change).
    const CAP: u64 = 150_000_000_000; // 150k oz at 6dp, the launch cap (Thomas 2026-07-29)
    const SUPPLY: u64 = 3_000_000_000; // 3000 oz minted

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            _ => panic!("expected an AnchorError"),
        }
    }

    #[test]
    fn tighten_above_the_live_supply_is_accepted() {
        assert!(validate_new_max_supply(CAP - 1, CAP, SUPPLY).is_ok());
        assert!(validate_new_max_supply(SUPPLY + 1, CAP, SUPPLY).is_ok());
    }

    #[test]
    fn tighten_to_exactly_the_live_supply_is_accepted() {
        // The documented behaviour: headroom may be shrunk to zero, which stops
        // further issuance without bricking the instruction. This is the case that
        // `>` instead of `>=` would silently break.
        assert!(validate_new_max_supply(SUPPLY, CAP, SUPPLY).is_ok());
    }

    #[test]
    fn tighten_one_below_the_live_supply_is_rejected() {
        let e = validate_new_max_supply(SUPPLY - 1, CAP, SUPPLY).unwrap_err();
        assert_eq!(code(e), DominionError::SupplyCapBelowSupply as u32 + 6000);
    }

    #[test]
    fn zero_is_rejected_while_any_supply_exists() {
        let e = validate_new_max_supply(0, CAP, SUPPLY).unwrap_err();
        assert_eq!(code(e), DominionError::SupplyCapBelowSupply as u32 + 6000);
    }

    #[test]
    fn zero_is_accepted_when_nothing_is_minted_yet() {
        // Not a brick: with no supply there is nothing to protect, and the cap can
        // still never be raised, so this is a deliberate one-way halt available only
        // before the first premint.
        assert!(validate_new_max_supply(0, CAP, 0).is_ok());
    }

    #[test]
    fn a_raise_is_rejected_even_when_it_would_be_safe() {
        let e = validate_new_max_supply(CAP + 1, CAP, SUPPLY).unwrap_err();
        assert_eq!(code(e), DominionError::SupplyCapRaiseBlocked as u32 + 6000);
    }

    #[test]
    fn no_change_is_accepted() {
        assert!(validate_new_max_supply(CAP, CAP, SUPPLY).is_ok());
    }

    #[test]
    fn the_ceiling_is_checked_before_the_raise_block() {
        // Ordering matters for the error the operator sees: an absurd value reports
        // AboveMaximum rather than the less informative SupplyCapRaiseBlocked.
        let e = validate_new_max_supply(MAX_SILV_SUPPLY_CEILING + 1, u64::MAX, 0).unwrap_err();
        assert_eq!(code(e), DominionError::AboveMaximum as u32 + 6000);
    }

    #[test]
    fn the_shipped_launch_cap_is_the_one_being_tested() {
        // Review-of-fixes: this test used the test-local CAP constant, so it could not
        // detect the SHIPPED launch cap drifting away from what these cases assume,
        // and its second assertion duplicated tighten_to_exactly_the_live_supply.
        // Now pinned to the real default.
        assert_eq!(
            CAP, DEFAULT_MAX_SILV_SUPPLY,
            "the launch cap moved: revisit these cases"
        );
        assert!(DEFAULT_MAX_SILV_SUPPLY <= MAX_SILV_SUPPLY_CEILING);
        // A raise from the shipped cap is refused even by one atomic unit.
        assert!(
            validate_new_max_supply(DEFAULT_MAX_SILV_SUPPLY + 1, DEFAULT_MAX_SILV_SUPPLY, 0)
                .is_err()
        );
    }
}

#[cfg(test)]
mod public_mint_tests {
    use super::*;

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            _ => panic!("expected an AnchorError"),
        }
    }

    /// The decision the instant setter makes, extracted so the asymmetry is testable
    /// without a Context. Mirrors set_public_mint_enabled_handler exactly.
    fn validate_instant_public_mint(current: bool, requested: bool) -> Result<()> {
        require!(!requested, DominionError::PublicMintOpenRequiresTimelock);
        require!(current != requested, DominionError::PublicMintUnchanged);
        Ok(())
    }

    #[test]
    fn closing_an_open_mint_is_allowed_instantly() {
        // The emergency direction: a misbehaving feed must be answerable in one tx.
        assert!(validate_instant_public_mint(true, false).is_ok());
    }

    #[test]
    fn opening_instantly_is_refused() {
        // The whole point of the asymmetry. Opening wakes the oracle path and lets the
        // public consume the cap headroom, so it must be announced and vetoable.
        let e = validate_instant_public_mint(false, true).unwrap_err();
        assert_eq!(
            code(e),
            DominionError::PublicMintOpenRequiresTimelock as u32 + 6000
        );
    }

    #[test]
    fn opening_instantly_is_refused_even_when_already_open() {
        // Ordering matters: the direction check runs BEFORE the no-op check, so an
        // operator who fat-fingers `true` always sees why it is refused rather than
        // the less informative "unchanged".
        let e = validate_instant_public_mint(true, true).unwrap_err();
        assert_eq!(
            code(e),
            DominionError::PublicMintOpenRequiresTimelock as u32 + 6000
        );
    }

    #[test]
    fn closing_an_already_closed_mint_is_a_no_op_error() {
        let e = validate_instant_public_mint(false, false).unwrap_err();
        assert_eq!(code(e), DominionError::PublicMintUnchanged as u32 + 6000);
    }

    #[test]
    fn the_launch_default_is_closed() {
        // Pinned so a future change to initialize cannot silently ship an open mint.
        // The launch posture is public mint CLOSED; opening is a deliberate,
        // timelocked, announced act.
        assert!(!DEFAULT_PUBLIC_MINT_ENABLED);
    }
}

/// ROUND 5 P1-04. These exercise `validate_min_operation`, the function the handler actually
/// calls, not a restatement of it.
#[cfg(test)]
mod min_operation_tests {
    use super::*;
    use crate::math::{fee_from_amount, mint_silv_out};

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            _ => panic!("expected an AnchorError"),
        }
    }

    #[test]
    fn raising_and_lowering_are_both_allowed() {
        // No direction asymmetry, deliberately: neither direction puts value at risk. See the
        // handler doc for why this differs from every other setter in this file.
        assert!(validate_min_operation(10_000_000, 50_000_000).is_ok());
        assert!(validate_min_operation(50_000_000, 10_000_000).is_ok());
    }

    #[test]
    fn zero_is_legal_and_means_no_floor() {
        // An in-place upgrade of an already-initialised config decodes zero out of `reserved`, so
        // zero must be a state the setter can also reach and leave.
        assert!(validate_min_operation(10_000_000, 0).is_ok());
        assert!(validate_min_operation(0, 10_000_000).is_ok());
    }

    #[test]
    fn above_the_ceiling_is_refused() {
        let e = validate_min_operation(0, MIN_OPERATION_CEILING_USDC + 1).unwrap_err();
        assert_eq!(code(e), DominionError::MinOperationTooHigh as u32 + 6000);
    }

    #[test]
    fn exactly_the_ceiling_is_allowed() {
        // An off-by-one here would make the documented rail unreachable.
        assert!(validate_min_operation(0, MIN_OPERATION_CEILING_USDC).is_ok());
    }

    #[test]
    fn writing_the_current_value_is_refused() {
        let e = validate_min_operation(10_000_000, 10_000_000).unwrap_err();
        assert_eq!(code(e), DominionError::MinOperationUnchanged as u32 + 6000);
    }

    #[test]
    fn the_ceiling_check_runs_before_the_no_op_check() {
        // Same ordering rule as the public-mint setter: an operator who pastes an absurd number
        // must be told it is out of range, not that it is unchanged.
        let e = validate_min_operation(
            MIN_OPERATION_CEILING_USDC + 1,
            MIN_OPERATION_CEILING_USDC + 1,
        )
        .unwrap_err();
        assert_eq!(code(e), DominionError::MinOperationTooHigh as u32 + 6000);
    }

    #[test]
    fn the_default_floor_prices_out_the_measured_capture_amount() {
        // THE FINDING, as an executable assertion rather than a comment. At $58.34/oz and 100 bps,
        // 60 micro-USDC is the smallest amount that mints a non-zero SILV: `fee_from_amount` ceils
        // 60*100/10000 to 1, leaving 59 net, and `mint_silv_out` floors 59/58.34 to exactly 1.
        // That is the whole cost of capturing a Lazer print, so the derivation is pinned here: if
        // the rounding ever changes, this fails rather than leaving a stale number in a doc.
        const PRICE_SCALED: u128 = 58_340_000_000; // $58.34 * 1e9
        let fee = fee_from_amount(60, 100).unwrap();
        assert_eq!(fee, 1, "the ceiling fee on 60 micro-USDC");
        assert_eq!(
            mint_silv_out(60 - fee, PRICE_SCALED).unwrap(),
            1,
            "60 micro-USDC still buys a non-zero amount of SILV, so it is a valid capture"
        );
        // One micro-USDC less and the mint reverts ZeroAmount on its own, which is why 60 and not 59.
        let fee59 = fee_from_amount(59, 100).unwrap();
        assert_eq!(
            mint_silv_out(59 - fee59, PRICE_SCALED).unwrap(),
            0,
            "59 micro-USDC rounds to zero SILV, so the floor below 60 was already implicit"
        );
        // And the shipped default puts the floor five orders of magnitude above that.
        assert!(
            DEFAULT_MIN_OPERATION_USDC > 60 * 100_000,
            "the default floor must dominate the measured capture amount, not merely exceed it"
        );
    }

    #[test]
    fn the_default_is_within_its_own_ceiling() {
        // A default above the rail would make initialize write a value the setter can never restore.
        assert!(DEFAULT_MIN_OPERATION_USDC <= MIN_OPERATION_CEILING_USDC);
    }
}
