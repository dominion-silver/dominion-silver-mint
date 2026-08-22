// Fee-exemption whitelist plus the fee-vault sweep. Four admin-only instructions, all INSTANT, which
// departs from the rule that loosenings are 24h-timelocked. Each states why instant is acceptable.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint as ClassicMint, Token, TokenAccount};

use crate::cpi::usdc_transfer_fee_vault_to_destination;
use crate::errors::DominionError;
use crate::events::{FeeExemptRemoved, FeeExemptSet, FeeRoutingChanged, FeesWithdrawn};
use crate::state::*;

#[derive(Accounts)]
#[instruction(wallet: Pubkey, flags: u8, expires_at: i64)]
pub struct SetFeeExempt<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    #[account(mut)]
    pub admin: Signer<'info>,

    // `init_if_needed` so grant and update are one instruction. The re-initialization hazard does not
    // apply: admin-gated, seeds fixed by `wallet`, and the handler rewrites every field.
    // See the note on `FeeExemptAccount` in state/fee_exempt.rs for what an exemption actually costs.
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

/// Grant or update a per-wallet fee exemption. INSTANT, no timelock: onboarding a market maker should
/// not take a day. Prefer a MINT-only exemption, which leaves the redeem premium as the cost of
/// closing a loop; the exposure of a both-sides grant is not nil.
pub fn set_fee_exempt_handler(
    ctx: Context<SetFeeExempt>,
    wallet: Pubkey,
    flags: u8,
    expires_at: i64,
) -> Result<()> {
    validate_fee_exempt_flags(flags)?;
    let now = Clock::get()?.unix_timestamp;
    // MANDATORY, strictly future, capped. The upper rail catches the fat finger that matters: a
    // 13-digit millisecond timestamp pasted where seconds go, which LOOKS like a term and behaves like
    // "never". A pure function so it stays unit-tested, with a DEDICATED error for a bad DATE.
    validate_fee_exempt_expiry(expires_at, now)?;
    let admin_key = ctx.accounts.admin.key();
    let acc = &mut ctx.accounts.fee_exempt;

    // The FIRST grant, never overwritten on update. init_if_needed zeroes a fresh account.
    if acc.added_at == 0 {
        acc.added_at = now;
    }
    acc.wallet = wallet;
    acc.flags = flags;
    acc.added_by = admin_key;
    acc.version = FEE_EXEMPT_ACCOUNT_VERSION;
    acc.expires_at = expires_at;

    // Alert on this event: both side bits set, a term near the cap, or a self-grant by the admin. A
    // compromised admin can exempt itself and the term does not bound that, since the admin picks it.
    emit!(FeeExemptSet {
        wallet,
        flags,
        expires_at,
        by: admin_key,
        timestamp: now,
    });
    Ok(())
}

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

/// Revoke an exemption entirely. INSTANT, like every tightening here. Closing the account rather than
/// zeroing its flags reclaims the rent and makes "exempt" mean the account EXISTS, so a roster cannot
/// show a revoked wallet as whitelisted. Same reason `validate_fee_exempt_flags` rejects zero.
pub fn remove_fee_exempt_handler(ctx: Context<RemoveFeeExempt>, wallet: Pubkey) -> Result<()> {
    emit!(FeeExemptRemoved {
        wallet,
        previous_flags: ctx.accounts.fee_exempt.flags,
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct WithdrawFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,

    pub admin: Signer<'info>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, ClassicMint>>,

    /// CHECK: PDA authority of the fee vault. Signs the sweep via seeds; the ONLY place it signs.
    #[account(seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault_pda: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = fee_vault_pda,
        associated_token::token_program = classic_token_program,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    // Any USDC token account, deliberately NOT an ATA nor a stored config value, so a wrong address
    // costs one misdirected transfer. A stored destination whose ATA vanished would revert every mint
    // and every redeem, because the premium transfer lives inside those instructions.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::token_program = classic_token_program,
    )]
    pub destination: Box<Account<'info, TokenAccount>>,

    // A4: read-only, purely so the sweep can be gated on the treasury float. Without it the redeem
    // premium leg routes 1.5% of every redemption around that floor into an instantly sweepable vault.
    #[account(address = config.usdc_treasury)]
    pub usdc_treasury: Box<Account<'info, TokenAccount>>,

    #[account(address = config.classic_token_program)]
    pub classic_token_program: Program<'info, Token>,
}

/// Sweep accrued premium out of the fee vault. INSTANT, and the only instant money movement here:
/// unlike the timelocked treasury this vault backs no outstanding SILV. `amount` is explicit, because
/// "0 means everything" on an irreversible transfer is how a fat finger sweeps the lot.
pub fn withdraw_fees_handler(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
    // Refuses while paused, matching `execute_withdraw_usdc` (). NOT a guardian veto: `unpause` is
    // admin-only and instant, so `[unpause, withdraw_fees]` in one transaction clears it. It only stops
    // an ordinary sweep landing mid-incident. Accepted: a compromised admin drains the standing
    // balance at once, so sweep on a cadence rather than letting months accrue.
    require!(!ctx.accounts.config.paused, DominionError::Paused);
    require!(amount > 0, DominionError::ZeroAmount);

    // A4. Premium revenue is only Dominion's once the redemption buffer is healthy. Gating the SWEEP
    // and not the redeem leg is deliberate: a user's redemption must not fail on an ADMIN-facing
    // threshold. RAW balance, not balance-minus-amount, and `>=` so a treasury exactly at its floor is
    // still sweepable. Never strands revenue: deposit_usdc and propose_set_treasury_min_float exit it.
    require!(
        ctx.accounts.usdc_treasury.amount >= ctx.accounts.config.treasury_min_float_usdc,
        DominionError::FloorBreached
    );

    // A self-sweep is a token-program no-op, so the event would report a `remaining` that never was.
    require!(
        ctx.accounts.destination.key() != ctx.accounts.fee_vault.key(),
        DominionError::WithdrawRecipientMismatch
    );

    // Nor a non-ATA owned by the same PDA: the source is the PDA's ATA, so those funds would strand.
    require!(
        ctx.accounts.destination.owner != ctx.accounts.fee_vault_pda.key(),
        DominionError::FeeWithdrawDestinationStranded
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
        // The OWNER, not the token account: that is the wallet an operator recognises.
        destination: ctx.accounts.destination.owner,
        amount,
        // Computed, not re-read: `fee_vault.amount` is the pre-CPI snapshot Anchor deserialized.
        remaining: available.saturating_sub(amount),
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetFeeRouting<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,
    pub admin: Signer<'info>,
}

/// Turn premium routing on or off. INSTANT both ways. The remedy for an unusable fee vault: USDC has a
/// Circle freeze authority and the premium transfer inside mint and redeem is unconditional, so a
/// frozen vault ATA would brick both for every non-exempt wallet with no fix short of an upgrade.
pub fn set_fee_routing_enabled_handler(ctx: Context<SetFeeRouting>, enabled: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    // Routing OFF leaves the premium in the treasury, which is the pre-2026-08-05 behaviour; ON cannot
    // lose funds, it only picks which program-controlled account accrues. The INSTRUCTION takes
    // `enabled` but the FIELD is negated, so its zero value is the right default on an in-place
    // upgrade. The inversion lives only here.
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
