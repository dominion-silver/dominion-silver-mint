// KYC gate administration, DORMANT at launch. Two admin-only configuration instructions (`set_kyc_operator`,
// `set_kyc_scope`) and two driven by a dedicated attestor key (`attest_kyc`, `revoke_kyc`). THE SPLIT IS THE
// POINT: the attestor is a HOT key on a server, so its whole power is adding and removing rows in a list only
// consulted once the admin has armed the gate. It cannot change fees, mint, pause, move funds, or arm and
// disarm the gate it feeds. See state/kyc.rs for the PII rule and the wallet-ownership signature required.

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{KycAttested, KycOperatorChanged, KycRevoked, KycScopeChanged};
use crate::state::*;

// ---- set_kyc_operator: rotate the attestor key ----

#[derive(Accounts)]
pub struct SetKycOperator<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,
    pub admin: Signer<'info>,
}

/// Set or rotate the attestor key. INSTANT, and that is the point: the key lives on a server, so the realistic
/// failure is a leak and fast rotation is the whole mitigation. Safe because the operator cannot move funds,
/// mint, pause, change a fee, or arm the gate. `Pubkey::default()` decommissions it, ONLY while disarmed.
pub fn set_kyc_operator_handler(ctx: Context<SetKycOperator>, operator: Pubkey) -> Result<()> {
    // Both conditions (`operator != admin`, no clearing while armed) live in
    // `state/kyc.rs::validate_kyc_operator_assignment`, so they are unit-tested and the 4c gate can require it.
    validate_kyc_operator_assignment(
        operator,
        ctx.accounts.config.admin,
        ctx.accounts.config.kyc_scope_flags,
    )?;
    let config = &mut ctx.accounts.config;
    // DELIBERATELY NOT CHECKED: rotating to any other unusable key (a PDA, a typo) while armed also stops new
    // holders being attested. Squads compiles one signer, so the co-signature that would prove the incoming key
    // can act cannot be assembled, and demanding it would break rotation, which is the INCIDENT path.
    let old_operator = config.kyc_operator;
    config.kyc_operator = operator;
    emit!(KycOperatorChanged {
        old_operator,
        new_operator: operator,
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ---- set_kyc_scope: arm or disarm the gate, per side ----

#[derive(Accounts)]
pub struct SetKycScope<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,
    pub admin: Signer<'info>,
}

/// Arm or disarm the KYC gate. `flags` is a `Side` bitfield: bit 0 mint, bit 1 redeem, 0 off. INSTANT IN BOTH
/// DIRECTIONS, inverting the usual tighten-fast/loosen-slow asymmetry: arming grants no new griefing power (a
/// compromised admin can already halt redemptions via `pause`), and disarming is the ONLY way to unbrick a
/// wrongly-armed gate. Arming needs `kyc_attestation_count > 0`, so SOMEBODY IS ALREADY THROUGH, but no check
/// can tell an accidentally empty roster from a deliberately small one: write the attestations BEFORE arming.
pub fn set_kyc_scope_handler(ctx: Context<SetKycScope>, flags: u8) -> Result<()> {
    validate_kyc_scope(flags)?;
    let config = &mut ctx.accounts.config;
    let old_flags = config.kyc_scope_flags;
    require!(flags != old_flags, DominionError::KycScopeInvalid);

    // Refuse to arm a gate nobody is through. Disarming is always allowed and is checked first inside the rule.
    validate_kyc_arming(flags, config.kyc_operator, config.kyc_attestation_count)?;

    config.kyc_scope_flags = flags;
    // `kyc_enforced` is DERIVED from the flags and never set independently, so a panel or an external reader
    // can trust either field and the two cannot disagree.
    config.kyc_enforced = flags != 0;

    emit!(KycScopeChanged {
        old_flags,
        new_flags: flags,
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ---- attest_kyc: record an approval ----

#[derive(Accounts)]
#[instruction(wallet: Pubkey, reference: [u8; 32])]
pub struct AttestKyc<'info> {
    // MUST stay `mut`: Anchor only serialises accounts marked `mut`, so without it the `kyc_attestation_count`
    // increment below is computed and silently discarded, the counter stays at 0, and the gate never arms.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    // The hot attestor key, pinned to config. `Pubkey::default()` makes this constraint unsatisfiable (no
    // private key exists for the zero pubkey), so decommissioning the attestor disables this instruction.
    #[account(
        mut,
        constraint = attestor.key() == config.kyc_operator @ DominionError::Unauthorized,
    )]
    pub attestor: Signer<'info>,

    // Idempotent: re-attesting refreshes rather than fails, which a backend replaying its queue needs. Every
    // field is rewritten unconditionally, so `init_if_needed` carries no partial-state hazard.
    #[account(
        init_if_needed,
        payer = attestor,
        space = KycAccount::SIZE,
        seeds = [KYC_SEED, wallet.as_ref()],
        bump,
    )]
    pub kyc: Account<'info, KycAccount>,

    pub system_program: Program<'info, System>,
}

/// Record that `wallet` is approved. `reference` is a HASH of the provider's record id: NEVER PII, not even
/// hashed, since an email hash is reversible by brute force. All-zero means "no reference". The attestor pays
/// the rent, so the approved user does not fund their own approval and the admin does not co-sign each one.
pub fn attest_kyc_handler(
    ctx: Context<AttestKyc>,
    wallet: Pubkey,
    reference: [u8; 32],
) -> Result<()> {
    // A subject that can never sign as a holder would fill the roster and admit nobody, yet satisfy arming.
    validate_kyc_subject(wallet)?;
    let now = Clock::get()?.unix_timestamp;
    let attestor_key = ctx.accounts.attestor.key();
    // Count CREATIONS, not writes: this handler is idempotent, so incrementing unconditionally would inflate the
    // roster on every replay. `version` is non-zero on every account written here, so zero means fresh.
    let is_new = ctx.accounts.kyc.version == 0;
    let acc = &mut ctx.accounts.kyc;

    acc.wallet = wallet;
    acc.approved_at = now;
    // Per record, not read from config at gate time, so rotating the operator does not reassign past approvals.
    acc.attestor = attestor_key;
    acc.reference = reference;
    acc.version = KYC_ACCOUNT_VERSION;

    let config = &mut ctx.accounts.config;
    config.kyc_attestation_count = next_attestation_count(config.kyc_attestation_count, is_new)?;

    emit!(KycAttested {
        wallet,
        attestor: attestor_key,
        reference,
        timestamp: now,
    });
    Ok(())
}

// ---- revoke_kyc: withdraw an approval ----

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RevokeKyc<'info> {
    // `mut`: revoking closes a `KycAccount`, so the roster counter and possibly the scope are written.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    // EITHER the attestor OR the admin, on purpose: the attestor is the normal path (offboarding, failed
    // re-screen), the admin is the incident path, so a compromised attestor's writes can be undone at once.
    #[account(
        mut,
        constraint = signer.key() == config.kyc_operator || signer.key() == config.admin
            @ DominionError::Unauthorized,
    )]
    pub signer: Signer<'info>,

    #[account(
        mut,
        close = signer,
        seeds = [KYC_SEED, wallet.as_ref()],
        bump,
        constraint = kyc.wallet == wallet @ DominionError::AttestationWalletMismatch,
    )]
    pub kyc: Account<'info, KycAccount>,
}

/// Withdraw an approval and reclaim its rent. Closing the account rather than flagging it revoked is
/// deliberate: approval is expressed by the account EXISTING, so nothing reads a revoked wallet as approved and
/// it takes effect in the same slot. The rent goes to whoever signed, which may not be whoever paid: dust.
pub fn revoke_kyc_handler(
    ctx: Context<RevokeKyc>,
    wallet: Pubkey,
    // Consent to the gate being DROPPED, carried in the signed message. An argument, not an authority check,
    // because the disarm is reachable by ORDERING: see `state/kyc.rs::resolve_revocation`.
    allow_disarm: bool,
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    // Read before the mutable borrow. `set_kyc_operator` refuses to make the two keys equal, so this is real.
    let signer_is_admin = signer == ctx.accounts.config.admin;
    let config = &mut ctx.accounts.config;

    // The account is being CLOSED (`close = signer` above), so the roster shrinks. Everything resolves BEFORE
    // any write, so a refusal leaves the counter, the scope and the account untouched.
    let outcome = resolve_revocation(
        config.kyc_scope_flags,
        config.kyc_attestation_count,
        signer_is_admin,
        allow_disarm,
    )?;

    // UNCONDITIONAL, all three, and it must stay that way: assigning the resolved next state leaves no branch to
    // delete, and `kyc_enforced` is derived from the same value in the same breath so the two cannot drift.
    let old_flags = config.kyc_scope_flags;
    config.kyc_attestation_count = outcome.count_after;
    config.kyc_scope_flags = outcome.scope_after;
    config.kyc_enforced = outcome.scope_after != 0;

    if outcome.disarmed {
        // The only conditional left: losing an event breaks no invariant. Same event `set_kyc_scope(0)` emits.
        emit!(KycScopeChanged {
            old_flags,
            new_flags: outcome.scope_after,
            by: signer,
            timestamp: Clock::get()?.unix_timestamp,
        });
    }

    emit!(KycRevoked {
        wallet,
        by: signer,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
