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
use crate::instructions::admin::execute::{
    redeem_limits_all_tighten, redeem_limits_any_set, validate_redeem_limits_ceilings,
    RedeemLimitsArgs,
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
    validate_new_max_supply(
        new_max,
        ctx.accounts.config.max_silv_supply,
        ctx.accounts.silv_mint.supply,
    )?;
    ctx.accounts.config.max_silv_supply = new_max;
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

/// D11 (launch spec 2026-07, Codex audit P0-01): the manual redemptions switch is
/// now FALSE-ONLY at launch. DISABLING is instant (an emergency tighten). ENABLING
/// is BLOCKED on-chain until the Phase 1 upgrade, which re-adds the enable path
/// behind the KYC registry + the loosen-slow redeem-limit model. Rationale: public
/// redeem is closed at launch; if a compromised admin could re-enable redemptions
/// instantly (and instantly loosen the instant-redeem throttles), it could redeem
/// pre-minted SILV for treasury USDC, bypassing the 24h-timelocked withdraw path.
/// With enabling blocked, redemptions are cryptographically off at launch, so the
/// throttle setters are genuinely inert and the treasury can only be drawn down via
/// the timelocked, guardian-cancellable withdraw_usdc.
pub fn set_redemptions_enabled_handler(ctx: Context<SetParam>, enabled: bool) -> Result<()> {
    require!(!enabled, DominionError::RedemptionsEnableBlocked);
    ctx.accounts.config.redemptions_enabled = enabled;
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
/// drain; doubly moot at launch since public redeem is closed.
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: u64 = 100_000_000_000; // 100k oz at 6dp, the launch cap
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
    fn the_shipped_launch_values_are_consistent() {
        // Sanity-pin the launch posture: the default cap is under the hard ceiling,
        // and a tighten from it down to the live devnet supply is legal.
        assert!(CAP <= MAX_SILV_SUPPLY_CEILING);
        assert!(validate_new_max_supply(SUPPLY, CAP, SUPPLY).is_ok());
    }
}
