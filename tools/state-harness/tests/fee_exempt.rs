// On-chain tests for the fee-exemption whitelist, the fee-vault sweep and the routing toggle. Every
// assertion reads an account back OUT of the VM after a real transaction: the unit tests all call
// pure functions in src/state/, so none of them can see a deleted `validate_*` call, a deleted
// `has_one`, a field the handler never assigned, or a derived field written with the wrong sign.

mod common;

use borsh::{BorshDeserialize, BorshSerialize};
use common::*;
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- constants

const E_CONSTRAINT_ADDRESS: u32 = 2012;
const E_ZERO_AMOUNT: u32 = 12019;
const E_PROPOSAL_NO_OP: u32 = 12043;
const E_WITHDRAW_RECIPIENT_MISMATCH: u32 = 12048;
const E_FLOOR_BREACHED: u32 = 12062;
const E_FEE_EXEMPT_FLAGS_INVALID: u32 = 12107;
const E_INSUFFICIENT_FEE_VAULT: u32 = 12108;
const E_FEE_EXEMPT_EXPIRY_INVALID: u32 = 12110;
const E_FEE_WITHDRAW_DESTINATION_STRANDED: u32 = 12111;

const MAX_FEE_EXEMPT_TERM_SECONDS: i64 = 2 * 365 * 86_400;
const FEE_EXEMPT_ACCOUNT_SIZE: usize = 114;
const FEE_EXEMPT_ACCOUNT_VERSION: u8 = 1;

/// The treasury floor these tests install. The launch default is 0, so A4 would not bind at all and a
/// deleted float check would be invisible.
const FLOOR: u64 = 5_000_000;
const VAULT_START: u64 = 900_000;

// ---------------------------------------------------------------- account mirror

/// Field-for-field mirror of `state::fee_exempt::FeeExemptAccount`, in declaration order.
/// `read_fee_exempt` re-serializes what it decoded and compares bytes, so a layout drift fails loudly
/// instead of shifting every later field and mis-asserting silently.
#[derive(BorshDeserialize, BorshSerialize, Debug)]
struct FeeExempt {
    wallet: [u8; 32],
    flags: u8,
    added_at: i64,
    added_by: [u8; 32],
    version: u8,
    expires_at: i64,
    reserved: [u8; 24],
}

/// `None` when no exemption exists for that wallet (never granted, or closed by remove_fee_exempt).
fn read_fee_exempt(f: &Fixture, wallet: &Pubkey) -> Option<FeeExempt> {
    let acc = f.svm.get_account(&fee_exempt_pda(wallet))?;
    if acc.lamports == 0 || acc.data.is_empty() {
        return None;
    }
    assert_eq!(
        acc.data.len(),
        FEE_EXEMPT_ACCOUNT_SIZE,
        "FeeExemptAccount::SIZE changed"
    );
    assert_eq!(
        &acc.data[..8],
        &anchor_disc("account:FeeExemptAccount"),
        "wrong account discriminator at the fee_exempt PDA"
    );
    let mut slice: &[u8] = &acc.data[8..];
    let decoded = FeeExempt::deserialize(&mut slice)
        .expect("borsh decode of FeeExemptAccount failed; the on-chain layout drifted");
    let re = borsh::to_vec(&decoded).unwrap();
    assert_eq!(
        re.as_slice(),
        &acc.data[8..8 + re.len()],
        "re-serializing did not reproduce the on-chain bytes, so the mirror struct is out of sync"
    );
    Some(decoded)
}

/// Mirror of the `FeesWithdrawn` event. `remaining` exists ONLY in the event, so it is the one field
/// of this program an operator's revenue ledger depends on that no account read can verify.
#[derive(BorshDeserialize, Debug)]
struct FeesWithdrawnEvent {
    destination: [u8; 32],
    amount: u64,
    remaining: u64,
    by: [u8; 32],
    timestamp: i64,
}

fn b64_decode(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::new();
    for c in s.bytes().filter(|c| *c != b'=') {
        let v = A.iter().position(|a| *a == c).expect("not base64") as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// Pull the single `emit!`ed event out of a transaction's logs, matching on its discriminator.
fn fees_withdrawn(logs: &[String]) -> FeesWithdrawnEvent {
    let disc = anchor_disc("event:FeesWithdrawn");
    for l in logs {
        if let Some(b64) = l.strip_prefix("Program data: ") {
            let bytes = b64_decode(b64.trim());
            if bytes.len() > 8 && bytes[..8] == disc {
                let mut slice = &bytes[8..];
                return FeesWithdrawnEvent::deserialize(&mut slice).expect("FeesWithdrawn decode");
            }
        }
    }
    panic!("no FeesWithdrawn event in the logs:\n{}", logs.join("\n"));
}

fn lamports_of(f: &Fixture, addr: &Pubkey) -> u64 {
    f.svm.get_account(addr).map(|a| a.lamports).unwrap_or(0)
}

fn now(f: &Fixture) -> i64 {
    let clock: Clock = f.svm.get_sysvar();
    clock.unix_timestamp
}

// ---------------------------------------------------------------- instructions

fn grant(
    f: &mut Fixture,
    signer: &Keypair,
    wallet: &Pubkey,
    flags: u8,
    expires_at: i64,
) -> TxOutcome {
    let mut args = wallet.as_ref().to_vec();
    args.push(flags);
    args.extend_from_slice(&expires_at.to_le_bytes());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            // config is deliberately NOT writable on this instruction.
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new(fee_exempt_pda(wallet), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("set_fee_exempt", &args),
    };
    f.send(&[ix], &[signer])
}

fn revoke_exempt(f: &mut Fixture, signer: &Keypair, wallet: &Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new(fee_exempt_pda(wallet), false),
        ],
        data: ix_data("remove_fee_exempt", wallet.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn set_routing(f: &mut Fixture, signer: &Keypair, enabled: bool) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data("set_fee_routing_enabled", &[enabled as u8]),
    };
    f.send(&[ix], &[signer])
}

/// The three token accounts `withdraw_fees` moves money between, so a test can substitute any one of
/// them (a decoy treasury, a self-sweep, a stranding destination).
#[derive(Clone)]
struct Sweep {
    fee_vault: Pubkey,
    destination: Pubkey,
    usdc_treasury: Pubkey,
}

fn withdraw(f: &mut Fixture, signer: &Keypair, amount: u64, s: &Sweep) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(f.usdc_mint, false),
            AccountMeta::new_readonly(fee_vault_pda(), false),
            AccountMeta::new(s.fee_vault, false),
            AccountMeta::new(s.destination, false),
            AccountMeta::new_readonly(s.usdc_treasury, false),
            AccountMeta::new_readonly(pk(CLASSIC_TOKEN_PROGRAM), false),
        ],
        data: ix_data("withdraw_fees", &amount.to_le_bytes()),
    };
    f.send(&[ix], &[signer])
}

/// routed through the common helper, which installs the independent guardian that
/// `unpause` now demands.
fn unpause(f: &mut Fixture) {
    expect_ok(f.unpause(), "unpause");
}

/// `treasury_min_float_usdc` through its only path, the 24h timelock. Warps the clock past the window.
fn set_treasury_floor(f: &mut Fixture, value: u64) {
    let admin = f.admin.insecure_clone();
    let pid = program_id();
    let nonce = f.config().next_timelock_nonce;
    let propose = Instruction {
        program_id: pid,
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("propose_set_treasury_min_float", &value.to_le_bytes()),
    };
    expect_ok(
        f.send(&[propose], &[&admin]),
        "propose_set_treasury_min_float",
    );
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    let execute = Instruction {
        program_id: pid,
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(admin.pubkey(), false),
        ],
        data: ix_data("execute_set_treasury_min_float", &nonce.to_le_bytes()),
    };
    expect_ok(
        f.send(&[execute], &[&admin]),
        "execute_set_treasury_min_float",
    );
    assert_eq!(
        f.config().treasury_min_float_usdc,
        value,
        "the treasury floor did not persist"
    );
}

// ---------------------------------------------------------------- token helpers

fn token_amount(f: &Fixture, addr: &Pubkey) -> u64 {
    let acc = f.svm.get_account(addr).expect("token account does not exist");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/// Patch a live SPL token account's `amount` (offset 64). Funding through a mint CPI would need a
/// mint authority these tests do not hold, and the balance is all the sweep path reads.
fn set_token_amount(f: &mut Fixture, addr: &Pubkey, amount: u64) {
    let mut acc = f.svm.get_account(addr).expect("token account does not exist");
    acc.data[64..72].copy_from_slice(&amount.to_le_bytes());
    f.svm.set_account(*addr, acc).unwrap();
}

/// A raw 165-byte classic token account at a fresh address, so a destination can carry an arbitrary
/// OWNER: the stranding guard tests the owner, not the address, and an ATA cannot express that.
fn make_token_account(f: &mut Fixture, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let addr = Pubkey::new_unique();
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    f.svm
        .set_account(
            addr,
            Account {
                lamports: 10_000_000,
                data,
                owner: pk(CLASSIC_TOKEN_PROGRAM),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    addr
}

/// A program with a NON-ZERO treasury floor, a funded fee vault and a destination the admin owns.
fn sweep_fixture(treasury_amount: u64, unpaused: bool) -> (Fixture, Sweep) {
    let mut f = Fixture::new_bare();
    if unpaused {
        unpause(&mut f);
    }
    set_treasury_floor(&mut f, FLOOR);

    let admin = f.admin.insecure_clone();
    let classic = pk(CLASSIC_TOKEN_PROGRAM);
    let ixs = [
        create_ata_ix(&admin.pubkey(), &fee_vault_pda(), &f.usdc_mint, &classic),
        create_ata_ix(&admin.pubkey(), &admin.pubkey(), &f.usdc_mint, &classic),
    ];
    expect_ok(f.send(&ixs, &[&admin]), "create the fee vault and destination");

    let s = Sweep {
        fee_vault: ata(&f.usdc_mint, &fee_vault_pda(), &classic),
        destination: ata(&f.usdc_mint, &admin.pubkey(), &classic),
        usdc_treasury: ata(&f.usdc_mint, &treasury_pda(), &classic),
    };
    set_token_amount(&mut f, &s.fee_vault, VAULT_START);
    set_token_amount(&mut f, &s.usdc_treasury, treasury_amount);
    (f, s)
}

// ---------------------------------------------------------------- the whitelist

#[test]
fn set_fee_exempt_persists_the_flags_and_the_expiry_on_chain() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();
    let wallet = f.holder.pubkey();
    let expiry = NOW_SECS + 30 * 86_400;
    assert!(
        read_fee_exempt(&f, &wallet).is_none(),
        "no exemption may exist before the grant"
    );

    expect_ok(
        grant(&mut f, &admin, &wallet, SIDE_MINT_BIT, expiry),
        "set_fee_exempt",
    );

    // A handler that skips any of these assignments still returns Ok and still emits FeeExemptSet:
    // a zero `wallet` or a zero `expires_at` makes the grant do nothing while the event says it worked.
    let row = read_fee_exempt(&f, &wallet).expect("the FeeExemptAccount must exist");
    assert_eq!(
        Pubkey::new_from_array(row.wallet),
        wallet,
        "FeeExemptAccount.wallet"
    );
    assert_eq!(row.flags, SIDE_MINT_BIT, "FeeExemptAccount.flags");
    assert_eq!(row.expires_at, expiry, "FeeExemptAccount.expires_at");
    assert_eq!(row.added_at, NOW_SECS, "FeeExemptAccount.added_at");
    assert_eq!(
        Pubkey::new_from_array(row.added_by),
        admin.pubkey(),
        "FeeExemptAccount.added_by"
    );
    assert_eq!(
        row.version, FEE_EXEMPT_ACCOUNT_VERSION,
        "FeeExemptAccount.version"
    );
}

#[test]
fn a_zero_or_out_of_range_expiry_is_refused_at_write_time() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();
    let wallet = f.holder.pubkey();

    // The term is mandatory. Zero is the case that matters: the READER counts it as
    // already expired, so a stored zero is a rent-paying row that exempts nobody. The last case is
    // the realistic fat finger, a 13-digit millisecond timestamp pasted where seconds go.
    let bad = [
        0i64,
        -1,
        NOW_SECS - 1,
        NOW_SECS,
        NOW_SECS + MAX_FEE_EXEMPT_TERM_SECONDS + 1,
        NOW_SECS * 1_000,
    ];
    for expiry in bad {
        expect_error(
            grant(&mut f, &admin, &wallet, SIDE_ALL_BITS, expiry),
            E_FEE_EXEMPT_EXPIRY_INVALID,
            &format!("expires_at = {expiry}"),
        );
        assert!(
            read_fee_exempt(&f, &wallet).is_none(),
            "a refused grant must leave no row behind (expires_at = {expiry})"
        );
    }

    // One second out is legal: the rail bounds the SHAPE of the term, it does not second-guess it.
    expect_ok(
        grant(&mut f, &admin, &wallet, SIDE_ALL_BITS, NOW_SECS + 1),
        "a one-second term",
    );
    assert_eq!(
        read_fee_exempt(&f, &wallet).unwrap().expires_at,
        NOW_SECS + 1
    );
}

#[test]
fn the_per_side_flags_round_trip_and_zero_is_refused() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();
    let expiry = NOW_SECS + 86_400;
    let cases = [
        (f.holder.pubkey(), SIDE_MINT_BIT),
        (f.holder2.pubkey(), SIDE_REDEEM_BIT),
        (f.stranger.pubkey(), SIDE_ALL_BITS),
    ];
    for (wallet, flags) in cases {
        expect_ok(
            grant(&mut f, &admin, &wallet, flags, expiry),
            &format!("grant flags {flags}"),
        );
        assert_eq!(
            read_fee_exempt(&f, &wallet).unwrap().flags,
            flags,
            "flags {flags} did not round-trip through the PDA"
        );
    }

    // Zero is not "revoke": that is remove_fee_exempt. A stored zero (or an undefined bit) would be
    // dead rent that still shows up as whitelisted in every roster.
    let fresh = Pubkey::new_unique();
    for flags in [0u8, 0b100, 0xFF] {
        expect_error(
            grant(&mut f, &admin, &fresh, flags, expiry),
            E_FEE_EXEMPT_FLAGS_INVALID,
            &format!("flags = {flags}"),
        );
    }
    assert!(read_fee_exempt(&f, &fresh).is_none());
}

#[test]
fn an_update_narrows_the_flags_and_keeps_the_original_grant_date() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();
    let wallet = f.holder.pubkey();
    expect_ok(
        grant(&mut f, &admin, &wallet, SIDE_ALL_BITS, NOW_SECS + 10 * 86_400),
        "grant both sides",
    );

    f.warp(4 * 86_400);
    let later = now(&f) + 10 * 86_400;
    expect_ok(
        grant(&mut f, &admin, &wallet, SIDE_MINT_BIT, later),
        "narrow to mint only",
    );

    let row = read_fee_exempt(&f, &wallet).expect("the row must survive the update");
    // A tighten that does not land is the dangerous direction: the redeem waiver would stay in place
    // while FeeExemptSet reports the narrower flags.
    assert_eq!(row.flags, SIDE_MINT_BIT, "the narrowing did not persist");
    assert_eq!(row.expires_at, later, "the renewal did not persist");
    assert_eq!(
        row.added_at, NOW_SECS,
        "added_at must record the FIRST grant, not the renewal"
    );
}

#[test]
fn remove_fee_exempt_closes_the_row_and_returns_the_rent_to_the_admin() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();
    let wallet = f.holder.pubkey();
    expect_ok(
        grant(&mut f, &admin, &wallet, SIDE_ALL_BITS, NOW_SECS + 86_400),
        "grant",
    );

    let rent = lamports_of(&f, &fee_exempt_pda(&wallet));
    assert!(rent > 0, "the row must be rent-funded before the close");
    let before = lamports_of(&f, &admin.pubkey());
    expect_ok(revoke_exempt(&mut f, &admin, &wallet), "remove_fee_exempt");

    // "Exempt" means the account EXISTS, so a revocation that only zeroed the flags would leave a
    // roster row showing a revoked wallet as whitelisted.
    assert!(
        read_fee_exempt(&f, &wallet).is_none(),
        "the FeeExemptAccount must be closed, not merely zeroed"
    );
    let after = lamports_of(&f, &admin.pubkey());
    assert!(
        after + 100_000 > before + rent,
        "close = admin must pay the rent to the admin (before {before}, after {after}, rent {rent})"
    );
}

// ---------------------------------------------------------------- routing toggle

#[test]
fn set_fee_routing_enabled_writes_the_negated_field() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();
    assert!(
        !f.config().fee_routing_disabled,
        "premium routing must be ON at launch"
    );

    // The instruction takes `enabled` and the FIELD is `disabled`. An inverted assignment still
    // returns Ok and still emits FeeRoutingChanged { enabled }, and routing OFF is the only remedy
    // for a Circle-frozen fee-vault ATA, so a silent no-op here bricks mint and redeem.
    expect_ok(
        set_routing(&mut f, &admin, false),
        "set_fee_routing_enabled(false)",
    );
    assert!(
        f.config().fee_routing_disabled,
        "routing OFF must set fee_routing_disabled = true"
    );

    expect_error(
        set_routing(&mut f, &admin, false),
        E_PROPOSAL_NO_OP,
        "a redundant toggle must not log a routing change that did not happen",
    );

    expect_ok(
        set_routing(&mut f, &admin, true),
        "set_fee_routing_enabled(true)",
    );
    assert!(
        !f.config().fee_routing_disabled,
        "routing ON must clear fee_routing_disabled"
    );
}

// ---------------------------------------------------------------- the fee-vault sweep

#[test]
fn withdraw_fees_sweeps_a_treasury_sitting_exactly_on_its_floor() {
    let (mut f, s) = sweep_fixture(FLOOR, true);
    let admin = f.admin.insecure_clone();
    assert_eq!(
        token_amount(&f, &s.usdc_treasury),
        f.config().treasury_min_float_usdc,
        "the treasury must start exactly ON the floor"
    );

    // A4 compares the RAW treasury balance with `>=`, so a treasury exactly at its floor is still
    // sweepable. A `>` here would strand revenue whenever the float is met precisely.
    let meta = expect_ok(
        withdraw(&mut f, &admin, 400_000, &s),
        "withdraw_fees with the treasury exactly on its floor",
    );

    let ev = fees_withdrawn(&meta.logs);
    assert_eq!(
        Pubkey::new_from_array(ev.destination),
        admin.pubkey(),
        "FeesWithdrawn.destination must be the OWNER, not the token account"
    );
    assert_eq!(ev.amount, 400_000, "FeesWithdrawn.amount");
    // `remaining` is the post-sweep balance and lives only in the event: an operator's revenue ledger
    // is reconstructed from it, so reporting the pre-sweep balance overstates the vault forever.
    assert_eq!(
        ev.remaining,
        VAULT_START - 400_000,
        "FeesWithdrawn.remaining must be the balance AFTER the sweep"
    );
    assert_eq!(
        Pubkey::new_from_array(ev.by),
        admin.pubkey(),
        "FeesWithdrawn.by"
    );
    assert_eq!(ev.timestamp, now(&f), "FeesWithdrawn.timestamp");

    assert_eq!(
        token_amount(&f, &s.fee_vault),
        VAULT_START - 400_000,
        "the fee vault did not lose the swept amount"
    );
    assert_eq!(
        token_amount(&f, &s.destination),
        400_000,
        "the destination did not receive the swept amount"
    );
}

#[test]
fn withdraw_fees_refuses_a_treasury_one_atom_below_its_floor() {
    let (mut f, s) = sweep_fixture(FLOOR - 1, true);
    let admin = f.admin.insecure_clone();

    // Without A4, 1.5% of every redemption routes around the redemption float into an instantly
    // sweepable vault.
    expect_error(
        withdraw(&mut f, &admin, 1, &s),
        E_FLOOR_BREACHED,
        "one atom below the floor",
    );

    // A4 only binds because the treasury account itself is pinned by `address = config.usdc_treasury`.
    // Without that, any fat USDC account satisfies the same require! while it still looks enforced.
    let mint = f.usdc_mint;
    let decoy = make_token_account(&mut f, &mint, &admin.pubkey(), u64::MAX);
    let mut spoof = s.clone();
    spoof.usdc_treasury = decoy;
    expect_error(
        withdraw(&mut f, &admin, 1, &spoof),
        E_CONSTRAINT_ADDRESS,
        "a decoy treasury account",
    );
    assert_eq!(
        token_amount(&f, &s.fee_vault),
        VAULT_START,
        "no sweep may have landed"
    );
}

#[test]
fn withdraw_fees_refuses_a_pause_a_zero_an_over_sweep_and_a_stranding_destination() {
    let (mut f, s) = sweep_fixture(FLOOR, false);
    let admin = f.admin.insecure_clone();

    // D31 parity with execute_withdraw_usdc: an ordinary sweep must not land mid-incident.
    expect_error(
        withdraw(&mut f, &admin, 1, &s),
        E_PAUSED,
        "a sweep while the protocol is paused",
    );
    unpause(&mut f);

    // A zero sweep would emit FeesWithdrawn, putting a phantom revenue event in the log.
    expect_error(
        withdraw(&mut f, &admin, 0, &s),
        E_ZERO_AMOUNT,
        "a zero sweep",
    );
    expect_error(
        withdraw(&mut f, &admin, VAULT_START + 1, &s),
        E_INSUFFICIENT_FEE_VAULT,
        "an over-sweep must use the dedicated error, not an opaque SPL one",
    );

    // A self-sweep is a token-program no-op, so FeesWithdrawn would report a `remaining` that never was.
    let mut self_sweep = s.clone();
    self_sweep.destination = s.fee_vault;
    expect_error(
        withdraw(&mut f, &admin, 1, &self_sweep),
        E_WITHDRAW_RECIPIENT_MISMATCH,
        "a self-sweep",
    );

    // Nor a non-ATA owned by the fee-vault PDA: no instruction can move funds out of there again.
    let mint = f.usdc_mint;
    let stranded = make_token_account(&mut f, &mint, &fee_vault_pda(), 0);
    let mut to_pda = s.clone();
    to_pda.destination = stranded;
    expect_error(
        withdraw(&mut f, &admin, 1, &to_pda),
        E_FEE_WITHDRAW_DESTINATION_STRANDED,
        "a destination owned by the fee-vault PDA",
    );

    assert_eq!(
        token_amount(&f, &s.fee_vault),
        VAULT_START,
        "none of the refused sweeps may have moved money"
    );
}

#[test]
fn every_fee_instruction_is_admin_gated_on_chain() {
    let (mut f, s) = sweep_fixture(FLOOR, true);
    let admin = f.admin.insecure_clone();
    let stranger = f.stranger.insecure_clone();
    let wallet = f.holder.pubkey();
    let expiry = now(&f) + 86_400;

    // Without has_one, any signer grants itself a both-sides waiver and mints and redeems at exact
    // spot, and any signer sweeps the whole accrued premium into an account it owns.
    expect_error(
        grant(&mut f, &stranger, &wallet, SIDE_ALL_BITS, expiry),
        E_CONSTRAINT_HAS_ONE,
        "set_fee_exempt by a stranger",
    );
    expect_ok(
        grant(&mut f, &admin, &wallet, SIDE_MINT_BIT, expiry),
        "the admin's own grant",
    );
    expect_error(
        revoke_exempt(&mut f, &stranger, &wallet),
        E_CONSTRAINT_HAS_ONE,
        "remove_fee_exempt by a stranger",
    );
    expect_error(
        withdraw(&mut f, &stranger, 1, &s),
        E_CONSTRAINT_HAS_ONE,
        "withdraw_fees by a stranger",
    );
    expect_error(
        set_routing(&mut f, &stranger, false),
        E_CONSTRAINT_HAS_ONE,
        "set_fee_routing_enabled by a stranger",
    );

    assert!(
        read_fee_exempt(&f, &wallet).is_some(),
        "the admin's grant must have survived"
    );
    assert_eq!(token_amount(&f, &s.fee_vault), VAULT_START);
    assert!(!f.config().fee_routing_disabled);
}
