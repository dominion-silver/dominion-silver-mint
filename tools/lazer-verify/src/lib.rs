// Host-only verification crate. See Cargo.toml. The dominion parser is
// dependency-free, so we include it directly by path (no anchor/SBF deps) and
// run it against the canonical pyth-lazer-protocol 0.34.0 wire format.

#[path = "../../../programs/dominion_silver_mint_v2/src/lazer.rs"]
mod dominion_lazer;

// ---------------------------------------------------------------------------
// 1. DIFFERENTIAL: build a payload with the canonical SDK exactly as the Lazer
//    publisher would, then assert the dominion hand-rolled parser extracts the
//    same values byte-for-byte. Closes (parser was human-verified only).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod differential {
    use super::dominion_lazer::{extract_feed_price, LazerError};
    use byteorder::LittleEndian;
    use pyth_lazer_protocol::api::MarketSession;
    use pyth_lazer_protocol::payload::{AggregatedPriceFeedData, PayloadData};
    use pyth_lazer_protocol::time::TimestampUs;
    use pyth_lazer_protocol::{ChannelId, Price, PriceFeedId, PriceFeedProperty};

    struct FeedSpec {
        feed_id: u32,
        price: i64,
        confidence: Option<i64>,
        publisher_count: u16,
        exponent: i16,
        feed_ts_us: u64,
    }

    // A realistic Lazer property set in tag order. The parser must read the 5
    // it needs (Price/PublisherCount/Exponent/Confidence/FeedUpdateTimestamp)
    // and SKIP BestBid/BestAsk/Ema.
    fn realistic_props() -> Vec<PriceFeedProperty> {
        vec![
            PriceFeedProperty::Price,
            PriceFeedProperty::BestBidPrice,
            PriceFeedProperty::BestAskPrice,
            PriceFeedProperty::PublisherCount,
            PriceFeedProperty::Exponent,
            PriceFeedProperty::Confidence,
            PriceFeedProperty::EmaPrice,
            PriceFeedProperty::FeedUpdateTimestamp,
        ]
    }

    fn agg(spec: &FeedSpec) -> AggregatedPriceFeedData {
        let mut a = AggregatedPriceFeedData::empty(
            spec.exponent,
            MarketSession::Regular,
            TimestampUs::from_micros(spec.feed_ts_us),
        );
        a.price = Some(Price::from_mantissa(spec.price).unwrap());
        // Fixed nonzero skipped-property values (their content is irrelevant;
        // the parser must step over them by their wire size).
        a.best_bid_price = Some(Price::from_mantissa(1).unwrap());
        a.best_ask_price = Some(Price::from_mantissa(2).unwrap());
        a.ema_price = Some(Price::from_mantissa(3).unwrap());
        a.confidence = spec.confidence.map(|c| Price::from_mantissa(c).unwrap());
        a.publisher_count = spec.publisher_count;
        a
    }

    fn sdk_payload(global_ts_us: u64, channel: ChannelId, feeds: &[FeedSpec]) -> Vec<u8> {
        let entries: Vec<_> = feeds
            .iter()
            .map(|s| (PriceFeedId(s.feed_id), agg(s)))
            .collect();
        let payload = PayloadData::new(
            TimestampUs::from_micros(global_ts_us),
            channel,
            &entries,
            &realistic_props(),
        );
        let mut buf = Vec::new();
        payload
            .serialize::<LittleEndian>(&mut buf)
            .expect("sdk serialize");
        buf
    }

    #[test]
    fn parser_matches_sdk_single_feed() {
        let spec = FeedSpec {
            feed_id: 3304,
            price: 2_800_123,
            confidence: Some(1_500),
            publisher_count: 9,
            exponent: -5,
            feed_ts_us: 1_700_000_000_500_000,
        };
        let buf = sdk_payload(1_700_000_000_999_000, ChannelId::FIXED_RATE_1000, &[spec]);

        let lp = extract_feed_price(&buf, 3304, 4).expect("dominion parse");
        assert_eq!(lp.price, 2_800_123);
        assert_eq!(lp.exponent, -5);
        assert_eq!(lp.confidence, Some(1_500));
        assert_eq!(lp.publisher_count, 9);
        assert_eq!(lp.feed_update_timestamp_us, 1_700_000_000_500_000);
        assert_eq!(lp.timestamp_us, 1_700_000_000_999_000);
        assert_eq!(lp.channel_id, 4);

        // Sanity: the SDK round-trips the exact same bytes we fed the parser.
        let sdk = PayloadData::deserialize_slice_le(&buf).expect("sdk parse");
        assert_eq!(sdk.channel_id, ChannelId::FIXED_RATE_1000);
        assert_eq!(sdk.timestamp_us.as_micros(), 1_700_000_000_999_000);
        assert_eq!(sdk.feeds.len(), 1);
    }

    #[test]
    fn parser_picks_target_among_many_feeds() {
        let feeds = vec![
            FeedSpec { feed_id: 9999, price: 11, confidence: Some(1), publisher_count: 1, exponent: -2, feed_ts_us: 5 },
            FeedSpec { feed_id: 3304, price: 2_800_000, confidence: Some(2_000), publisher_count: 12, exponent: -5, feed_ts_us: 1_000_000 },
            FeedSpec { feed_id: 1111, price: 77, confidence: None, publisher_count: 3, exponent: -1, feed_ts_us: 9 },
        ];
        let buf = sdk_payload(2_000_000, ChannelId::FIXED_RATE_1000, &feeds);
        let lp = extract_feed_price(&buf, 3304, 4).expect("parse");
        assert_eq!(lp.price, 2_800_000);
        assert_eq!(lp.publisher_count, 12);
        assert_eq!(lp.exponent, -5);
        assert_eq!(lp.confidence, Some(2_000));
        assert_eq!(lp.feed_update_timestamp_us, 1_000_000);
    }

    #[test]
    fn confidence_zero_sentinel_is_none() {
        let spec = FeedSpec { feed_id: 3304, price: 2_800_000, confidence: None, publisher_count: 5, exponent: -5, feed_ts_us: 100 };
        let buf = sdk_payload(200, ChannelId::FIXED_RATE_1000, &[spec]);
        let lp = extract_feed_price(&buf, 3304, 4).expect("parse");
        assert_eq!(lp.confidence, None);
    }

    #[test]
    fn negative_price_mantissa_preserved() {
        let spec = FeedSpec { feed_id: 3304, price: -42, confidence: Some(3), publisher_count: 2, exponent: -5, feed_ts_us: 100 };
        let buf = sdk_payload(200, ChannelId::FIXED_RATE_1000, &[spec]);
        let lp = extract_feed_price(&buf, 3304, 4).expect("parse");
        assert_eq!(lp.price, -42);
    }

    #[test]
    fn feed_not_found_is_error() {
        let spec = FeedSpec { feed_id: 3304, price: 1, confidence: Some(1), publisher_count: 1, exponent: -5, feed_ts_us: 1 };
        let buf = sdk_payload(2, ChannelId::FIXED_RATE_1000, &[spec]);
        assert!(matches!(
            extract_feed_price(&buf, 7777, 4),
            Err(LazerError::FeedNotFound)
        ));
    }

    #[test]
    fn wrong_channel_is_error() {
        let spec = FeedSpec { feed_id: 3304, price: 1, confidence: Some(1), publisher_count: 1, exponent: -5, feed_ts_us: 1 };
        // Channel 3 (FIXED_RATE_200) on the wire, parser expects 4.
        let buf = sdk_payload(2, ChannelId::FIXED_RATE_200, &[spec]);
        assert!(matches!(
            extract_feed_price(&buf, 3304, 4),
            Err(LazerError::WrongChannel)
        ));
    }
}

// ---------------------------------------------------------------------------
// 2. DISCRIMINATOR: re-derive the verify_message anchor discriminator from the
//    sha256 formula and assert the lazer_cpi.rs source constant carries it.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod discriminator {
    use sha2::{Digest, Sha256};

    const SOURCE: &str =
        include_str!("../../../programs/dominion_silver_mint_v2/src/lazer_cpi.rs");

    #[test]
    fn verify_message_discriminator_matches_formula_and_source() {
        // Anchor 0.31 instruction discriminator = sha256("global:<ix_name>")[..8].
        let mut h = Sha256::new();
        h.update(b"global:verify_message");
        let derived: [u8; 8] = h.finalize()[..8].try_into().unwrap();
        assert_eq!(
            derived,
            [180, 193, 120, 55, 189, 135, 203, 83],
            "sha256(global:verify_message)[..8] formula no longer yields the pinned bytes"
        );
        // Tie it to the actual source constant so a future edit to lazer_cpi.rs
        // is caught here.
        assert!(
            SOURCE.contains("[180, 193, 120, 55, 189, 135, 203, 83]"),
            "lazer_cpi.rs VERIFY_MESSAGE_DISCRIMINATOR no longer matches the derived discriminator"
        );
    }
}
