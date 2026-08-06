// Fee-exemption whitelist management + the fee-vault sweep (Thomas, 2026-08-05).
//
// Three instructions, all admin-only and all INSTANT. The instant-ness is a deliberate
// departure from how this program treats other admin powers, and the reasoning differs per
// instruction, so it is stated at each one rather than once here.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};

use crate::cpi::usdc_transfer_fee_vault_to_destination;
use crate::errors::DominionError;
use crate::events::{FeeExemptRemoved, FeeExemptSet, FeeRoutingChanged, FeesWithdrawn};
use crate::state::*;

// ===========================================================================
// set_fee_exempt: grant or update an exemption
// ===========================================================================

#[derive(Accounts)]
#[instruction(wallet: Pubkey, flags: u8, expires_at: i64)]
pub struct SetFeeExempt<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub admin: Signer<'info>,

    // `init_if_needed` so grant and update are one instruction and the panel needs one
    // button. The usual re-initialization hazard does not apply: the instruction is
    // admin-gated, the seeds are fixed by `wallet`, and the handler rewrites every field
    // unconditionally, so there is no partially-stale state either path can leave behind.
    #[account(
        init_if_needed,
        payer = admin,
        space = FeeExemptAccount::SIZE,
        seeds = [FEE_EXEMPT_SEED, wallet.as_ref()],
        bump,
    )]
    pub fee_exempt: Account<'info, FeeExemptAccount>,

    pub system_program: Program<'info, System>,
}

/// Grant or update a per-wallet fee exemption. INSTANT, no timelock.
///
/// Why instant, when opening the mint or raising the redeem budget both cost 24 hours: onboarding a
/// market maker should not be a day-long ceremony, and a wallet with only the MINT side waived still
/// pays the redeem premium to close any loop.
///
/// Do NOT read this as "the exposure is nil". An earlier version of this note said the worst case was
/// merely FOREGONE REVENUE; state/fee_exempt.rs now corrects that, because a BOTH-SIDES exemption
/// hands its holder a free option on oracle movement paid by the treasury, which is a transfer of
/// value. The instant-ness rests on the per-side flags being used properly, not on there being
/// nothing at stake.
///
/// Residual risk, stated so it is not discovered later: a compromised admin can exempt itself and
/// trade fee-free until someone notices, and the expiry does NOT bound that (the admin picks it).
/// `FeeExemptSet` is the event to alert on, and a grant with `expires_at == 0` is the shape to flag.
pub fn set_fee_exempt_handler(
    ctx: Context<SetFeeExempt>,
    wallet: Pubkey,
    flags: u8,
    expires_at: i64,
) -> Result<()> {
    validate_fee_exempt_flags(flags)?;
    let now = Clock::get()?.unix_timestamp;
    // Reject a term already in the past, and a term absurdly far out. 0 ("never") stays allowed.
    //
    // A PAST term would create an account that grants nothing while appearing in every roster as an
    // active exemption: the same trap zero flags would be, rejected for the same reason.
    //
    // The UPPER rail catches the realistic operator error the review-of-fixes named: pasting a
    // 13-digit JavaScript millisecond timestamp instead of seconds yields a year-57000 expiry that
    // LOOKS like a term while behaving like "never", which is exactly the trap this field exists to
    // avoid. Every other tunable in this program has a fat-finger ceiling; this one did not.
    require!(
        expires_at == 0
            || (expires_at > now
                && expires_at <= now.saturating_add(MAX_FEE_EXEMPT_TERM_SECONDS)),
        DominionError::FeeExemptFlagsInvalid
    );
    let admin_key = ctx.accounts.admin.key();
    let acc = &mut ctx.accounts.fee_exempt;

    // `added_at` records the FIRST grant and is not overwritten on update, because "how long
    // has this wallet been exempt" is the forensically useful question. A fresh account is
    // zeroed by init_if_needed, which is what makes the test reliable.
    if acc.added_at == 0 {
        acc.added_at = now;
    }
    acc.wallet = wallet;
    acc.flags = flags;
    acc.added_by = admin_key;
    acc.version = FEE_EXEMPT_ACCOUNT_VERSION;
    acc.expires_at = expires_at;

    emit!(FeeExemptSet {
        wallet,
        flags,
        expires_at,
        by: admin_key,
        timestamp: now,
    });
    Ok(())
}

// ===========================================================================
// remove_fee_exempt: revoke an exemption and reclaim its rent
// ===========================================================================

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RemoveFeeExempt<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        close = admin,
        seeds = [FEE_EXEMPT_SEED, wallet.as_ref()],
        bump,
        constraint = fee_exempt.wallet == wallet @ DominionError::AttestationWalletMismatch,
    )]
    pub fee_exempt: Account<'info, FeeExemptAccount>,
}

/// Revoke an exemption entirely. INSTANT, and this direction needs no justification at all:
/// it is a tightening, and every tightening in this program is instant.
///
/// Closing the account rather than zeroing its flags is the point. It reclaims the rent, and
/// it means "exempt" is expressed by the account EXISTING, so a roster listing cannot show a
/// revoked wallet as still whitelisted. A zero-flag account would be exactly that trap,
/// which is why `validate_fee_exempt_flags` rejects zero.
pub fn remove_fee_exempt_handler(ctx: Context<RemoveFeeExempt>, wallet: Pubkey) -> Result<()> {
    emit!(FeeExemptRemoved {
        wallet,
        previous_flags: ctx.accounts.fee_exempt.flags,
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ===========================================================================
// withdraw_fees: sweep accrued premium to an admin-chosen destination
// ===========================================================================

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct WithdrawFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    pub admin: Signer<'info>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    /// CHECK: PDA authority of the fee vault. Signs the sweep via seeds. This is the ONLY
    /// instruction in which it signs.
    #[account(seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault_pda: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = fee_vault_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    // Any USDC token account. Deliberately NOT constrained to an ATA or to a stored config
    // value: the destination is chosen per sweep from the admin panel, which is what makes a
    // wrong address cost one misdirected transfer instead of bricking mint and redeem. A
    // stored fee destination whose ATA went missing would make every mint and every redeem
    // revert, since the premium transfer happens inside those instructions.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::token_program = classic_token_program,
    )]
    pub destination: Box<Account<'info, TokenAccount>>,

    // A4: the treasury, read-only, purely so the sweep can be gated on its float.
    //
    // The problem this closes: the redeem premium leg moves USDC OUT of the treasury and into the
    // vault, and `execute_withdraw_usdc` is the only path that enforces
    // `treasury_post >= treasury_min_float_usdc`. So 1.5% of every redemption routed AROUND that
    // floor into an account that is withdrawable instantly, which made the float not the floor the
    // panel and the docs present it as.
    #[account(address = config.usdc_treasury)]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,
}

/// Sweep accrued premium out of the fee vault. INSTANT, admin-only.
///
/// This is the one instant money movement in the program, so the reasoning matters.
/// `withdraw_usdc` (the TREASURY) is 24h-timelocked and guardian-cancellable because that
/// balance BACKS outstanding SILV and is what user redemptions draw on: the delay exists to
/// protect USERS from the admin. The fee vault backs nothing. It holds Dominion's own earned
/// revenue, and `config.admin` is already a Squads multisig, so a timelock here would be
/// protecting Dominion from itself, which the multisig threshold already does.
///
/// Consequence, accepted: a compromised admin drains accrued fees immediately. The exposure
/// is bounded by the standing vault balance, so sweep on a regular cadence rather than
/// letting months accumulate. `FeesWithdrawn` carries the post-sweep balance so a monitor can
/// alert on the vault growing beyond a threshold.
///
/// `amount` is explicit rather than "0 means everything". A magic value on an irreversible
/// transfer is how a fat-finger becomes a full sweep; the panel prefills the balance instead.
pub fn withdraw_fees_handler(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
    // Refuses while paused, matching `execute_withdraw_usdc` (D31).
    //
    // CORRECTED CLAIM. An earlier version of this comment said the check meant "the guardians' one
    // lever" now reached this instruction and that a compromised admin could no longer sweep the
    // vault during a pause. That was wrong, and the review-of-fixes showed why: `unpause` is
    // `has_one = admin`, admin-only, instant, with no timelock and no guardian involvement. A
    // compromised admin submits `[unpause, withdraw_fees]` in ONE transaction and the gate is gone.
    //
    // The cited precedent is not analogous either. `execute_withdraw_usdc` has a PROPOSAL a guardian
    // can cancel, so its pause check is belt-and-braces on top of a real veto. `withdraw_fees` has
    // no proposal, so there is no guardian control over it at all and this check cannot create one.
    //
    // What the check DOES buy, which is worth keeping: it stops an ordinary sweep from landing in the
    // middle of an incident by accident, and it makes the bypass require a deliberate, visible
    // `unpause` in the same transaction. The underlying exposure is the one already accepted above:
    // this vault holds earned revenue, not user backing, and `config.admin` is a multisig. Closing it
    // properly would mean gating or delaying `unpause`, which is a governance change well outside
    // this instruction.
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    require!(amount > 0, DominionError::ZeroAmount);

    // A4. Premium revenue is only Dominion's to take once the REDEMPTION BUFFER is healthy.
    //
    // Without this, `treasury_min_float_usdc` was not the floor it is presented as: the redeem
    // premium leg drains the treasury with no float check, and the vault it lands in is
    // withdrawable instantly, so the premium on every redemption routed around the floor.
    //
    // Gating the SWEEP rather than the redeem leg is deliberate. Blocking the premium transfer
    // inside `redeem_silv` would make a user's redemption fail because of an ADMIN-facing
    // threshold, which inverts the priority this program has held throughout: users come ahead of
    // the admin's ability to move cash out. Here the cost lands on the admin instead, which is
    // where it belongs, and the revenue is not lost, only deferred until the buffer recovers.
    //
    // Note the float is read as a raw balance, NOT balance-minus-amount: the question is whether
    // the buffer is currently healthy, not whether it would survive this sweep. A treasury sitting
    // exactly at its floor should not fund a fee withdrawal at all.
    // CANNOT STRAND REVENUE PERMANENTLY, checked during the review-of-fixes because "gate a
    // withdrawal on a threshold" is a classic way to build an inescapable trap. Two independent
    // exits exist, both admin-reachable: `deposit_usdc` tops the treasury back above the floor, and
    // `propose_set_treasury_min_float` lowers the floor itself (24h, since lowering it is a
    // loosening). So a treasury structurally below its float DEFERS the sweep, it does not destroy
    // the revenue: the vault keeps accruing and can never be closed.
    require!(
        ctx.accounts.usdc_treasury.amount >= ctx.accounts.config.treasury_min_float_usdc,
        DominionError::FloorBreached
    );

    // A sweep to the vault itself succeeds as a token-program no-op, and the event below would
    // then report `remaining = available - amount`, a balance that never existed. Since the
    // design leans on `FeesWithdrawn.remaining` for the "alert if the vault grows" monitor, a
    // self-sweep is a way to feed that monitor a fabricated figure, repeatedly, while the vault
    // actually fills. Cheap to forbid, and there is no legitimate reason to do it.
    require!(
        ctx.accounts.destination.key() != ctx.accounts.fee_vault.key(),
        DominionError::WithdrawRecipientMismatch
    );

    let available = ctx.accounts.fee_vault.amount;
    require!(available >= amount, DominionError::InsufficientFeeVault);

    let bump = ctx.bumps.fee_vault_pda;
    let seeds: &[&[u8]] = &[FEE_VAULT_SEED, &[bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    usdc_transfer_fee_vault_to_destination(
        ctx.accounts.classic_token_program.to_account_info(),
        ctx.accounts.fee_vault.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.usdc_mint.to_account_info(),
        ctx.accounts.fee_vault_pda.to_account_info(),
        signer_seeds,
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(FeesWithdrawn {
        // The OWNER, not the token account: the owner is the wallet an operator recognises,
        // and it is what the panel asked for.
        destination: ctx.accounts.destination.owner,
        amount,
        // Computed rather than re-read: `fee_vault.amount` is the pre-CPI snapshot Anchor
        // deserialized, so re-reading it here would report the stale balance.
        remaining: available.saturating_sub(amount),
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ===========================================================================
// set_fee_routing_enabled: the fee-vault escape hatch
// ===========================================================================

#[derive(Accounts)]
pub struct SetFeeRouting<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,
    pub admin: Signer<'info>,
}

/// Turn premium routing on or off. INSTANT in both directions.
///
/// This is the remedy for a fee vault that has become unusable. USDC carries a Circle freeze
/// authority, and the premium transfer inside mint and redeem is unconditional, so a frozen
/// fee-vault ATA would otherwise brick mint AND redeem for every non-exempt wallet with no
/// on-chain fix short of a program upgrade. Exempt wallets would keep working, which makes the
/// failure asymmetric and hard to diagnose from the outside.
///
/// With routing OFF the premium simply stays in the treasury. That is not an untested degraded
/// mode: it is exactly how this program behaved before 2026-08-05, for its entire prior history.
///
/// Instant in BOTH directions, which is unusual here and deliberate:
///   - OFF is a safety action, and every safety action in this program is instant.
///   - ON is normally the direction that would earn a timelock, but it cannot lose or misdirect
///     funds. It only changes which of two PROGRAM-CONTROLLED accounts the premium accrues in,
///     and both are reachable only by admin instructions that are themselves gated. Making the
///     restoration slow would mean a day of forgone revenue after an incident is resolved, for
///     no protection.
pub fn set_fee_routing_enabled_handler(
    ctx: Context<SetFeeRouting>,
    enabled: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    // The INSTRUCTION takes `enabled` because that is what an operator thinks in; the FIELD is
    // negated so its zero value is the correct default on an in-place upgrade. The inversion lives
    // here, in one place, rather than at every read site.
    require!(
        enabled == config.fee_routing_disabled,
        DominionError::ProposalNoOp
    );
    config.fee_routing_disabled = !enabled;
    emit!(FeeRoutingChanged {
        enabled,
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
