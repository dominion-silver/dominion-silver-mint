//! Behavioral harness for the dominion Lazer oracle CPI path. See Cargo.toml.
//! Empty lib; all logic lives in the #[cfg(test)] harness below.

#[cfg(test)]
mod harness {
    use byteorder::{LittleEndian, WriteBytesExt};
    use litesvm::LiteSVM;
    use pyth_lazer_protocol::payload::{AggregatedPriceFeedData, PayloadData};
    use pyth_lazer_protocol::time::TimestampUs;
    use pyth_lazer_protocol::{ChannelId, Price, PriceFeedId, PriceFeedProperty};
    use sha2::{Digest, Sha256};
    use solana_sdk::account::Account;
    use solana_sdk::instruction::{AccountMeta, Instruction};
    use solana_sdk::pubkey::Pubkey;
    use solana_sdk::signature::{Keypair, Signer};
    use solana_sdk::transaction::Transaction;
    use std::io::Write;
    use std::str::FromStr;

    // the dominion program id used to be a hardcoded string here, and it
    // silently drifted on every fresh deploy (2ujQg -> AX7se -> gc5TW). Each drift
    // turned all 6 tests into Anchor Custom(4100) DeclaredProgramIdMismatch, which
    // reads as "the oracle path is broken" rather than "the harness is stale".
    // It is now parsed out of the program source that produced the .so we load, so
    // the two can no longer disagree. Change declare_id! and this follows.
    const DOMINION_SRC: &str =
        include_str!("../../../programs/dominion_silver_mint_v2/src/lib.rs");
    fn dominion_id() -> Pubkey {
        const NEEDLE: &str = "declare_id!(\"";
        let start = DOMINION_SRC
            .find(NEEDLE)
            .expect("declare_id! not found in the program source")
            + NEEDLE.len();
        let end = start
            + DOMINION_SRC[start..]
                .find('"')
                .expect("unterminated declare_id! literal");
        Pubkey::from_str(&DOMINION_SRC[start..end]).expect("declare_id! is not a valid pubkey")
    }

    // Pinned constants (must match the dominion source).
    const LAZER_PROGRAM_ID: &str = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
    const LAZER_STORAGE: &str = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";
    const LAZER_TREASURY: &str = "Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak";
    const CONFIG_SEED: &[u8] = b"config";
    const LAZER_FEE_PAYER_SEED: &[u8] = b"lazer_fee_payer";
    const STORAGE_FEE_OFFSET: usize = 72;
    const LAZER_FEE_CEILING: u64 = 10_000;
    const LAZER_CHANNEL_ID: u8 = 4;
    const SILV_FEED_ID: u32 = 3154; // Metal.Index.SILVER/USD (confirmed 2026-07-26)
    const PRICE_SCALE: i32 = 9;
    // Fixed wall clock for the harness (litesvm clock set to match), so feed
    // timestamps land inside the staleness window deterministically.
    const NOW_SECS: i64 = 1_700_000_000;
    const NOW_US: u64 = (NOW_SECS as u64) * 1_000_000;

    // Runtime DominionError codes (anchor base 6000 + 6000 offset = 12000-based).
    const E_FEE_TOO_HIGH: &str = "12074";
    const E_TOO_FEW_PUBLISHERS: &str = "12081";
    const E_CARRIED_FORWARD: &str = "12082";
    // Split out of E_CARRIED_FORWARD: a replayed envelope and a feed that republished a
    // stale print are different events with different fixes, and D2 made the first one the common
    // case. See the note on map_policy_err in src/oracle.rs.
    const E_LAZER_REPLAYED: &str = "12121";

    fn anchor_disc(preimage: &str) -> [u8; 8] {
        let mut h = Sha256::new();
        h.update(preimage.as_bytes());
        h.finalize()[..8].try_into().unwrap()
    }

    fn pk(s: &str) -> Pubkey {
        Pubkey::from_str(s).unwrap()
    }

    fn so_bytes(name: &str) -> Vec<u8> {
        // this used to read target/deploy, the
        // same path `solana program deploy` reads, and the harness needs a
        // `--features test-harness` build, so running it left a probe-contaminated
        // binary sitting at the deploy path. It now reads target/harness, which
        // run.sh populates, so the contamination class is gone at the root rather
        // than being mitigated by a warning. Use `tools/lazer-harness/run.sh`.
        // tools/lazer-harness -> repo root -> target/harness/<name>.so
        let path = format!("{}/../../target/harness/{}.so", env!("CARGO_MANIFEST_DIR"), name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e} (build it first)"))
    }

    // --- ConfigAccount crafting (sequential append in struct order) ----------
    // Only the oracle fields matter for the probe; the rest are zeroed/defaulted.
    struct OracleCfg {
        feed_id: u32,
        min_publishers: u16,
        last_used_feed_ts_us: u64,
        max_staleness_seconds: u32,
        max_confidence_bps: u16,
        min_price_scaled: u64,
        max_price_scaled: u64,
    }

    fn build_config_data(o: &OracleCfg) -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(&anchor_disc("account:ConfigAccount"));
        // Authorities
        b.extend_from_slice(&[0u8; 32]); // admin
        b.push(0); // pending_admin: Option<Pubkey> = None
        b.write_i64::<LittleEndian>(0).unwrap(); // pending_admin_expires_at
        b.extend_from_slice(&[0u8; 32]); // upgrade_authority_info
        // Compliance
        b.extend_from_slice(&[0u8; 32]); // permanent_delegate_expected
        // freeze_authority_expected was MISSING here, which shifted every
        // subsequent field by 32 bytes and made the whole account mis-decode.
        b.extend_from_slice(&[0u8; 32]); // freeze_authority_expected
        b.push(0); // compliance_mode
        // Premium
        b.write_u16::<LittleEndian>(0).unwrap(); // premium_bps_mint
        b.write_u16::<LittleEndian>(0).unwrap(); // premium_bps_redeem
        // Oracle (SET)
        b.write_u32::<LittleEndian>(o.feed_id).unwrap();
        b.write_u16::<LittleEndian>(o.min_publishers).unwrap();
        b.write_u64::<LittleEndian>(o.last_used_feed_ts_us).unwrap();
        // Token program ids
        for _ in 0..5 {
            b.extend_from_slice(&[0u8; 32]);
        }
        // Oracle guards (SET)
        b.write_u32::<LittleEndian>(o.max_staleness_seconds).unwrap();
        b.write_u16::<LittleEndian>(o.max_confidence_bps).unwrap();
        b.write_u64::<LittleEndian>(o.min_price_scaled).unwrap();
        b.write_u64::<LittleEndian>(o.max_price_scaled).unwrap();
        // Price-delta breaker
        b.extend_from_slice(&[0u8; 16]); // last_recorded_price_scaled: u128
        b.write_i64::<LittleEndian>(0).unwrap(); // last_price_update_at
        b.write_u16::<LittleEndian>(0).unwrap(); // max_price_delta_bps
        b.write_u32::<LittleEndian>(0).unwrap(); // price_delta_decay_seconds
        b.write_u64::<LittleEndian>(0).unwrap(); // price_update_min_amount_usdc
        // Option B economic
        b.write_u64::<LittleEndian>(0).unwrap(); // max_silv_supply
        b.write_u64::<LittleEndian>(0).unwrap(); // treasury_min_float_usdc
        b.push(0); // redemptions_enabled
        b.write_u64::<LittleEndian>(0).unwrap(); // large_redeem_threshold_usdc
        b.write_u64::<LittleEndian>(0).unwrap(); // instant_redeem_budget_usdc
        b.write_u32::<LittleEndian>(0).unwrap(); // instant_redeem_window_seconds
        b.write_u32::<LittleEndian>(0).unwrap(); // redeem_queue_delay_seconds
        b.write_i64::<LittleEndian>(0).unwrap(); // instant_window_start
        b.write_u64::<LittleEndian>(0).unwrap(); // instant_used_usdc
        b.write_u64::<LittleEndian>(0).unwrap(); // next_redeem_request_nonce
        b.write_u32::<LittleEndian>(0).unwrap(); // admin_timelock_seconds
        b.push(0); // max_guardian_count
        b.push(0); // guardian_count
        b.write_i64::<LittleEndian>(0).unwrap(); // mint_paused_until
        b.push(0); // paused
        b.write_u64::<LittleEndian>(0).unwrap(); // next_timelock_nonce
        b.push(0); // active_proposal_count
        for _ in 0..9 {
            b.push(0); // 9 Option<u64> nonces = None
        }
        // every launch-spec 2026-07 field below was MISSING, leaving the
        // buffer 149 bytes short of the layout the program deserializes. Keep this
        // block in the same order as ConfigAccount in state/config.rs.
        b.write_i64::<LittleEndian>(0).unwrap(); // pending_admin_eta
        b.push(0); // pending_max_supply_nonce: Option<u64> = None
        b.push(0); // pending_redeem_limits_nonce: Option<u64> = None
        b.extend_from_slice(&[0u8; 32]); // inventory_wallet
        b.push(0); // public_mint_enabled
        b.extend_from_slice(&[0u8; 32]); // kyc_operator
        b.push(0); // kyc_enforced
        b.push(0); // pending_kyc_operator_nonce: Option<u64> = None
        b.extend_from_slice(&[0u8; 32]); // por_feed
        b.write_u32::<LittleEndian>(0).unwrap(); // por_max_staleness_seconds
        b.push(0); // por_enforced
        b.push(0); // pending_por_feed_nonce: Option<u64> = None
        b.push(0); // mint_paused
        b.push(0); // redeem_paused
        // THIS TAIL WAS WRONG, and had been since `pending_removal_count` was
        // added. It wrote `version` where the program reads `pending_removal_count`, then 64 bytes of
        // "reserved" in place of the real 55-byte tail, so every field after `redeem_paused` was
        // shifted by one byte and eight bytes too long. It never surfaced because Anchor ignores
        // trailing bytes and every affected field is zero here, and because the probe reads none of
        // them. The next field carved out of `reserved` BEFORE the oracle block would have shifted
        // feed_id / min_publishers / last_used_feed_ts_us and left the whole Lazer suite green while
        // testing a mis-decoded config.
        b.push(0); // pending_removal_count
        b.push(0); // version
        b.push(0); // pending_public_mint_nonce: Option<u64> = None
        b.push(0); // kyc_scope_flags
        b.write_u64::<LittleEndian>(0).unwrap(); // instant_used_prev_usdc
        b.push(0); // fee_routing_disabled
        b.write_u32::<LittleEndian>(0).unwrap(); // kyc_attestation_count
        b.write_u64::<LittleEndian>(0).unwrap(); // min_operation_usdc
        b.extend_from_slice(&[0u8; 32]); // reserved

        // Drift guard, with the arithmetic corrected. ConfigAccount::SIZE is 800, but that is the
        // ALLOCATED budget: it reserves 1+8 for every Option<u64> and 1+32 for the Option<Pubkey>,
        // while a `None` serializes to a single byte. There are FOURTEEN Option<u64> fields, not the
        // thirteen the old comment counted, so the serialized length with every Option = None is
        // 800 - 14*8 - 32 = 656.
        // WHAT THIS ASSERT DOES AND DOES NOT DO, stated because the old comment overclaimed: it
        // measures THIS FUNCTION'S OUTPUT against a number a human derived. It never consults the
        // program, so it does not "fail loudly if the program layout changes" the way the old comment
        // said. What catches a real layout change is the state harness, which builds its config
        // through the REAL `initialize` and decodes it with a mirror that re-serializes byte-exactly.
        // This assert catches an editing mistake in the block above, which is worth having and is a
        // smaller claim.
        assert_eq!(
            b.len(),
            656,
            "hand-built ConfigAccount buffer is out of sync with state/config.rs \
             (expected 656 serialized bytes with every Option = None)"
        );
        b
    }

    fn build_storage_data(fee: u64) -> Vec<u8> {
        let mut d = vec![0u8; STORAGE_FEE_OFFSET + 8 + 8];
        // treasury at offset 8 (disc) + 32 (top_authority) = 40; the contract's
        // read_treasury validates the passed treasury account against this, so it
        // MUST equal the treasury the harness passes to the CPI (LAZER_TREASURY).
        d[40..72].copy_from_slice(&pk(LAZER_TREASURY).to_bytes());
        (&mut d[STORAGE_FEE_OFFSET..STORAGE_FEE_OFFSET + 8])
            .write_u64::<LittleEndian>(fee)
            .unwrap();
        d
    }

    // Build a canonical Lazer PayloadData and return its LE serialization (this
    // is the message_data the mock echoes back as the verified payload).
    #[allow(clippy::too_many_arguments)]
    fn build_payload(
        global_ts_us: u64,
        feed_ts_us: u64,
        price: i64,
        confidence: i64,
        publisher_count: u16,
        exponent: i16,
    ) -> Vec<u8> {
        let mut agg = AggregatedPriceFeedData::empty(
            exponent,
            pyth_lazer_protocol::api::MarketSession::Regular,
            TimestampUs::from_micros(feed_ts_us),
        );
        agg.price = Some(Price::from_mantissa(price).unwrap());
        agg.confidence = Some(Price::from_mantissa(confidence).unwrap());
        agg.publisher_count = publisher_count;
        let payload = PayloadData::new(
            TimestampUs::from_micros(global_ts_us),
            ChannelId(LAZER_CHANNEL_ID),
            &[(PriceFeedId(SILV_FEED_ID), agg)],
            &[
                PriceFeedProperty::Price,
                PriceFeedProperty::PublisherCount,
                PriceFeedProperty::Exponent,
                PriceFeedProperty::Confidence,
                PriceFeedProperty::FeedUpdateTimestamp,
            ],
        );
        let mut buf = Vec::new();
        payload.serialize::<LittleEndian>(&mut buf).unwrap();
        buf
    }

    fn probe_ix_data(message_data: &[u8]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&anchor_disc("global:probe_oracle_price"));
        d.write_u32::<LittleEndian>(message_data.len() as u32).unwrap();
        d.write_all(message_data).unwrap();
        d.write_u16::<LittleEndian>(0).unwrap(); // ed25519_instruction_index (mock ignores)
        d.push(0); // signature_index (mock ignores)
        d
    }

    struct Env {
        svm: LiteSVM,
        funder: Keypair,
        config_pda: Pubkey,
        fee_payer_pda: Pubkey,
    }

    fn setup(o: &OracleCfg, fee: u64) -> Env {
        let dominion = dominion_id();
        let lazer = pk(LAZER_PROGRAM_ID);
        let mut svm = LiteSVM::new();
        // Pin the clock so staleness/future checks are deterministic.
        let mut clock: solana_sdk::clock::Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW_SECS;
        svm.set_sysvar(&clock);
        svm.add_program(dominion, &so_bytes("dominion_silver_mint")).unwrap();
        svm.add_program(lazer, &so_bytes("mock_lazer")).unwrap();

        let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], &dominion);
        let (fee_payer_pda, _) = Pubkey::find_program_address(&[LAZER_FEE_PAYER_SEED], &dominion);

        let own_account = |owner: Pubkey, data: Vec<u8>, lamports: u64| Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        };
        svm.set_account(config_pda, own_account(dominion, build_config_data(o), 5_000_000))
            .unwrap();
        svm.set_account(pk(LAZER_STORAGE), own_account(lazer, build_storage_data(fee), 5_000_000))
            .unwrap();
        // Treasury: a System-owned account that receives the drained fee.
        svm.set_account(pk(LAZER_TREASURY), own_account(solana_sdk::system_program::ID, vec![], 5_000_000))
            .unwrap();

        let funder = Keypair::new();
        svm.airdrop(&funder.pubkey(), 1_000_000_000).unwrap();
        Env { svm, funder, config_pda, fee_payer_pda }
    }

    fn run_probe(env: &mut Env, message_data: &[u8]) -> Result<Vec<u8>, String> {
        let dominion = dominion_id();
        let ix = Instruction {
            program_id: dominion,
            accounts: vec![
                AccountMeta::new_readonly(env.config_pda, false),
                AccountMeta::new(env.funder.pubkey(), true),
                AccountMeta::new_readonly(pk(LAZER_PROGRAM_ID), false),
                AccountMeta::new_readonly(pk(LAZER_STORAGE), false),
                AccountMeta::new(pk(LAZER_TREASURY), false),
                AccountMeta::new(env.fee_payer_pda, false),
                AccountMeta::new_readonly(solana_sdk::sysvar::instructions::ID, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: probe_ix_data(message_data),
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&env.funder.pubkey()),
            &[&env.funder],
            env.svm.latest_blockhash(),
        );
        match env.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.return_data.data),
            Err(e) => Err(format!("{:?}", e.err)),
        }
    }

    fn default_oracle() -> OracleCfg {
        OracleCfg {
            feed_id: SILV_FEED_ID,
            min_publishers: 2,
            last_used_feed_ts_us: 0,
            max_staleness_seconds: 30,
            max_confidence_bps: 500,
            min_price_scaled: 5_000_000_000,    // $5
            max_price_scaled: 200_000_000_000,  // $200
        }
    }

    // expected normalized price = price_mantissa * 10^(PRICE_SCALE + exponent)
    fn expected_normalized(price: i64, exponent: i16) -> u128 {
        let e = PRICE_SCALE + exponent as i32;
        if e >= 0 {
            (price as u128) * 10u128.pow(e as u32)
        } else {
            (price as u128) / 10u128.pow((-e) as u32)
        }
    }

    fn treasury_lamports(env: &Env) -> u64 {
        env.svm.get_account(&pk(LAZER_TREASURY)).map(|a| a.lamports).unwrap_or(0)
    }

    // A fresh, in-band SILV print (feed ts == payload ts == now): the accepted
    // happy case used by most scenarios.
    fn fresh_payload(price: i64, conf: i64, publishers: u16) -> Vec<u8> {
        build_payload(NOW_US, NOW_US, price, conf, publishers, -5)
    }

    #[test]
    fn an_envelope_at_or_below_the_stored_mark_is_refused_by_the_policy() {
        // RENAMED in because the old name was `the_same_envelope_cannot_be_consumed_twice`
        // and that is NOT what this test does. It pre-writes the high-water mark into a crafted
        // config and calls the probe ONCE. `probe_oracle_price` is read-only by construction, so this
        // exercises the COMPARISON in lazer_price.rs and never the WRITE. The two writes live in
        // mint_silv.rs and redeem_silv.rs, and deleting either left this test green while the
        // matching path was replayable: the minimum-operation floor.
        // The persistence half now lives in tools/state-harness/tests/oracle_replay.rs, which drives
        // real mints and redeems through the mock Lazer and reads the field back off the chain. Both
        // writes were mutation-verified against it. This test keeps its narrower, honest job.
        // is what made the comparison strict: `fut <` became `fut <=`, so one signed
        // envelope prices exactly ONE operation.
        let ts = NOW_US;

        // Already consumed: the config high-water mark is exactly this envelope's timestamp.
        let mut consumed = default_oracle();
        consumed.last_used_feed_ts_us = ts;
        let mut env = setup(&consumed, 1);
        let err = run_probe(&mut env, &fresh_payload(5_834_000, 100, 3))
            .expect_err("replaying a consumed envelope must be refused");
        // The EXACT code. The old assertion was `contains("NonMonotonic") || contains("Custom")`, and
        // the second half made it pass on ANY custom program error: a fixture that broke for an
        // unrelated reason would have been read as the anti-replay working.
        assert!(
            err.contains(E_LAZER_REPLAYED),
            "expected DominionError::LazerReplayed ({E_LAZER_REPLAYED}), got {err}"
        );

        // One microsecond newer than the mark: accepted. This is what proves the refusal above is about
        // the equality and not about some unrelated failure in the fixture.
        let mut not_yet = default_oracle();
        not_yet.last_used_feed_ts_us = ts - 1;
        let mut env2 = setup(&not_yet, 1);
        run_probe(&mut env2, &fresh_payload(5_834_000, 100, 3))
            .expect("a strictly newer envelope must be accepted");
    }

    #[test]
    fn happy_path_price_flows_and_fee_isolated() {
        let mut env = setup(&default_oracle(), 1);
        let treas_before = treasury_lamports(&env);
        // SILV ~ $28.00123 at exponent -5 -> mantissa 2_800_123.
        let payload = fresh_payload(2_800_123, 1_500, 9);
        let ret = run_probe(&mut env, &payload).expect("probe ok");
        assert_eq!(ret.len(), 24);
        let price = u128::from_le_bytes(ret[0..16].try_into().unwrap());
        let fut = u64::from_le_bytes(ret[16..24].try_into().unwrap());
        assert_eq!(price, expected_normalized(2_800_123, -5)); // 28.00123 * 1e9
        assert_eq!(fut, NOW_US);
        // Fee isolation: the mock drained EXACTLY the funded fee (1 lamport) to
        // the treasury - the funder (not in the CPI) could not lose more.
        assert_eq!(treasury_lamports(&env) - treas_before, 1);
        // The fee-payer PDA ends drained.
        assert_eq!(env.svm.get_account(&env.fee_payer_pda).map(|a| a.lamports).unwrap_or(0), 0);
    }

    #[test]
    fn carried_forward_is_rejected() {
        let mut env = setup(&default_oracle(), 1);
        // feed_update_timestamp (5s older) != payload timestamp -> carried-forward.
        let payload = build_payload(NOW_US, NOW_US - 5_000_000, 2_800_000, 1_500, 9, -5);
        let err = run_probe(&mut env, &payload).expect_err("must reject carried-forward");
        assert!(err.contains(E_CARRIED_FORWARD), "got: {err}");
    }

    #[test]
    fn fee_zero_still_works() {
        let mut env = setup(&default_oracle(), 0);
        let treas_before = treasury_lamports(&env);
        let ret = run_probe(&mut env, &fresh_payload(2_800_000, 1_500, 9)).expect("probe ok fee=0");
        assert_eq!(ret.len(), 24);
        assert_eq!(treasury_lamports(&env) - treas_before, 0); // nothing transferred
    }

    #[test]
    fn fee_ceiling_works_and_is_isolated() {
        let mut env = setup(&default_oracle(), LAZER_FEE_CEILING);
        let treas_before = treasury_lamports(&env);
        run_probe(&mut env, &fresh_payload(2_800_000, 1_500, 9)).expect("probe ok at ceiling");
        assert_eq!(treasury_lamports(&env) - treas_before, LAZER_FEE_CEILING);
    }

    #[test]
    fn fee_above_ceiling_is_rejected() {
        let mut env = setup(&default_oracle(), LAZER_FEE_CEILING + 1);
        let err = run_probe(&mut env, &fresh_payload(2_800_000, 1_500, 9))
            .expect_err("must reject fee > ceiling");
        assert!(err.contains(E_FEE_TOO_HIGH), "got: {err}");
    }

    #[test]
    fn too_few_publishers_is_rejected() {
        let mut env = setup(&default_oracle(), 1); // min_publishers = 2
        let err = run_probe(&mut env, &fresh_payload(2_800_000, 1_500, 1)) // only 1 publisher
            .expect_err("must reject < min publishers");
        assert!(err.contains(E_TOO_FEW_PUBLISHERS), "got: {err}");
    }
}
