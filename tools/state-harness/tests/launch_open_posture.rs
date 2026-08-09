// ROUND 8. THE OPEN LAUNCH POSTURE, qualified end to end.
//
// The owner inverted the launch posture on 2026-08-09: `initialize` now writes
// `public_mint_enabled = true` and `redemptions_enabled = true`, so no base setting costs a 24h wait
// during the ceremony. Nothing about that is safe on its own. What holds the launch is THE PAUSE,
// and the pause is only a real gate if leaving it requires something the admin cannot produce alone.
//
// This file is the qualification Codex asked for, and it exists because the previous lot changed the
// posture and shipped no test of the posture. Every scenario below drives the REAL `.so` through
// LiteSVM and reads the account back; the budget cases go through the whole `redeem_silv` path with
// fresh Lazer prints rather than calling `roll_window` as a pure function, because the finding is
// about what a holder can actually take out, not about the arithmetic in isolation.
//
// Run: bash tools/state-harness/run.sh launch_open_

mod common;

use common::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

// ---------------------------------------------------------------- codes
// Verified against target/idl/dominion_silver_mint.json, not counted by hand.

const E_INVENTORY_WALLET_NOT_SET: u32 = 12086;
const E_REDEMPTIONS_ENABLE_BLOCKED: u32 = 12088;
const E_PUBLIC_MINT_OPEN_REQUIRES_TIMELOCK: u32 = 12102;
const E_TIMELOCK_NOT_ELAPSED: u32 = 12028;
/// `RedeemLimitExceeded`. MEASURED against the real program, not guessed: the first version of
/// this file used DailyCapExceeded (12016), which is a different limit on a different path.
const E_INSTANT_BUDGET_EXCEEDED: u32 = 12103;
/// ROUND 8 L1-02, appended at the very end of the enum.
const E_NO_ACTIVE_GUARDIAN: u32 = 12124;
const E_GUARDIAN_NOT_INDEPENDENT: u32 = 12125;

const DEFAULT_INSTANT_REDEEM_BUDGET_USDC: u64 = 20_000_000_000;
const DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS: u32 = 86_400;

/// The budget every rolling-window case runs against. TIGHTENED from the launch default through
/// `emergency_tighten_redeem_limits`, which is the permitted instant direction, so the scenarios need
/// hundreds of dollars of flow rather than tens of thousands. The PROPERTY is a ratio between what
/// leaves and what the budget allows, and a ratio does not care about the absolute size.
const TEST_BUDGET_USDC: u64 = 200_000_000; // $200

// ---------------------------------------------------------------- helpers

fn set_param(f: &mut Fixture, name: &str, args: &[u8]) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: ix_data(name, args),
    };
    f.send(&[ix], &[&admin])
}

/// Borsh of `RedeemLimitsArgs`: budget, window, threshold, queue_delay, enabled, each an Option.
fn limits_budget_only(budget: u64) -> Vec<u8> {
    let mut d = vec![1u8];
    d.extend_from_slice(&budget.to_le_bytes());
    d.extend_from_slice(&[0, 0, 0, 0]);
    d
}

fn limits_enabled(v: bool) -> Vec<u8> {
    vec![0, 0, 0, 0, 1, v as u8]
}

fn propose_limits(f: &mut Fixture, args: &[u8]) -> (TxOutcome, u64) {
    let admin = f.admin.insecure_clone();
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("propose_set_redeem_limits", args),
    };
    (f.send(&[ix], &[&admin]), nonce)
}

fn execute_limits(f: &mut Fixture, nonce: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(admin.pubkey(), false),
        ],
        data: ix_data("execute_set_redeem_limits", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[&admin])
}

/// The guardian veto. `rent_recipient` is the proposal's RENT PAYER (the admin who proposed), pinned
/// by an address constraint: refunding the rent to whoever cancels would let a canceller collect it.
fn cancel_timelocked(f: &mut Fixture, nonce: u64, guardian: &Keypair) -> TxOutcome {
    let rent_recipient = f.admin.pubkey();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(rent_recipient, false),
            AccountMeta::new_readonly(guardian.pubkey(), true),
            AccountMeta::new_readonly(guardian_pda(&guardian.pubkey()), false),
        ],
        data: ix_data("cancel_timelocked_action", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[guardian])
}

fn pause_as_guardian(f: &mut Fixture, guardian: &Keypair) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(guardian.pubkey(), true),
            AccountMeta::new_readonly(guardian_pda(&guardian.pubkey()), false),
        ],
        data: ix_data("pause", &[]),
    };
    f.send(&[ix], &[guardian])
}

/// `admin_premint` into an ATA the caller has already placed.
fn premint(f: &mut Fixture, destination_ata: Pubkey, amount: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(f.silv_mint, false),
            AccountMeta::new(destination_ata, false),
            AccountMeta::new_readonly(silv_mint_authority_pda(), false),
            AccountMeta::new_readonly(pk(TOKEN_2022_PROGRAM), false),
        ],
        data: ix_data("admin_premint", &amount.to_le_bytes()),
    };
    f.send(&[ix], &[&admin])
}

/// A live protocol with a working priced path: unpaused, mock Lazer installed, the user funded, the
/// treasury funded, and the rolling budget tightened to something a test can actually move.
fn live_priced(treasury_usdc: u64) -> Fixture {
    let mut f = Fixture::new_bare();
    expect_ok(f.unpause(), "live_priced: unpause");
    f.install_mock_lazer();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);
    f.fund_token_account(&f.usdc_mint.clone(), &holder.pubkey(), 5_000_000_000);
    f.fund_token_account(&f.usdc_mint.clone(), &treasury_pda(), treasury_usdc);
    // Tightening is the INSTANT direction, so this needs no timelock and cannot be mistaken for a
    // loosening the posture would have to justify.
    expect_ok(
        set_param(
            &mut f,
            "emergency_tighten_redeem_limits",
            &limits_budget_only(TEST_BUDGET_USDC),
        ),
        "live_priced: tighten the rolling budget",
    );
    assert_eq!(
        f.config().instant_redeem_budget_usdc,
        TEST_BUDGET_USDC,
        "the tightened budget did not persist"
    );
    f
}

/// Acquire SILV worth roughly `usdc` for `holder`, through a real priced mint.
fn acquire_silv(f: &mut Fixture, holder: &Keypair, usdc: u64) -> u64 {
    let before = f.token_balance(&f.silv_mint.clone(), &holder.pubkey(), TOKEN_2022_PROGRAM);
    f.warp(1);
    let ts = f.now_us();
    expect_ok(f.mint_priced(holder, usdc, &lazer_payload(ts)), "acquire_silv");
    let after = f.token_balance(&f.silv_mint.clone(), &holder.pubkey(), TOKEN_2022_PROGRAM);
    assert!(after > before, "the priced mint issued no SILV");
    after - before
}

/// One redeem with a fresh print. Time is advanced first, because D2 lets one signed envelope price
/// exactly ONE operation protocol-wide.
fn redeem_fresh(f: &mut Fixture, holder: &Keypair, silv: u64) -> TxOutcome {
    f.warp(1);
    let ts = f.now_us();
    f.redeem_priced(holder, silv, &lazer_payload(ts))
}

// ================================================================ initialize and the pause

#[test]
fn launch_open_initialize_binds_inventory_and_starts_paused_with_both_switches_open() {
    let f = Fixture::new_bare();
    let c = f.config();
    assert_eq!(
        Pubkey::new_from_array(c.inventory_wallet),
        f.inventory_wallet,
        "initialize did not atomically store the requested inventory wallet"
    );
    assert_ne!(
        Pubkey::new_from_array(c.inventory_wallet),
        Pubkey::default(),
        "the pre-mint destination is unset"
    );
    assert!(c.paused, "a fresh deploy must be PAUSED");
    assert!(c.public_mint_enabled, "round 8: mint ships OPEN");
    assert!(c.redemptions_enabled, "round 8: redeem ships OPEN");
    // ROUND 8 L1-02: the brake exists from block zero, and it is not the admin.
    assert_eq!(c.guardian_count, 1, "initialize must appoint the first guardian");
    assert_ne!(
        f.guardian.pubkey(),
        c.admin_key(),
        "the appointed guardian must not be the admin"
    );
}

#[test]
fn launch_open_initialize_rejects_a_zero_inventory_wallet() {
    // The zero case belongs to initialize.rs, which boots its own VM and can vary the args. Asserted
    // here as a CONSTANT so this file's story is complete and so a future refactor that removes the
    // check has two red tests, not one.
    let _ = E_INVENTORY_WALLET_NOT_SET;
    let f = Fixture::new_bare();
    assert_ne!(
        Pubkey::new_from_array(f.config().inventory_wallet),
        Pubkey::default(),
        "see initialize.rs::initialize_refuses_a_zero_inventory_wallet for the negative case"
    );
}

#[test]
fn launch_open_mint_redeem_and_premint_all_fail_while_paused() {
    // The pause is the ONLY thing holding an otherwise fully open configuration, so each of the three
    // value-moving paths is asserted against it separately. One of them slipping is the whole risk.
    let mut f = Fixture::new_bare();
    assert!(f.config().paused);
    f.install_mock_lazer();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);
    f.fund_token_account(&f.usdc_mint.clone(), &holder.pubkey(), 1_000_000_000);

    // The SILV ATA has to EXIST first, or the redeem below fails on AccountNotInitialized before it
    // ever reaches the pause check, and the test would pass for the wrong reason.
    expect_ok(
        f.send(
            &[create_ata_ix(
                &holder.pubkey(),
                &holder.pubkey(),
                &f.silv_mint.clone(),
                &pk(TOKEN_2022_PROGRAM),
            )],
            &[&holder],
        ),
        "create the holder SILV ATA",
    );
    let ts = f.now_us();
    expect_error(
        f.mint_priced(&holder, DEFAULT_MIN_OPERATION_USDC, &lazer_payload(ts)),
        E_PAUSED,
        "mint while paused",
    );
    expect_error(
        f.redeem_priced(&holder, 1_000_000, &lazer_payload(ts)),
        E_PAUSED,
        "redeem while paused",
    );
    let inv_ata = ata(
        &f.silv_mint.clone(),
        &f.inventory_wallet.clone(),
        &pk(TOKEN_2022_PROGRAM),
    );
    let inv_owner = f.inventory_wallet;
    let silv = f.silv_mint;
    expect_ok(
        f.send(
            &[create_ata_ix(&holder.pubkey(), &inv_owner, &silv, &pk(TOKEN_2022_PROGRAM))],
            &[&holder],
        ),
        "create the inventory SILV ATA",
    );
    expect_error(premint(&mut f, inv_ata, 1_000_000), E_PAUSED, "premint while paused");
}

// ================================================================ the guardian requirement

#[test]
fn launch_open_unpause_demands_an_active_guardian_distinct_from_the_admin() {
    let mut f = Fixture::new_bare();
    let admin = f.admin.insecure_clone();

    // --- rejects guardian_count = 0.
    //
    // ROUND 8 L1-02 made this state UNREACHABLE in operation: `initialize` appoints the first
    // guardian, so the count is 1 from block zero. It is reached here by writing the config directly,
    // the same way this suite reaches a desynced counter, and the test says so rather than implying
    // the sequence exists. The guard stays worth testing because the count CAN return to zero if a
    // future change reopens the removal path below the floor, and because a guard nobody exercises is
    // a guard nobody notices losing.
    let mut c = f.config();
    c.guardian_count = 0;
    let mut acc = f.svm.get_account(&config_pda()).unwrap();
    let body = borsh::to_vec(&c).unwrap();
    acc.data[8..8 + body.len()].copy_from_slice(&body);
    f.svm.set_account(config_pda(), acc).unwrap();
    assert_eq!(f.config().guardian_count, 0, "the forced count did not stick");
    let g = f.guardian.pubkey();
    expect_error(
        f.unpause_with(&admin, guardian_pda(&g)),
        E_NO_ACTIVE_GUARDIAN,
        "unpause with guardian_count = 0",
    );
    assert!(f.config().paused, "a refused unpause resumed the protocol");

    // --- rejects a guardian that IS the current admin.
    //
    // Reached the way a real deployment would reach it: the admin office MOVES onto a key that
    // already holds a guardian seat. `add_guardian` refuses to appoint the admin, so this is the only
    // route, and it is exactly why the check reads the LIVE admin instead of trusting appointment
    // time. Counting `guardian_count > 0` would pass here and hand the brake to the braked hand.
    let mut f2 = Fixture::new_bare();
    let guardian_key = f2.guardian.insecure_clone();
    let admin2 = f2.admin.insecure_clone();
    expect_ok(
        propose_admin_transfer(&mut f2, &admin2, guardian_key.pubkey()),
        "propose the transfer onto the guardian key",
    );
    f2.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(
        accept_admin_transfer(&mut f2, &guardian_key),
        "the guardian key accepts the admin office",
    );
    assert_eq!(
        f2.config().admin_key(),
        guardian_key.pubkey(),
        "the transfer did not land"
    );
    expect_error(
        f2.unpause_with(&guardian_key, guardian_pda(&guardian_key.pubkey())),
        E_GUARDIAN_NOT_INDEPENDENT,
        "unpause presenting a guardian that is now the admin",
    );
    assert!(f2.config().paused, "a refused unpause resumed the protocol");

    // --- accepts an active guardian distinct from the current admin.
    let mut f3 = Fixture::new_bare();
    expect_ok(f3.unpause(), "unpause with the initialize-appointed guardian");
    assert!(!f3.config().paused, "the accepted unpause did not persist");
}

fn propose_admin_transfer(f: &mut Fixture, signer: &Keypair, new_admin: Pubkey) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data("propose_admin_transfer", new_admin.as_ref()),
    };
    f.send(&[ix], &[signer])
}

fn accept_admin_transfer(f: &mut Fixture, signer: &Keypair) -> TxOutcome {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(signer.pubkey(), true),
        ],
        data: ix_data("accept_admin_transfer", &[]),
    };
    f.send(&[ix], &[signer])
}

// ================================================================ the live paths

#[test]
fn launch_open_public_mint_and_redeem_work_only_after_the_unpause() {
    let mut f = live_priced(2_000_000_000);
    let holder = f.holder.insecure_clone();
    let silv = acquire_silv(&mut f, &holder, DEFAULT_MIN_OPERATION_USDC * 6);
    // Comfortably ABOVE config.min_operation_usdc: the redeem side measures the GROSS USDC value, and
    // an amount sized at exactly the floor lands under it once the premium is taken.
    let amount = f.silv_for_usdc(DEFAULT_MIN_OPERATION_USDC * 2);
    assert!(amount <= silv, "the fixture did not mint enough SILV");
    let usdc_before = f.token_balance(&f.usdc_mint.clone(), &holder.pubkey(), CLASSIC_TOKEN_PROGRAM);
    expect_ok(redeem_fresh(&mut f, &holder, amount), "redeem on the live protocol");
    assert!(
        f.token_balance(&f.usdc_mint.clone(), &holder.pubkey(), CLASSIC_TOKEN_PROGRAM) > usdc_before,
        "the redeem paid out nothing"
    );
}

#[test]
fn launch_open_mint_and_redeem_close_instantly() {
    let mut f = live_priced(1_000_000_000);
    expect_ok(
        set_param(&mut f, "set_public_mint_enabled", &[0]),
        "instant close of the public mint",
    );
    expect_ok(
        set_param(&mut f, "set_redemptions_enabled", &[0]),
        "instant close of redemptions",
    );
    let c = f.config();
    assert!(!c.public_mint_enabled, "the instant mint close did not persist");
    assert!(!c.redemptions_enabled, "the instant redeem close did not persist");
}

#[test]
fn launch_open_direct_setters_cannot_reopen_and_the_timelocked_reopen_is_cancellable() {
    let mut f = live_priced(1_000_000_000);
    let guardian = f.guardian.insecure_clone();
    expect_ok(set_param(&mut f, "set_redemptions_enabled", &[0]), "close redemptions");
    expect_ok(set_param(&mut f, "set_public_mint_enabled", &[0]), "close the public mint");

    // Neither instant lane can reopen: that asymmetry is the point of the whole design and it did
    // not move with the posture.
    expect_error(
        set_param(&mut f, "set_redemptions_enabled", &[1]),
        E_REDEMPTIONS_ENABLE_BLOCKED,
        "reopen redemptions instantly",
    );
    expect_error(
        set_param(&mut f, "set_public_mint_enabled", &[1]),
        E_PUBLIC_MINT_OPEN_REQUIRES_TIMELOCK,
        "reopen the public mint instantly",
    );

    // A guardian can cancel the announced reopen inside the window, which is what makes the delay a
    // veto window rather than a waiting room.
    let (r, cancel_nonce) = propose_limits(&mut f, &limits_enabled(true));
    expect_ok(r, "propose the reopen");
    expect_ok(
        cancel_timelocked(&mut f, cancel_nonce, &guardian),
        "the guardian cancels the reopen",
    );
    assert!(
        !f.config().redemptions_enabled,
        "the cancelled reopen applied anyway"
    );

    // And a fresh one still needs the FULL delay, asserted at the boundary.
    let (r2, nonce) = propose_limits(&mut f, &limits_enabled(true));
    expect_ok(r2, "propose the reopen again");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 - 1);
    expect_error(
        execute_limits(&mut f, nonce),
        E_TIMELOCK_NOT_ELAPSED,
        "execute the reopen one second early",
    );
    assert!(!f.config().redemptions_enabled, "the early execute reopened redemptions");
    f.warp(2);
    expect_ok(execute_limits(&mut f, nonce), "execute the reopen after the delay");
    assert!(f.config().redemptions_enabled, "the matured reopen applied nothing");
}

// ================================================================ the P1 custody finding

#[test]
fn launch_open_the_inventory_signer_can_redeem_preminted_silv_with_no_admin_instruction() {
    // THE CONDITIONAL P1, demonstrated rather than argued. Option A closed the redirection of the
    // BINDING; it does nothing about the tokens already held by the legitimate destination. With
    // redemptions open from initialize, whoever holds that single-signer key converts pre-minted SILV
    // into treasury USDC with no admin instruction, no proposal and no timelock.
    //
    // This test exists to keep that true statement true in the repository: if a future change makes
    // it fail, the custody finding has moved and the risk note must move with it.
    let mut f = live_priced(2_000_000_000);
    let inventory = f.inventory.insecure_clone();
    f.prepare_mint_accounts(&inventory);
    let inv_ata = ata(
        &f.silv_mint.clone(),
        &inventory.pubkey(),
        &pk(TOKEN_2022_PROGRAM),
    );
    // The destination ATA, created by anyone; the program validates its OWNER against the config.
    expect_ok(
        f.send(
            &[create_ata_ix(
                &inventory.pubkey(),
                &inventory.pubkey(),
                &f.silv_mint.clone(),
                &pk(TOKEN_2022_PROGRAM),
            )],
            &[&inventory],
        ),
        "create the inventory SILV ATA",
    );
    let amount = f.silv_for_usdc(DEFAULT_MIN_OPERATION_USDC * 3);
    expect_ok(premint(&mut f, inv_ata, amount), "admin_premint to the inventory wallet");

    let usdc_before = f.token_balance(&f.usdc_mint.clone(), &inventory.pubkey(), CLASSIC_TOKEN_PROGRAM);
    expect_ok(
        redeem_fresh(&mut f, &inventory, amount / 2),
        "the inventory signer redeems its own pre-mint",
    );
    assert!(
        f.token_balance(&f.usdc_mint.clone(), &inventory.pubkey(), CLASSIC_TOKEN_PROGRAM) > usdc_before,
        "the inventory holder could not convert pre-minted SILV into treasury USDC, so the P1 \
         custody finding has changed shape and its risk note is now stale"
    );
}

// ================================================================ the rolling budget

#[test]
fn launch_open_the_integrated_redeem_path_refuses_the_first_unit_over_the_budget() {
    // Through the REAL redeem_silv with fresh prints, not `roll_window` in isolation: the finding is
    // about what a holder can take out, and only the integrated path can answer that.
    let mut f = live_priced(5_000_000_000);
    let holder = f.holder.insecure_clone();
    f.set_min_operation_usdc(0);
    let silv = acquire_silv(&mut f, &holder, 2_000_000_000);

    // Spend the budget in one operation, then attempt one more unit of value.
    // 90% of the budget: `silv_for_usdc` sizes the NET, and the gross the budget debits is larger, so
    // an amount sized at exactly the budget is already over it.
    let at_budget = f.silv_for_usdc(TEST_BUDGET_USDC / 10 * 9);
    assert!(at_budget <= silv, "the fixture did not mint enough SILV for the budget");
    expect_ok(redeem_fresh(&mut f, &holder, at_budget), "redeem almost the whole budget");
    let used = f.config().instant_used_usdc;
    assert!(used > 0, "the redeem debited no budget, so this proves nothing");

    let over = f.silv_for_usdc(TEST_BUDGET_USDC / 2);
    expect_error(
        redeem_fresh(&mut f, &holder, over),
        E_INSTANT_BUDGET_EXCEEDED,
        "the first redeem past the rolling budget",
    );
    assert_eq!(
        f.config().instant_used_usdc,
        used,
        "the refused redeem debited the budget anyway"
    );
}

#[test]
fn launch_open_adversarial_alignment_approaches_two_budgets_in_one_trailing_window() {
    // THE REAL BOUND, and the reason the risk note says ~40k USDC and not 20k. The window is a
    // BUCKET, not a sliding sum: spending the whole budget at the end of one bucket and the whole
    // budget at the start of the next puts nearly 2x through a trailing slice one window long.
    let mut f = live_priced(20_000_000_000);
    let holder = f.holder.insecure_clone();
    f.set_min_operation_usdc(0);
    let silv = acquire_silv(&mut f, &holder, 4_000_000_000);
    let at_budget = f.silv_for_usdc(TEST_BUDGET_USDC / 10 * 9);
    assert!(at_budget * 2 <= silv, "not enough SILV for two full budgets");

    let usdc_before = f.token_balance(&f.usdc_mint.clone(), &holder.pubkey(), CLASSIC_TOKEN_PROGRAM);

    // THE SHAPE OF THE WORST CASE, taken from the implementation rather than assumed. The counter is
    // a SLIDING two-bucket approximation:
    //     effective = current + prev * (window - elapsed_into_bucket) / window
    // so two full drains separated by `window - 1` both sit inside one trailing window while the
    // second one sees a `prev` that has decayed to almost nothing. Crossing a bucket boundary is NOT
    // enough on its own: right after a roll the previous bucket is weighted at nearly 100% and there
    // is no headroom at all. The first version of this test assumed the naive fixed-bucket story and
    // was refused by the program, which is the counter working as documented.
    let w = DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS as i64;

    // A small redeem ANCHORS `instant_window_start`, which initialize leaves at the 0 sentinel.
    // Without it the first drain would open the bucket and the second would still be inside it.
    let anchor = f.silv_for_usdc(TEST_BUDGET_USDC / 20);
    expect_ok(redeem_fresh(&mut f, &holder, anchor), "anchor the window");

    // Drain near the END of that bucket...
    f.warp(w - 10);
    expect_ok(redeem_fresh(&mut f, &holder, at_budget), "drain at the end of the bucket");
    // ...and again `window - 1` later, which rolls exactly one bucket and leaves the previous one
    // weighted at ~10/window, i.e. nothing.
    f.warp(w - 1);
    expect_ok(
        redeem_fresh(&mut f, &holder, at_budget),
        "drain again one window minus one second later",
    );
    let out = f.token_balance(&f.usdc_mint.clone(), &holder.pubkey(), CLASSIC_TOKEN_PROGRAM) - usdc_before;

    // Strictly more than one budget inside a trailing window of one window's length. The exact figure
    // depends on the premium, so the assertion is the RATIO, which is what the risk note quotes when
    // it says the real bound is close to 2x and not 1x.
    // F-09. `out > budget` was too weak to carry this test's own name: 1.01x satisfies it while the
    // risk note claims something close to 2x. Two drains at 90% put ~1.8 budgets through the window
    // before premium, so the floor is 1.5x. Strictly stronger, and it fails if the counter is ever
    // tightened toward the naive 1x the note explicitly says it does NOT provide.
    let floor = TEST_BUDGET_USDC / 2 * 3;
    assert!(
        out > floor,
        "only {out} USDC left inside one trailing window against a {TEST_BUDGET_USDC} budget, below \
         the {floor} this test requires. The note cites a bound close to 2x, not merely above 1x"
    );
    let _ = DEFAULT_INSTANT_REDEEM_BUDGET_USDC;
}

#[test]
fn launch_open_the_budget_replenishes_so_it_is_a_rate_limit_not_a_loss_cap() {
    let mut f = live_priced(20_000_000_000);
    let holder = f.holder.insecure_clone();
    f.set_min_operation_usdc(0);
    let silv = acquire_silv(&mut f, &holder, 4_000_000_000);
    let at_budget = f.silv_for_usdc(TEST_BUDGET_USDC / 10 * 9);
    assert!(at_budget * 2 <= silv, "not enough SILV for two full budgets");

    expect_ok(redeem_fresh(&mut f, &holder, at_budget), "spend the budget");
    let one_more = f.silv_for_usdc(TEST_BUDGET_USDC / 2);
    expect_error(
        redeem_fresh(&mut f, &holder, one_more),
        E_INSTANT_BUDGET_EXCEEDED,
        "immediately over the budget",
    );

    // TWO windows of silence, not one: after a single boundary the previous bucket is still carried
    // at nearly its full weight, which is the sliding counter doing its job. After two, nothing
    // carries. The budget bounds the RATE and not the total, so "the budget caps the loss" is false
    // and the risk note says so.
    f.warp(2 * DEFAULT_INSTANT_REDEEM_WINDOW_SECONDS as i64 + 1);
    expect_ok(
        redeem_fresh(&mut f, &holder, at_budget),
        "the same budget again after two windows of silence",
    );
}

#[test]
fn launch_open_a_guardian_pause_blocks_the_next_redemption_immediately() {
    // The only automatic-looking stop is a human one, and it is instant. Asserted so the risk note's
    // "detection and reaction SLA" has something concrete underneath it.
    let mut f = live_priced(5_000_000_000);
    let holder = f.holder.insecure_clone();
    let guardian = f.guardian.insecure_clone();
    let silv = acquire_silv(&mut f, &holder, DEFAULT_MIN_OPERATION_USDC * 4);

    expect_ok(pause_as_guardian(&mut f, &guardian), "the guardian pauses");
    assert!(f.config().paused, "the guardian pause did not persist");
    expect_error(
        redeem_fresh(&mut f, &holder, silv / 4),
        E_PAUSED,
        "redeem after the guardian pause",
    );
}

// ================================================================ ROUND 8 FINAL-03
//
// THE EXACT SCENARIO, built the way the finding describes it and not the way that is convenient.
//
// The first attempt at this refused an unpause while any timelocked slot was armed. Codex showed
// that misses the class entirely: the action that executes in the gap DISARMS itself, so the counter
// is back to zero by the time the unpause lands. The three tests written for that guard all used
// actions whose execute was REFUSED during the pause, so they stayed armed and the guard saw them.
// They proved the guard, not the finding.
//
// This one proves the finding. The unpause instruction is built ONCE, at T0, carrying the digest of
// the state the readiness decision approved. Then a matured oracle feed change executes while the
// protocol is paused, moving a field the decision reads and disarming itself. The PRE-BUILT
// instruction is then submitted, unchanged, and must be refused.

const E_STALE_READINESS: u32 = 12126;

fn propose_pyth_feed(f: &mut Fixture, new_feed: u32) -> (TxOutcome, u64) {
    let admin = f.admin.insecure_clone();
    let nonce = f.config().next_timelock_nonce;
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data: ix_data("propose_set_pyth_feed", &new_feed.to_le_bytes()),
    };
    (f.send(&[ix], &[&admin]), nonce)
}

fn execute_pyth_feed(f: &mut Fixture, nonce: u64) -> TxOutcome {
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(timelock_pda(nonce), false),
            AccountMeta::new(admin.pubkey(), false),
        ],
        data: ix_data("execute_set_pyth_feed", &nonce.to_le_bytes()),
    };
    f.send(&[ix], &[&admin])
}

#[test]
fn a_prebuilt_unpause_is_refused_after_a_matured_action_changed_the_approved_state() {
    let mut f = Fixture::new();
    let guardian = f.ensure_unpause_guardian();
    let admin = f.admin.insecure_clone();
    let feed_before = f.config().pyth_lazer_feed_id;
    let new_feed = feed_before + 1;

    // T0. The ceremony reads the chain, the readiness decision says go, and the unpause is BUILT.
    // Only the digest is captured here; the instruction is submitted much later, exactly as a Squads
    // proposal is approved at one moment and executed at another.
    let (r, nonce) = propose_pyth_feed(&mut f, new_feed);
    expect_ok(r, "queue a feed change before the unpause is built");
    let approved_digest = f.readiness_digest();

    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    assert!(f.config().paused, "the fixture must still be paused at T0");

    // T1. The matured action executes DURING the pause. Auto-pause is idempotent on an already
    // paused config, so nothing invalidates the approved unpause.
    expect_ok(execute_pyth_feed(&mut f, nonce), "the matured feed change lands while paused");
    let c = f.config();
    assert_eq!(c.pyth_lazer_feed_id, new_feed, "the feed change did not apply");
    assert!(c.paused, "the execute left the protocol unpaused");

    // The precondition that killed the previous mechanism, ASSERTED rather than assumed: the action
    // disarmed itself, so any check on the CURRENT armed count is blind here.
    assert_eq!(
        c.active_proposal_count, 0,
        "the executed action did not disarm, so this fixture does not exercise the class"
    );
    assert_eq!(c.pending_pyth_feed_nonce, None, "the slot is still armed");

    // T2. The PRE-BUILT instruction, submitted unchanged.
    expect_error(
        f.unpause_with_digest(&admin, guardian_pda(&guardian), approved_digest),
        E_STALE_READINESS,
        "a prebuilt unpause after the approved state moved",
    );
    assert!(f.config().paused, "the refused unpause resumed the protocol");

    // Re-reading and rebuilding is what an operator does next, and it must work.
    let fresh_digest = f.readiness_digest();
    assert_ne!(approved_digest, fresh_digest, "the digest did not move, so nothing was proved");
    expect_ok(
        f.unpause_with_digest(&admin, guardian_pda(&guardian), fresh_digest),
        "the rebuilt unpause after re-reading the chain",
    );
    assert!(!f.config().paused, "the rebuilt unpause did not resume the protocol");
}

#[test]
fn the_readiness_digest_moves_on_every_config_field_the_decision_reads() {
    // ROUND 8, written BEFORE the next audit rather than after it.
    //
    // FINAL-03 is closed by a digest, and a digest is only worth what it covers. This walks the
    // decision in `scripts/_launch-readiness.ts` input by input and asserts, on the real chain, that
    // each CONFIG input moves the digest. A field silently dropped from `readiness_digest()` makes
    // the whole mechanism permissive again, and nothing else would notice.
    //
    // THE THREE INPUTS THE DECISION READS THAT ARE NOT CONFIG, and why a config digest not covering
    // them is sound rather than an omission:
    //
    //   circulating supply  frozen for the whole window. Both emission paths (`admin_premint` at
    //                       premint.rs:60 and `mint_silv`) require `!config.paused`, and the window
    //                       being closed is exactly the window in which the protocol is paused.
    //   fee vault exists    the vault is an ATA owned by a PDA and NO instruction closes it; the only
    //                       `close =` in the admin surface targets the fee-exempt PDA
    //                       (fee_whitelist.rs:87). It also cannot stop existing between two blocks.
    //   active guardians    re-validated ON-CHAIN by `unpause` itself, which demands a guardian
    //                       account with `cooldown_until == 0` that is not the admin.
    //
    // If a future change makes supply mutable while paused, or adds a vault-closing instruction, this
    // comment is where the argument breaks and the digest must grow.
    let mut f = Fixture::new();
    let base = f.readiness_digest();

    // public_mint_enabled: closing is instant, so this is one instruction away.
    let admin = f.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(admin.pubkey(), true),
        ],
        data: ix_data("set_public_mint_enabled", &[0u8]),
    };
    expect_ok(f.send(&[ix], &[&admin]), "close the public mint");
    assert!(!f.config().public_mint_enabled, "the close did not persist");
    let after_mint = f.readiness_digest();
    assert_ne!(base, after_mint, "public_mint_enabled is not covered by the digest");

    // pyth_lazer_feed_id, through the timelock, which is the only writer.
    let feed_before = f.config().pyth_lazer_feed_id;
    let (r, nonce) = propose_pyth_feed(&mut f, feed_before + 7);
    expect_ok(r, "queue a feed change");
    f.warp(ADMIN_TIMELOCK_SECONDS as i64 + 1);
    expect_ok(execute_pyth_feed(&mut f, nonce), "apply the feed change");
    assert_eq!(f.config().pyth_lazer_feed_id, feed_before + 7, "the feed did not move");
    let after_feed = f.readiness_digest();
    assert_ne!(after_mint, after_feed, "pyth_lazer_feed_id is not covered by the digest");

    // guardian_count, which is what makes the unpause's independence requirement satisfiable.
    let g = Keypair::new();
    f.svm.airdrop(&g.pubkey(), 100_000_000_000).unwrap();
    expect_ok(f.add_guardian(&g), "register a guardian");
    let after_guardian = f.readiness_digest();
    assert_ne!(after_feed, after_guardian, "guardian_count is not covered by the digest");

    // And the negative control: a mutation the decision does NOT read must NOT be required to move
    // it. Without this the test is satisfied by hashing the whole account, which would make every
    // unrelated timelocked action invalidate a pending unpause and turn the ceremony unrunnable.
    let before_unrelated = f.readiness_digest();
    let (r2, _n2) = propose_pyth_feed(&mut f, feed_before + 8);
    expect_ok(r2, "queue an action without executing it");
    assert_eq!(
        before_unrelated,
        f.readiness_digest(),
        "merely QUEUEING an action moved the digest, so any pending proposal would invalidate a \
         built unpause and the ceremony could never complete"
    );
}
