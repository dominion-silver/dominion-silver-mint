// The Lazer anti-replay high-water mark, tested where it is actually WRITTEN.
// `tools/lazer-harness/src/lib.rs` carries a test called
// `the_same_envelope_cannot_be_consumed_twice`. It never consumes an envelope: it hand-writes
// `last_used_feed_ts_us` into a crafted config, calls `probe_oracle_price` once, and asserts the
// equality is refused. But `probe_oracle_price` is read-only by construction (its module header says
// so, and the handler only sets return data), so that test exercises the COMPARISON and never the
// WRITE. The only two writes in the program are `mint_silv.rs:191` and `redeem_silv.rs:175`. Deleting
// either one leaves that reassuringly-named test green while the corresponding path is replayable.
// So each side is tested here explicitly: a first priced operation ACCEPTED,
// the persisted field READ BACK off the chain, and a second operation with the SAME envelope
// REFUSED. Then a mutation check on each write: if the assignment is removed, the "refused" half of
// the matching test must go green-to-red, and `both_sides_share_one_high_water_mark` is what catches
// a write that is silently pointed at the wrong side.
// D2 is what makes this strict: `fut <= last_used` is refused, so one signed envelope prices exactly
// ONE operation. The availability consequence of that choice is the minimum-operation floor, handled separately by
// `config.min_operation_usdc`.

mod common;

use common::*;
use solana_sdk::signature::Signer;

/// `DominionError::LazerReplayed`. Verified against target/idl, not counted by hand.
/// It is a NEW code, added in this batch. Writing these tests is what exposed the fact that a replay
/// and a carried-forward feed print both surfaced as `LazerCarriedForward` (12082): one code for two
/// events with two different fixes. With D2 making one-operation-per-print the steady state, the
/// replay is now the most likely refusal a real user meets, so it gets its own name.
const E_LAZER_REPLAYED: u32 = 12121;
/// `DominionError::LazerCarriedForward`, kept here so the pair can be asserted as DISTINCT.
const E_CARRIED_FORWARD: u32 = 12082;

/// Enough USDC for several mints at the launch floor, and enough SILV backing for the redeem half.
const USER_USDC: u64 = 1_000_000_000; // $1,000
const TREASURY_USDC: u64 = 1_000_000_000; // $1,000
/// Comfortably above `config.min_operation_usdc` ($10) so these tests are about the oracle and not
/// about the floor.
const MINT_AMOUNT: u64 = 100_000_000; // $100

/// An unpaused, initialized program with the public mint OPEN, a Lazer that executes, and a funded
/// user. Everything the priced path needs and nothing it does not.
fn priced() -> Fixture {
    let mut f = Fixture::new_bare();
    f.open_public_mint();
    f.install_mock_lazer();
    let holder = f.holder.insecure_clone();
    f.prepare_mint_accounts(&holder);
    f.fund_token_account(&f.usdc_mint.clone(), &holder.pubkey(), USER_USDC);
    f
}

#[test]
fn a_mint_persists_the_feed_timestamp_and_the_same_envelope_is_then_refused() {
    let mut f = priced();
    let holder = f.holder.insecure_clone();
    let ts = f.now_us();
    let envelope = lazer_payload(ts);

    // Precondition, asserted rather than assumed: nothing has consumed a print yet. Without this the
    // test would also pass against a program that rejected everything.
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        0,
        "a fresh config must start with an unset high-water mark"
    );

    expect_ok(
        f.mint_priced(&holder, MINT_AMOUNT, &envelope),
        "the first mint against a fresh print",
    );

    // THE WRITE. This is the assertion the lazer-harness test could not make, because the probe it
    // drives never writes. `mint_silv.rs:191` is the only line that can make this true.
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        ts,
        "mint_silv did not persist the feed timestamp it consumed"
    );

    // THE ENFORCEMENT, against the persisted value rather than a pre-seeded one.
    expect_error(
        f.mint_priced(&holder, MINT_AMOUNT, &envelope),
        E_LAZER_REPLAYED,
        "replaying the same envelope through mint_silv",
    );

    // And the mark did not move on the refused attempt: a reverted transaction rolls back, so this
    // also proves the refusal happened rather than the write being skipped.
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        ts,
        "the refused replay disturbed the high-water mark"
    );

    // A strictly newer print is accepted, which is what proves the refusal above is about the
    // equality and not about some unrelated breakage in the fixture.
    let newer = lazer_payload(ts + 1);
    expect_ok(
        f.mint_priced(&holder, MINT_AMOUNT, &newer),
        "a strictly newer print must still be mintable",
    );
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        ts + 1,
        "the second mint did not advance the mark"
    );
}

#[test]
fn a_redeem_persists_the_feed_timestamp_and_the_same_envelope_is_then_refused() {
    // The redeem half, separately, because it is a SEPARATE assignment in a separate file. A test
    // that only covered mint would stay green if `redeem_silv.rs:175` were deleted.
    let mut f = priced();
    let holder = f.holder.insecure_clone();

    // Acquire SILV to redeem, and back it: the payout comes out of the treasury ATA.
    let ts0 = f.now_us();
    expect_ok(
        f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts0)),
        "seed mint",
    );
    let silv = f.token_balance(&f.silv_mint.clone(), &holder.pubkey(), TOKEN_2022_PROGRAM);
    assert!(silv > 0, "the seed mint issued no SILV");
    f.fund_token_account(&f.usdc_mint.clone(), &treasury_pda(), TREASURY_USDC);

    // redemptions are open from `initialize`, so the 24h warp the old opener performed is
    // gone. The seed mint above CONSUMED the print at `ts0`, and `now_us` has microsecond resolution
    // over a second-resolution clock, so without advancing time `ts == ts0` and the redeem below
    // would fail on LazerReplayed rather than on the property under test. One second is the smallest
    // move that produces a strictly newer print.
    f.require_redemptions_open();
    f.warp(1);

    let ts = f.now_us();
    let envelope = lazer_payload(ts);
    assert!(
        f.config().last_used_feed_update_timestamp_us < ts,
        "fixture setup left the mark at or above the timestamp under test"
    );

    expect_ok(
        f.redeem_priced(&holder, silv / 2, &envelope),
        "the first redeem against a fresh print",
    );
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        ts,
        "redeem_silv did not persist the feed timestamp it consumed"
    );

    expect_error(
        f.redeem_priced(&holder, silv / 4, &envelope),
        E_LAZER_REPLAYED,
        "replaying the same envelope through redeem_silv",
    );
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        ts,
        "the refused replay disturbed the high-water mark"
    );
}

#[test]
fn both_sides_share_one_high_water_mark() {
    // The cross-side property, and the reason the two writes cannot be tested only in isolation: the
    // mark is ONE field in ONE shared config, so a mint consumes the print for redeem too. This is
    // also what makes the availability property global rather than per-instruction, and it
    // is what would break if either write were ever pointed at a per-side field.
    let mut f = priced();
    let holder = f.holder.insecure_clone();
    f.fund_token_account(&f.usdc_mint.clone(), &treasury_pda(), TREASURY_USDC);

    let ts0 = f.now_us();
    expect_ok(f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts0)), "seed mint");
    let silv = f.token_balance(&f.silv_mint.clone(), &holder.pubkey(), TOKEN_2022_PROGRAM);
    f.require_redemptions_open();
    // The seed mint consumed the print at `ts0`; a strictly newer one is a second away.
    f.warp(1);

    let ts = f.now_us();
    let envelope = lazer_payload(ts);
    expect_ok(
        f.mint_priced(&holder, MINT_AMOUNT, &envelope),
        "mint consumes the print",
    );
    // Same envelope, OTHER instruction. One print, one operation, whichever side takes it.
    expect_error(
        f.redeem_priced(&holder, silv / 2, &envelope),
        E_LAZER_REPLAYED,
        "redeem_silv reusing the print a mint already consumed",
    );
}

#[test]
fn a_replay_and_a_carried_forward_print_report_different_errors() {
    // the diagnosability half. Both of these are refusals on the priced path and they used
    // to be the SAME code, which meant a user who lost the race for a print was told the oracle had
    // carried a stale value. The two assertions below are the whole content of that fix: they fail if
    // `map_policy_err` ever collapses the pair again.
    let mut f = priced();
    let holder = f.holder.insecure_clone();
    let ts = f.now_us();

    // A genuine carried-forward print: the feed timestamp lags the payload timestamp. 5s of lag is
    // inside the 15s staleness ceiling, so this reaches the carried-forward check and not the stale one.
    expect_error(
        f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload_at(ts, ts - 5_000_000)),
        E_CARRIED_FORWARD,
        "a feed that republished a stale print",
    );

    // A replay: consume a print, then present it again.
    expect_ok(f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts)), "consume a print");
    expect_error(
        f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts)),
        E_LAZER_REPLAYED,
        "the same print a second time",
    );

    assert_ne!(
        E_CARRIED_FORWARD, E_LAZER_REPLAYED,
        "the two refusals must stay distinguishable to a client"
    );
}

#[test]
fn an_envelope_older_than_the_mark_is_refused_not_merely_an_equal_one() {
    // The `<=` half of D2 has two sides and only one of them is the interesting change. `fut < mark`
    // was already refused before the decision; `fut == mark` is what D2 added. Both are asserted so a
    // future edit cannot restore `<` and leave a test suite that only ever exercised the strict case.
    let mut f = priced();
    let holder = f.holder.insecure_clone();

    let ts = f.now_us();
    expect_ok(f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts)), "consume a print");
    assert_eq!(f.config().last_used_feed_update_timestamp_us, ts);

    expect_error(
        f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts - 1)),
        E_LAZER_REPLAYED,
        "an envelope strictly older than the mark",
    );
    expect_error(
        f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts)),
        E_LAZER_REPLAYED,
        "an envelope exactly at the mark, which is what D2 added",
    );
}

#[test]
fn the_redeem_side_has_the_same_floor_and_a_dust_redeem_cannot_capture_a_print() {
    // SECOND HALF. The floor applies on the mint side, and the check that
    // followed pointed out that the slot it protects is shared: `both_sides_share_one_high_water_mark`
    // above proves a print consumed by either handler is gone for the other. So a mint-only floor was
    // not a floor, and redeem was the cheaper door: at $58.34/oz, 1 atomic SILV is 58 micro-USDC gross
    // and returns 57 to the caller, a NET cost of about 1.3 micro-USDC per captured print.
    let mut f = priced();
    let holder = f.holder.insecure_clone();

    // Acquire SILV and back the treasury, then open redeem through the 24h timelocked path.
    let ts0 = f.now_us();
    expect_ok(f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts0)), "seed mint");
    let silv = f.token_balance(&f.silv_mint.clone(), &holder.pubkey(), TOKEN_2022_PROGRAM);
    f.fund_token_account(&f.usdc_mint.clone(), &treasury_pda(), TREASURY_USDC);
    f.require_redemptions_open();
    // The seed mint consumed the print at `ts0`; a strictly newer one is a second away.
    f.warp(1);

    let mark_before = f.config().last_used_feed_update_timestamp_us;
    let ts = f.now_us();

    // THE ATTACK, at the smallest amount that produces a non-zero payout.
    expect_error(
        f.redeem_priced(&holder, 1, &lazer_payload(ts)),
        E_OPERATION_BELOW_MINIMUM,
        "a 1-atomic-SILV redeem",
    );
    // And it did NOT consume the print: the whole transaction reverted, so the mark is untouched and
    // a legitimate operation on this same print still works. That is the property, not the error code.
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        mark_before,
        "the refused dust redeem consumed the print anyway"
    );

    // A redeem at the floor goes through, so the floor is a floor and not a wall.
    let at_floor = f.silv_for_usdc(DEFAULT_MIN_OPERATION_USDC);
    assert!(at_floor <= silv, "fixture did not mint enough SILV to redeem at the floor");
    expect_ok(
        f.redeem_priced(&holder, at_floor, &lazer_payload(ts)),
        "a redeem at the floor",
    );
    assert_eq!(
        f.config().last_used_feed_update_timestamp_us,
        ts,
        "the accepted redeem did not consume the print"
    );
}

#[test]
fn lowering_the_floor_to_zero_reopens_the_redeem_capture_too() {
    // The negative control for the test above: with the floor disabled, the dust redeem succeeds. If
    // this ever fails, the refusal above is coming from something other than the floor and the test
    // proves nothing about it.
    let mut f = priced();
    let holder = f.holder.insecure_clone();
    let ts0 = f.now_us();
    expect_ok(f.mint_priced(&holder, MINT_AMOUNT, &lazer_payload(ts0)), "seed mint");
    f.fund_token_account(&f.usdc_mint.clone(), &treasury_pda(), TREASURY_USDC);
    f.require_redemptions_open();
    f.set_min_operation_usdc(0);
    // The seed mint consumed the print at `ts0`; a strictly newer one is a second away.
    f.warp(1);

    let ts = f.now_us();
    expect_ok(
        f.redeem_priced(&holder, 1, &lazer_payload(ts)),
        "with the floor at zero, a 1-atomic-SILV redeem is accepted again",
    );
    assert_eq!(f.config().last_used_feed_update_timestamp_us, ts);
}
