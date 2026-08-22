// Pyth Lazer (Pyth Pro) payload parsing, dependency-free: the official
// `pyth-lazer-protocol` crate pulls an off-chain dependency tree that does not
// build under `cargo-build-sbf`. Transcribed field-by-field from that crate at
// 0.34.0, the version the deployed `pyth-lazer-solana-contract` 0.8.0 locks. A
// host-only differential test pins `=0.34.0` and diffs this parser against the
// upstream deserializer.
// Wire format is LITTLE ENDIAN. Price-like i64 properties use 0 as the None
// sentinel. FundingRate, FundingTimestamp, FundingRateInterval and
// FeedUpdateTimestamp carry a u8 present flag before their value. The full
// field-by-field layout is asserted by the Lazer harness under tools/.

// Trust (the signer is a Lazer trusted signer) is enforced by the Lazer
// `verify_message` CPI, never here: this module only parses an already-verified
// payload. It still bounds-checks every read, asserts the magic, rejects
// duplicate feeds and properties, requires the whole payload be consumed, and
// fails closed on any malformed shape.

// Policy split: the parser returns raw values and does not editorialize. Price
// sign, carried-forward detection (feed_update_timestamp_us vs timestamp_us),
// confidence positivity, the publisher floor and staleness are all oracle.rs
// gates, so the security policy lives in one place.

// Magic constants (LE), mirrored from the protocol crate.
pub const SOLANA_FORMAT_MAGIC: u32 = 2_182_742_457;
pub const PAYLOAD_FORMAT_MAGIC: u32 = 2_479_346_549;

// PriceFeedProperty repr (declaration order in the protocol enum, #[repr(u8)]).
const PROP_PRICE: u8 = 0;
const PROP_BEST_BID_PRICE: u8 = 1;
const PROP_BEST_ASK_PRICE: u8 = 2;
const PROP_PUBLISHER_COUNT: u8 = 3;
const PROP_EXPONENT: u8 = 4;
const PROP_CONFIDENCE: u8 = 5;
const PROP_FUNDING_RATE: u8 = 6;
const PROP_FUNDING_TIMESTAMP: u8 = 7;
const PROP_FUNDING_RATE_INTERVAL: u8 = 8;
const PROP_MARKET_SESSION: u8 = 9;
const PROP_EMA_PRICE: u8 = 10;
const PROP_EMA_CONFIDENCE: u8 = 11;
const PROP_FEED_UPDATE_TIMESTAMP: u8 = 12;
const MAX_KNOWN_PROP: u8 = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LazerError {
    /// Buffer ended mid-read (truncated / short message).
    UnexpectedEof,
    /// Envelope or payload magic did not match the expected constant.
    BadMagic,
    /// A property tag we do not recognize (unknown length -> cannot skip safely).
    UnknownProperty,
    /// The payload channel_id did not match the expected (subscribed) channel.
    WrongChannel,
    /// The target feed id appeared more than once in the payload.
    DuplicateFeed,
    /// A property tag appeared more than once within a single feed.
    DuplicateProperty,
    /// Bytes remained after the declared feeds were consumed.
    TrailingBytes,
    /// The requested feed id was not present in the payload.
    FeedNotFound,
    /// The target feed had no usable Price (property absent or 0 == None sentinel).
    MissingPrice,
    /// The target feed had no Exponent property.
    MissingExponent,
    /// The target feed had no PublisherCount property.
    MissingPublisherCount,
    /// The target feed had no Confidence property at all (subscription drift).
    MissingConfidence,
    /// The target feed had no FeedUpdateTimestamp, or its inner value was absent.
    MissingFeedUpdateTimestamp,
    /// The payload exceeds the defensive size cap.
    PayloadTooLarge,
}

/// Defensive cap on the inner payload size, in bytes. Loose: the real ceiling
/// is Solana's 1024 B return-data limit and the SILV payload is ~50 B. `pub` so
/// the parser is bounded independently of its caller.
pub const MAX_PAYLOAD: usize = 4096;

/// One feed's verified, extracted data. Raw values: oracle.rs applies the
/// security policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LazerPrice {
    /// Price mantissa (value = price * 10^exponent). Never 0 here (0 is the
    /// None sentinel). May be negative; the oracle rejects price <= 0.
    pub price: i64,
    /// Per-feed exponent (typically negative, e.g. -5 for SILV).
    pub exponent: i16,
    /// Confidence mantissa, None when the feed emitted 0. The property itself
    /// is required to be present.
    pub confidence: Option<i64>,
    /// Publishers in THIS aggregate. Meaningful only on a fresh (non-carried)
    /// print.
    pub publisher_count: u16,
    /// Per-feed update time in MICROSECONDS. The oracle requires this to equal
    /// `timestamp_us` (rejecting a carried-forward print) and ages it.
    pub feed_update_timestamp_us: u64,
    /// Channel id from the payload (already checked == expected).
    pub channel_id: u8,
    /// Payload-level aggregate timestamp in MICROSECONDS.
    pub timestamp_us: u64,
}

/// Minimal bounds-checked little-endian cursor over a byte slice.
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], LazerError> {
        let end = self.pos.checked_add(n).ok_or(LazerError::UnexpectedEof)?;
        if end > self.data.len() {
            return Err(LazerError::UnexpectedEof);
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, LazerError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, LazerError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn i16(&mut self) -> Result<i16, LazerError> {
        Ok(self.u16()? as i16)
    }

    fn u32(&mut self) -> Result<u32, LazerError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&mut self) -> Result<u64, LazerError> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_le_bytes(a))
    }

    fn i64(&mut self) -> Result<i64, LazerError> {
        Ok(self.u64()? as i64)
    }

    fn at_end(&self) -> bool {
        self.pos == self.data.len()
    }
}

/// Per-target accumulator while scanning the payload.
#[derive(Default)]
struct Target {
    price: Option<i64>, // raw (0 allowed here; mapped to MissingPrice later)
    confidence_seen: bool,
    confidence: Option<i64>, // 0 -> None
    exponent: Option<i16>,
    publisher_count: Option<u16>,
    feed_update_us: Option<u64>, // inner-resolved (None if present-flag was 0)
}

/// Consume ONE property at the cursor, capturing into `t` when `is_target`.
fn consume_property(
    r: &mut Reader,
    tag: u8,
    is_target: bool,
    t: &mut Target,
) -> Result<(), LazerError> {
    match tag {
        PROP_PRICE => {
            let v = r.i64()?;
            if is_target {
                t.price = Some(v);
            }
        }
        PROP_CONFIDENCE => {
            let v = r.i64()?;
            if is_target {
                t.confidence_seen = true;
                t.confidence = if v == 0 { None } else { Some(v) };
            }
        }
        PROP_BEST_BID_PRICE | PROP_BEST_ASK_PRICE | PROP_EMA_PRICE | PROP_EMA_CONFIDENCE => {
            let _ = r.i64()?; // Option<Price> we do not need
        }
        PROP_PUBLISHER_COUNT => {
            let v = r.u16()?;
            if is_target {
                t.publisher_count = Some(v);
            }
        }
        PROP_EXPONENT => {
            let v = r.i16()?;
            if is_target {
                t.exponent = Some(v);
            }
        }
        PROP_MARKET_SESSION => {
            let _ = r.i16()?;
        }
        PROP_FUNDING_RATE => {
            if r.u8()? != 0 {
                let _ = r.i64()?;
            }
        }
        PROP_FUNDING_TIMESTAMP | PROP_FUNDING_RATE_INTERVAL => {
            if r.u8()? != 0 {
                let _ = r.u64()?;
            }
        }
        PROP_FEED_UPDATE_TIMESTAMP => {
            let present = r.u8()? != 0;
            let v = if present { Some(r.u64()?) } else { None };
            if is_target {
                t.feed_update_us = v;
            }
        }
        // Unknown tag means unknown length, so the cursor cannot skip it
        // safely: fail closed. If the subscribed property set gains a property,
        // this module must be updated in lockstep.
        _ => return Err(LazerError::UnknownProperty),
    }
    Ok(())
}

/// Parse a VERIFIED Lazer payload and extract `target_feed_id`'s data.
/// `payload` must be the inner payload (`VerifiedMessage.payload` returned by
/// the Lazer `verify_message` CPI), NOT the SolanaMessage envelope.
/// `expected_channel` is the subscribed channel (fixed_rate@1000ms == 4).
pub fn extract_feed_price(
    payload: &[u8],
    target_feed_id: u32,
    expected_channel: u8,
) -> Result<LazerPrice, LazerError> {
    if payload.len() > MAX_PAYLOAD {
        return Err(LazerError::PayloadTooLarge);
    }
    let mut r = Reader::new(payload);
    if r.u32()? != PAYLOAD_FORMAT_MAGIC {
        return Err(LazerError::BadMagic);
    }
    let timestamp_us = r.u64()?;
    let channel_id = r.u8()?;
    if channel_id != expected_channel {
        return Err(LazerError::WrongChannel);
    }
    let num_feeds = r.u8()?;

    let mut found: Option<Target> = None;

    for _ in 0..num_feeds {
        let feed_id = r.u32()?;
        let num_properties = r.u8()?;
        let is_target = feed_id == target_feed_id;
        let mut seen: u16 = 0;
        let mut t = Target::default();

        for _ in 0..num_properties {
            let tag = r.u8()?;
            if tag <= MAX_KNOWN_PROP {
                let bit = 1u16 << tag;
                if seen & bit != 0 {
                    return Err(LazerError::DuplicateProperty);
                }
                seen |= bit;
            }
            consume_property(&mut r, tag, is_target, &mut t)?;
        }

        if is_target {
            if found.is_some() {
                return Err(LazerError::DuplicateFeed);
            }
            found = Some(t);
        }
    }

    // The whole payload MUST be consumed. This is what makes truncation fail
    // closed even when the cut lands AFTER the target feed.
    if !r.at_end() {
        return Err(LazerError::TrailingBytes);
    }

    let t = found.ok_or(LazerError::FeedNotFound)?;

    // All 5 subscribed properties are required for the target.
    let raw_price = t.price.ok_or(LazerError::MissingPrice)?;
    // 0 is the None sentinel. A negative price passes here; the oracle rejects it.
    if raw_price == 0 {
        return Err(LazerError::MissingPrice);
    }
    let exponent = t.exponent.ok_or(LazerError::MissingExponent)?;
    let publisher_count = t.publisher_count.ok_or(LazerError::MissingPublisherCount)?;
    if !t.confidence_seen {
        return Err(LazerError::MissingConfidence);
    }
    let feed_update_timestamp_us = t
        .feed_update_us
        .ok_or(LazerError::MissingFeedUpdateTimestamp)?;

    Ok(LazerPrice {
        price: raw_price,
        exponent,
        confidence: t.confidence,
        publisher_count,
        feed_update_timestamp_us,
        channel_id,
        timestamp_us,
    })
}

/// Unwrap a SolanaMessage envelope, returning the inner signed payload slice.
/// This does NOT verify the signature, so it must never run on the price path;
/// on chain the whole envelope goes to `verify_message` and only the payload it
/// returns is parsed. `cfg(test)` keeps the footgun out of the program build.
#[cfg(test)]
pub fn unwrap_solana_payload(message: &[u8]) -> Result<&[u8], LazerError> {
    let mut r = Reader::new(message);
    if r.u32()? != SOLANA_FORMAT_MAGIC {
        return Err(LazerError::BadMagic);
    }
    let _signature = r.take(64)?;
    let _public_key = r.take(32)?;
    let payload_len = r.u16()? as usize;
    r.take(payload_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CH: u8 = 4; // fixed_rate@1000ms, our subscribed channel
    const SILV: u32 = 3154; // Metal.Index.SILVER/USD, the only allowed feed id

    fn le16(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }
    fn le32(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }
    fn le64(v: u64) -> [u8; 8] {
        v.to_le_bytes()
    }

    // A property's raw bytes (tag + value).
    enum Prop {
        Price(i64),
        Conf(i64),
        Exp(i16),
        Pub(u16),
        Fut(Option<u64>),
        BestBid(i64),
        Raw(Vec<u8>), // for crafting duplicates / odd cases
    }
    fn prop_bytes(p: &Prop) -> Vec<u8> {
        let mut b = Vec::new();
        match p {
            Prop::Price(v) => {
                b.push(PROP_PRICE);
                b.extend_from_slice(&le64(*v as u64));
            }
            Prop::Conf(v) => {
                b.push(PROP_CONFIDENCE);
                b.extend_from_slice(&le64(*v as u64));
            }
            Prop::Exp(v) => {
                b.push(PROP_EXPONENT);
                b.extend_from_slice(&le16(*v as u16));
            }
            Prop::Pub(v) => {
                b.push(PROP_PUBLISHER_COUNT);
                b.extend_from_slice(&le16(*v));
            }
            Prop::Fut(opt) => {
                b.push(PROP_FEED_UPDATE_TIMESTAMP);
                match opt {
                    Some(v) => {
                        b.push(1);
                        b.extend_from_slice(&le64(*v));
                    }
                    None => b.push(0),
                }
            }
            Prop::BestBid(v) => {
                b.push(PROP_BEST_BID_PRICE);
                b.extend_from_slice(&le64(*v as u64));
            }
            Prop::Raw(v) => b.extend_from_slice(v),
        }
        b
    }

    fn feed_bytes(feed_id: u32, props: &[Prop]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&le32(feed_id));
        b.push(props.len() as u8);
        for p in props {
            b.extend_from_slice(&prop_bytes(p));
        }
        b
    }

    fn payload(timestamp_us: u64, channel: u8, feeds: &[Vec<u8>]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&le32(PAYLOAD_FORMAT_MAGIC));
        b.extend_from_slice(&le64(timestamp_us));
        b.push(channel);
        b.push(feeds.len() as u8);
        for f in feeds {
            b.extend_from_slice(f);
        }
        b
    }

    // A well-formed target feed with all 5 required properties (fresh print).
    fn good_target(ts: u64) -> Vec<u8> {
        feed_bytes(
            SILV,
            &[
                Prop::Price(7_674_000),
                Prop::Exp(-5),
                Prop::Pub(3),
                Prop::Conf(1234),
                Prop::Fut(Some(ts)),
            ],
        )
    }

    #[test]
    fn extracts_single_feed() {
        let ts = 1_700_000_000_000_000;
        let p = payload(ts, CH, &[good_target(ts)]);
        let r = extract_feed_price(&p, SILV, CH).unwrap();
        assert_eq!(r.price, 7_674_000);
        assert_eq!(r.exponent, -5);
        assert_eq!(r.confidence, Some(1234));
        assert_eq!(r.publisher_count, 3);
        assert_eq!(r.feed_update_timestamp_us, ts);
        assert_eq!(r.channel_id, CH);
        assert_eq!(r.timestamp_us, ts);
    }

    #[test]
    fn picks_target_among_many_and_consumes_all() {
        let ts = 42;
        let other1 = feed_bytes(
            1,
            &[
                Prop::Price(100),
                Prop::Exp(-2),
                Prop::Pub(1),
                Prop::Conf(0),
                Prop::Fut(Some(ts)),
                Prop::BestBid(9),
            ],
        );
        let other2 = feed_bytes(
            2,
            &[
                Prop::Price(7),
                Prop::Exp(0),
                Prop::Pub(2),
                Prop::Conf(1),
                Prop::Fut(Some(ts)),
            ],
        );
        let p = payload(ts, CH, &[other1, good_target(ts), other2]);
        let r = extract_feed_price(&p, SILV, CH).unwrap();
        assert_eq!(r.price, 7_674_000);
        assert_eq!(r.publisher_count, 3);
    }

    #[test]
    fn carried_forward_values_are_returned_not_rejected_by_parser() {
        // feedUpdateTimestamp < timestamp_us: the parser returns both, the
        // oracle rejects the mismatch.
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(5),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(2),
                Prop::Fut(Some(100)),
            ],
        );
        let p = payload(999, CH, &[f]);
        let r = extract_feed_price(&p, SILV, CH).unwrap();
        assert_eq!(r.feed_update_timestamp_us, 100);
        assert_eq!(r.timestamp_us, 999);
    }

    #[test]
    fn wrong_channel() {
        let ts = 1;
        let p = payload(ts, 3, &[good_target(ts)]); // channel 3, expect 4
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::WrongChannel)
        );
    }

    #[test]
    fn duplicate_target_feed() {
        let ts = 1;
        let p = payload(ts, CH, &[good_target(ts), good_target(ts)]);
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::DuplicateFeed)
        );
    }

    #[test]
    fn duplicate_property() {
        let ts = 1;
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(5),
                Prop::Price(6), // duplicate Price tag
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(2),
                Prop::Fut(Some(ts)),
            ],
        );
        let p = payload(ts, CH, &[f]);
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::DuplicateProperty)
        );
    }

    #[test]
    fn trailing_bytes() {
        let ts = 1;
        let mut p = payload(ts, CH, &[good_target(ts)]);
        p.push(0xAB); // one extra byte
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::TrailingBytes)
        );
    }

    #[test]
    fn bad_payload_magic() {
        let ts = 1;
        let mut p = payload(ts, CH, &[good_target(ts)]);
        p[0] ^= 0xFF;
        assert_eq!(extract_feed_price(&p, SILV, CH), Err(LazerError::BadMagic));
    }

    #[test]
    fn feed_not_found() {
        let ts = 1;
        let f = feed_bytes(
            1,
            &[
                Prop::Price(1),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(1),
                Prop::Fut(Some(ts)),
            ],
        );
        let p = payload(ts, CH, &[f]);
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::FeedNotFound)
        );
    }

    #[test]
    fn missing_price_when_zero() {
        let ts = 1;
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(0),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(1),
                Prop::Fut(Some(ts)),
            ],
        );
        let p = payload(ts, CH, &[f]);
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::MissingPrice)
        );
    }

    #[test]
    fn negative_price_passes_parser() {
        // The parser does not editorialize; the oracle rejects price <= 0.
        let ts = 1;
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(-500),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(1),
                Prop::Fut(Some(ts)),
            ],
        );
        let p = payload(ts, CH, &[f]);
        assert_eq!(extract_feed_price(&p, SILV, CH).unwrap().price, -500);
    }

    #[test]
    fn missing_each_required_property() {
        let ts = 1;
        // exponent missing
        let p = payload(
            ts,
            CH,
            &[feed_bytes(
                SILV,
                &[
                    Prop::Price(5),
                    Prop::Pub(1),
                    Prop::Conf(1),
                    Prop::Fut(Some(ts)),
                ],
            )],
        );
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::MissingExponent)
        );
        // publisher count missing
        let p = payload(
            ts,
            CH,
            &[feed_bytes(
                SILV,
                &[
                    Prop::Price(5),
                    Prop::Exp(-5),
                    Prop::Conf(1),
                    Prop::Fut(Some(ts)),
                ],
            )],
        );
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::MissingPublisherCount)
        );
        // confidence property absent
        let p = payload(
            ts,
            CH,
            &[feed_bytes(
                SILV,
                &[
                    Prop::Price(5),
                    Prop::Exp(-5),
                    Prop::Pub(1),
                    Prop::Fut(Some(ts)),
                ],
            )],
        );
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::MissingConfidence)
        );
        // feed update timestamp absent
        let p = payload(
            ts,
            CH,
            &[feed_bytes(
                SILV,
                &[Prop::Price(5), Prop::Exp(-5), Prop::Pub(1), Prop::Conf(1)],
            )],
        );
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::MissingFeedUpdateTimestamp)
        );
    }

    #[test]
    fn feed_update_inner_none_rejected() {
        let ts = 1;
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(5),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(1),
                Prop::Fut(None),
            ],
        );
        let p = payload(ts, CH, &[f]);
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::MissingFeedUpdateTimestamp)
        );
    }

    #[test]
    fn confidence_zero_is_present_but_none() {
        let ts = 1;
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(5),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(0),
                Prop::Fut(Some(ts)),
            ],
        );
        let p = payload(ts, CH, &[f]);
        // present (not MissingConfidence) but value None -> oracle rejects.
        assert_eq!(extract_feed_price(&p, SILV, CH).unwrap().confidence, None);
    }

    #[test]
    fn unknown_property_fails_closed() {
        let ts = 1;
        // tag 99 is unknown -> cannot skip -> error (not a desync).
        let f = feed_bytes(
            SILV,
            &[
                Prop::Price(5),
                Prop::Exp(-5),
                Prop::Pub(1),
                Prop::Conf(1),
                Prop::Fut(Some(ts)),
                Prop::Raw(vec![99, 0, 0]),
            ],
        );
        let p = payload(ts, CH, &[f]);
        assert_eq!(
            extract_feed_price(&p, SILV, CH),
            Err(LazerError::UnknownProperty)
        );
    }

    #[test]
    fn every_truncation_fails_closed() {
        let ts = 1;
        let p = payload(ts, CH, &[good_target(ts)]);
        // EVERY proper-prefix truncation must return Err (never Ok, never panic).
        for cut in 0..p.len() {
            assert!(
                extract_feed_price(&p[..cut], SILV, CH).is_err(),
                "truncation at {cut} did not fail closed",
            );
        }
        // The full buffer parses.
        assert!(extract_feed_price(&p, SILV, CH).is_ok());
    }

    #[test]
    fn solana_envelope_roundtrip() {
        let ts = 7;
        let pl = payload(ts, CH, &[good_target(ts)]);
        let mut env = Vec::new();
        env.extend_from_slice(&le32(SOLANA_FORMAT_MAGIC));
        env.extend_from_slice(&[7u8; 64]);
        env.extend_from_slice(&[9u8; 32]);
        env.extend_from_slice(&le16(pl.len() as u16));
        env.extend_from_slice(&pl);
        let inner = unwrap_solana_payload(&env).unwrap();
        assert_eq!(inner, &pl[..]);
        assert_eq!(
            extract_feed_price(inner, SILV, CH).unwrap().price,
            7_674_000
        );
    }
}
