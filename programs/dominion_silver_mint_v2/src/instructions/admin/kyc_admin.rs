// KYC gate administration (Thomas, 2026-08-05). DORMANT at launch.
//
// Four instructions. Two are admin-only configuration (`set_kyc_operator`, `set_kyc_scope`)
// and two are exercised by a dedicated attestor key (`attest_kyc`, `revoke_kyc`).
//
// THE SPLIT IS THE POINT. The attestor is a HOT key: Mark's backend signs with it every time
// a user is approved, so it will live on a server. It must therefore be able to do exactly one
// thing and nothing else. It cannot change fees, cannot mint, cannot pause, cannot move funds,
// and cannot even arm or disarm the gate it feeds. Its entire power is to add and remove rows
// in a list that is only consulted when the admin has separately armed the gate.
//
// See state/kyc.rs for the PII rule and for what the off-chain side has to produce, including
// the wallet-ownership signature step that is easy to forget and without which the gate is
// decorative.

use anchor_lang::prelude::*;

use crate::errors::DominionError;
use crate::events::{KycAttested, KycOperatorChanged, KycRevoked, KycScopeChanged};
use crate::state::*;

// ===========================================================================
// set_kyc_operator: rotate the attestor key
// ===========================================================================

#[derive(Accounts)]
pub struct SetKycOperator<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,
    pub admin: Signer<'info>,
}

/// Set or rotate the attestor key. INSTANT.
///
/// Instant is the deliberate choice, and the reason is incident response rather than
/// convenience: this key lives on a server, so the realistic failure is that it leaks. A 24h
/// timelock on rotation would mean 24 hours with a compromised attestor able to approve
/// arbitrary wallets. Fast rotation is the whole mitigation.
///
/// What makes instant safe: the operator cannot move funds, mint, pause, change a fee, or arm
/// the gate. Its only power is to admit wallets through a gate the ADMIN controls separately.
/// A wrong operator is a compliance problem, recoverable by rotating again and revoking what
/// it wrote; it is not a path to anyone's money.
///
/// `config.pending_kyc_operator_nonce` remains reserved and unused. It is the hook if this is
/// ever wanted behind a timelock after all, but see above for why that would trade a real risk
/// for a theoretical one.
///
/// Setting it to `Pubkey::default()` is permitted and is the way to decommission the attestor:
/// the zero pubkey has no private key, so nothing can sign as it, and `set_kyc_scope` refuses
/// to arm the gate while the operator is unset.
pub fn set_kyc_operator_handler(ctx: Context<SetKycOperator>, operator: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
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

// ===========================================================================
// set_kyc_scope: arm or disarm the gate, per side
// ===========================================================================

#[derive(Accounts)]
pub struct SetKycScope<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Box<Account<'info, ConfigAccount>>,
    pub admin: Signer<'info>,
}

/// Arm or disarm the KYC gate. `flags` is a `Side` bitfield: bit 0 mint, bit 1 redeem, 0 off.
/// INSTANT IN BOTH DIRECTIONS, which inverts this program's usual asymmetry, so here is why.
///
/// ARMING restricts users, which normally means "tighten, therefore instant". But note that
/// arming also HARMS holders: with no attestations written, arming the redeem side locks
/// everyone out of redeeming. The reason instant is nevertheless acceptable is that it grants
/// the admin NO NEW GRIEFING POWER. A compromised admin can already halt redemptions instantly
/// via `pause` or `set_redemptions_enabled(false)`. Arming KYC is a slower, noisier way to do
/// something it can already do in one transaction, so timelocking it would protect nothing.
/// Meanwhile a legitimate compliance order can require the gate up today, not tomorrow.
///
/// DISARMING is a compliance loosening, which would normally earn a 24h delay. It is instant
/// because it is the ONLY way to unbrick a wrongly-armed gate, and a wrongly-armed gate is
/// holders being unable to redeem. Making the fix slow would make the mistake expensive for
/// exactly the people the delay is meant to protect. Disarming cannot move value; it restores
/// access.
///
/// THE OPERATIONAL FOOTGUN this cannot prevent: write the attestations BEFORE arming. Arming
/// first locks out every existing holder instantly. The `kyc_operator` check below catches only
/// the most extreme version, where no attestor exists at all and therefore no approval could
/// ever have been written.
pub fn set_kyc_scope_handler(ctx: Context<SetKycScope>, flags: u8) -> Result<()> {
    validate_kyc_scope(flags)?;
    let config = &mut ctx.accounts.config;
    let old_flags = config.kyc_scope_flags;
    require!(flags != old_flags, DominionError::KycScopeInvalid);

    // Refuse to arm a gate that nobody can let anyone through. With no attestor there are no
    // attestations and none can be written, so this would be an unconditional lockout on the
    // armed side. Disarming (flags == 0) is always allowed regardless.
    if flags != 0 {
        require!(
            config.kyc_operator != Pubkey::default(),
            DominionError::KycAttestorNotSet
        );
    }

    config.kyc_scope_flags = flags;
    // Keep the pre-existing Phase 1 hook as a DERIVED master signal, never set independently,
    // so a panel or an external reader can trust either field and they cannot disagree.
    config.kyc_enforced = flags != 0;

    emit!(KycScopeChanged {
        old_flags,
        new_flags: flags,
        by: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ===========================================================================
// attest_kyc: record an approval
// ===========================================================================

#[derive(Accounts)]
#[instruction(wallet: Pubkey, reference: [u8; 32])]
pub struct AttestKyc<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    // The hot attestor key. Pinned to config, and note that when `kyc_operator` is
    // `Pubkey::default()` this constraint is unsatisfiable, because no private key exists for
    // the zero pubkey. Decommissioning the attestor therefore disables this instruction with
    // no extra check.
    #[account(
        mut,
        constraint = attestor.key() == config.kyc_operator @ DominionError::Unauthorized,
    )]
    pub attestor: Signer<'info>,

    // Idempotent: re-attesting an already-approved wallet refreshes it rather than failing,
    // which is what a backend replaying its queue needs. Admin-equivalent hazards do not apply
    // because every field is rewritten unconditionally.
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

/// Record that `wallet` is approved. `reference` is a HASH of the provider's record id.
///
/// NEVER pass PII here, not even hashed: an email hash is reversible by brute force because
/// the input space is small. See the PII rule in state/kyc.rs. All-zero is accepted and means
/// "no reference", which a manual approval process legitimately has.
///
/// The attestor pays the rent, deliberately. The approved user should not have to fund their
/// own approval, and the admin should not have to co-sign every one.
pub fn attest_kyc_handler(
    ctx: Context<AttestKyc>,
    wallet: Pubkey,
    reference: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let attestor_key = ctx.accounts.attestor.key();
    let acc = &mut ctx.accounts.kyc;

    acc.wallet = wallet;
    acc.approved_at = now;
    // Stored PER RECORD rather than read from config at gate time, so rotating the operator
    // does not retroactively reassign responsibility for past approvals, and a key-compromise
    // incident can be scoped to the records that key actually wrote.
    acc.attestor = attestor_key;
    acc.reference = reference;
    acc.version = KYC_ACCOUNT_VERSION;

    emit!(KycAttested {
        wallet,
        attestor: attestor_key,
        reference,
        timestamp: now,
    });
    Ok(())
}

// ===========================================================================
// revoke_kyc: withdraw an approval
// ===========================================================================

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RevokeKyc<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ConfigAccount>>,

    // EITHER the attestor OR the admin. Both, on purpose: the attestor is the normal path
    // (offboarding, failed re-screening), and the admin is the incident path, because if the
    // attestor key is compromised the admin must be able to undo what it wrote WITHOUT first
    // waiting to rotate it.
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

/// Withdraw an approval and reclaim its rent.
///
/// Closing the account rather than flagging it revoked is deliberate, for the same reason as
/// the fee exemption: approval is expressed by the account EXISTING, so there is no state in
/// which a revoked wallet still reads as approved. It also means revocation takes effect in
/// the same slot, with no flag for a stale cache to misread.
///
/// The rent goes to whoever signed, which may not be whoever paid. That asymmetry is accepted:
/// it is dust, and the alternative (tracking the payer) would add a field to serve no one.
pub fn revoke_kyc_handler(ctx: Context<RevokeKyc>, wallet: Pubkey) -> Result<()> {
    emit!(KycRevoked {
        wallet,
        by: ctx.accounts.signer.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
