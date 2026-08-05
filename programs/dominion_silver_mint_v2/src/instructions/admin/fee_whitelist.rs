// Fee-exemption whitelist management + the fee-vault sweep (Thomas, 2026-08-05).
//
// Three instructions, all admin-only and all INSTANT. The instant-ness is a deliberate
// departure from how this program treats other admin powers, and the reasoning differs per
// instruction, so it is stated at each one rather than once here.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};

use crate::cpi::usdc_transfer_fee_vault_to_destination;
use crate::errors::DominionError;
use crate::events::{FeeExemptRemoved, FeeExemptSet, FeesWithdrawn};
use crate::state::*;

// ===========================================================================
// set_fee_exempt: grant or update an exemption
// ===========================================================================

#[derive(Accounts)]
#[instruction(wallet: Pubkey, flags: u8)]
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
/// Why instant, when opening the mint or raising the redeem budget both cost 24 hours: the
/// worst case here is FOREGONE FEE REVENUE, not a loss of principal, backing or user funds.
/// An exempt wallet still pays the full oracle price for its SILV and still receives the
/// full oracle price when redeeming; the protocol simply does not take its cut. Every
/// loosening this program DOES timelock can move value or change what a third party is
/// charged. Making market-maker onboarding a day-long ceremony would buy nothing.
///
/// The residual risk, stated so it is not discovered later: a compromised admin can exempt
/// itself and trade fee-free until someone notices. `FeeExemptSet` is the event to alert on.
pub fn set_fee_exempt_handler(ctx: Context<SetFeeExempt>, wallet: Pubkey, flags: u8) -> Result<()> {
    validate_fee_exempt_flags(flags)?;
    let now = Clock::get()?.unix_timestamp;
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

    emit!(FeeExemptSet {
        wallet,
        flags,
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
    // The guardian pause MUST cover this. It is the only instant money movement in the program,
    // and without this check the guardians' one lever failed to reach it: a compromised admin
    // whose timelocked actions were all frozen and whose mint and redeem were halted could still
    // sweep the entire vault in one transaction, with no delay and no veto.
    //
    // Precedented: `execute_withdraw_usdc` refuses to run while paused (D31). This is the same
    // rule applied to the same class of action.
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    require!(amount > 0, DominionError::ZeroAmount);

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
