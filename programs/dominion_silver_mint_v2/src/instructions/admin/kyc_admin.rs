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
/// Setting it to `Pubkey::default()` decommissions the attestor, and is permitted ONLY while the gate is
/// disarmed (`kyc_scope_flags == 0`). This paragraph used to present it as the decommission path with no
/// caveat, which was C-02's unfixed second half: doing it while armed means no new attestation can ever
/// be written, so every not-yet-attested holder is shut out with no path in.
pub fn set_kyc_operator_handler(ctx: Context<SetKycOperator>, operator: Pubkey) -> Result<()> {
    // Rotation stays a single admin signature: it is the INCIDENT RESPONSE path (this key lives on a
    // server, so the realistic failure is a leak), and anything slower would make the one operation that
    // must be fast, slow.
    //
    // BUT it may not DECOMMISSION the attestor while the gate is armed. C-02's second half, which the
    // co-signature did not address at all: `set_kyc_scope(2)` legitimately, then
    // `set_kyc_operator(Pubkey::default())`, and no new attestation can ever be written while the redeem
    // side stays closed. Already-attested holders keep redeeming, so this is not a total lockout, but
    // every holder who is not yet attested is shut out with no path in and nothing in the program saying
    // so. Two transactions, one admin signature each, and the doc comment above used to PRESENT the
    // second one as the way to decommission.
    //
    // Disarm first, then decommission. Both are instant, so this costs the admin one extra transaction
    // and removes a silent trap.
    // BOTH conditions live in `state/kyc.rs::validate_kyc_operator_assignment` so they are unit-tested and so
    // section 4c can require this handler to call them. The `operator != admin` half was a bare
    // `require_keys_neq!` here first, and a handler-only check is invisible to every test and every gate:
    // deleting it left 156/156 green.
    validate_kyc_operator_assignment(
        operator,
        ctx.accounts.config.admin,
        ctx.accounts.config.kyc_scope_flags,
    )?;
    let config = &mut ctx.accounts.config;
    // WHAT IS DELIBERATELY *NOT* CHECKED, and why, because I got this wrong once and reverted it.
    //
    // Round 3 P2 observes that rotating to any OTHER unusable key (a PDA, a typo) while armed has the same
    // effect as clearing: no NEW holder can be attested. True. My first fix required the incoming operator to
    // CO-SIGN whenever the gate was armed, which does prove the key can act.
    //
    // That fix was worse than the finding. The rotation card routes through Squads, `squads.ts` wraps with
    // `ephemeralSigners: 0`, and its execute path compiles one signer, so a two-signature transaction cannot
    // be assembled: exactly the reason the FIRST C-02 attempt (a co-signature on arming) was itself a P0.
    // Rotation-while-armed became impossible from the panel, and that is the INCIDENT path: a leaked attestor
    // key while the gate is live. So the fix traded an admin-MISTAKE scenario for an ATTACKER scenario.
    //
    // Residual, accepted and bounded: an admin that rotates an armed gate to a dead key shuts out holders who
    // are not yet attested. Already-attested holders keep redeeming, `KycOperatorChanged` is emitted, and
    // disarming is instant and needs nothing, so recovery is one transaction. The audit rated it P2, and the
    // cost of closing it is a broken incident path, which is not a trade worth making.
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
/// THE OPERATIONAL FOOTGUN this still cannot prevent: write the attestations BEFORE arming. Arming
/// first locks out every existing holder instantly, and no on-chain check can tell an empty roster
/// from a deliberately empty one.
///
/// What it CAN now prove, since audit C-02, is that SOMEBODY IS ALREADY THROUGH the gate: arming requires
/// `kyc_attestation_count > 0`. Before that, only "an attestor is configured" was checked, which any PDA
/// or mistyped key satisfies while being unable to sign anything.
///
/// The first attempt at C-02 required the attestor to CO-SIGN the arming. Both audits recommended the
/// counter instead: the co-signature proved a key could sign once, not that any holder could pass, it
/// could not be assembled by the Squads panel, and it did not survive a rotation to a dead key.
pub fn set_kyc_scope_handler(ctx: Context<SetKycScope>, flags: u8) -> Result<()> {
    validate_kyc_scope(flags)?;
    let config = &mut ctx.accounts.config;
    let old_flags = config.kyc_scope_flags;
    require!(flags != old_flags, DominionError::KycScopeInvalid);

    // Refuse to arm a gate nobody is through. The rule itself lives in
    // `state/kyc.rs::validate_kyc_arming`, as a pure function, so it is unit-tested and so this handler
    // cannot drift from what the tests assert. Disarming is always allowed and is checked first inside it:
    // it is the unbrick path and must never depend on the roster or the operator.
    validate_kyc_arming(flags, config.kyc_operator, config.kyc_attestation_count)?;

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
    // `mut` since C-02, and its ABSENCE was a P0 that made the whole mechanism inert.
    //
    // ROUND 3 P0. The handler incremented `config.kyc_attestation_count`, but Anchor only serialises
    // accounts marked `mut` back to the chain, so the increment was computed and silently discarded. The
    // counter stayed at 0 forever, `set_kyc_scope` refused to arm forever, and the KYC gate was
    // permanently unusable. Not "weakened": unusable.
    //
    // WHY MY TESTS DID NOT CATCH IT, because that matters more than the missing keyword. I extracted
    // `validate_kyc_arming` as a pure function and wrote six tests for it, then reported the mechanism as
    // verified. Those tests exercise the RULE. Nothing exercised the HANDLER, so nothing observed whether
    // the value the rule reads is ever written. A pure-function test proves an implication, never that its
    // premise is reachable.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
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
    // ROUND 3 P2: refuse a subject that can never sign as a holder. Attesting `Pubkey::default()` filled
    // the roster without admitting anybody, so the counter read 1 and arming succeeded on an unusable roster.
    validate_kyc_subject(wallet)?;
    let now = Clock::get()?.unix_timestamp;
    let attestor_key = ctx.accounts.attestor.key();
    // Count CREATIONS, not writes. `init_if_needed` makes this handler idempotent, which a backend
    // replaying its queue relies on, so incrementing unconditionally would inflate the roster on every
    // replay and eventually let the gate be armed with an empty one. A fresh account is zeroed, and
    // `version` is non-zero on every account this handler has ever written, so it is the reliable
    // "was I just created" signal. `approved_at` would work too; `version` cannot be legitimately zero.
    let is_new = ctx.accounts.kyc.version == 0;
    let acc = &mut ctx.accounts.kyc;

    acc.wallet = wallet;
    acc.approved_at = now;
    // Stored PER RECORD rather than read from config at gate time, so rotating the operator
    // does not retroactively reassign responsibility for past approvals, and a key-compromise
    // incident can be scoped to the records that key actually wrote.
    acc.attestor = attestor_key;
    acc.reference = reference;
    acc.version = KYC_ACCOUNT_VERSION;

    // The transition lives in `state/kyc.rs::next_attestation_count`, so the arithmetic AND the
    // "creations only" rule are exercised by tests that touch the real rule rather than the standard library.
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

// ===========================================================================
// revoke_kyc: withdraw an approval
// ===========================================================================

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RevokeKyc<'info> {
    // `mut` since C-02: revoking closes a `KycAccount`, so it decrements `kyc_attestation_count`.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
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
pub fn revoke_kyc_handler(
    ctx: Context<RevokeKyc>,
    wallet: Pubkey,
    // REVIEW-OF-FIXES: consent to the gate being DROPPED, in the signed message. See
    // `state/kyc.rs::resolve_revocation` and `DominionError::KycRevokeWouldDisarm` for why an argument and
    // not an authority check: the disarm is reachable by ORDERING, so admin-only was not enough.
    // Ignored unless this revocation would empty the roster while a side is armed.
    allow_disarm: bool,
) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    // Read before the mutable borrow. `RevokeKyc` already constrains the signer to be one of the two, and
    // `set_kyc_operator` refuses to make them equal, so this is a real distinction rather than a hopeful one.
    let signer_is_admin = signer == ctx.accounts.config.admin;
    let config = &mut ctx.accounts.config;

    // C-02: the account is being CLOSED (see `close = signer` above), so the roster shrinks. The whole
    // transition resolves in `state/kyc.rs` BEFORE any write, so a refusal leaves the counter, the scope
    // and the account untouched (Anchor rolls the instruction back on `Err`, and `close` runs only on `Ok`).
    let outcome = resolve_revocation(
        config.kyc_scope_flags,
        config.kyc_attestation_count,
        signer_is_admin,
        allow_disarm,
    )?;

    // UNCONDITIONAL, all three, and that is the point. The previous version applied the disarm inside
    // `if must_disarm { ... }`, and a reviewer deleted that block to find 154/154 tests and every gate still
    // green: section 4c proves a rule is CALLED, never that its answer is USED. Assigning the resolved next
    // state leaves no branch to delete, and `kyc_enforced` is derived from the same value in the same
    // breath so the two cannot drift apart.
    let old_flags = config.kyc_scope_flags;
    config.kyc_attestation_count = outcome.count_after;
    config.kyc_scope_flags = outcome.scope_after;
    config.kyc_enforced = outcome.scope_after != 0;

    if outcome.disarmed {
        // Losing this emits nothing and breaks no invariant, which is why it is the only conditional left.
        // It is the same event an explicit `set_kyc_scope(0)` emits, so anything watching the highest-signal
        // admin event sees the loosening without having to correlate the counter.
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
