// Server-side Pyth Lazer proxy. Holds the Pyth Starter API key (PYTH_LAZER_API_
// KEY, server-only env var) so it is NEVER shipped to the browser, fetches the
// latest SOLANA-targeted signed price message for the requested feed, and
// returns the raw envelope (hex) to the client, which assembles the ed25519 +
// dominion instructions (see src/lib/lazer-assembly.ts).
//
// STATUS: the request + response mapping is VERIFIED against the live API
// (2026-06-10): the ed25519-signed envelope is base64 at `solana.data`. Until
// PYTH_LAZER_API_KEY is set this returns 503 so the client can detect "Lazer
// not configured yet". NOTE: the key must have feed-group access to SILV (feed
// 3154 needs the `pyth-indices` group); a key without it gets 403 from Lazer.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAZER_ENDPOINT = "https://pyth-lazer.dourolabs.app/v1/latest_price";
// Metal.Index.SILVER/USD, pure spot (confirmed 2026-07-26). Requires the
// `pyth-indices` entitlement group on the Pyth key: a key without it gets 403.
const SILV_FEED_ID = 3154;

// Short server-side cache for the default (SILV) feed. The UI price banner polls
// every 5s and a mint fetches one envelope; without this, every poll burns a
// Lazer API call. A ~2s envelope is well within the on-chain staleness ceiling,
// and the high-water mark allows the same feed_update_timestamp across concurrent
// mints, so a cached envelope is safe to reuse. (Coarse per-warm-instance memo;
// a shared cache / rate-limit is the production hardening.)
const CACHE_TTL_MS = 2000;
let silvCache: { at: number; payload: unknown } | null = null;

// Token bucket for audit P-01. Refills continuously at RATE tokens/second up to BURST.
const BUCKET_BURST = 30;
const BUCKET_RATE_PER_SEC = 5;
let tokens = BUCKET_BURST;
let lastRefill = Date.now();
function allowRequest(): boolean {
  const now = Date.now();
  tokens = Math.min(
    BUCKET_BURST,
    tokens + ((now - lastRefill) / 1000) * BUCKET_RATE_PER_SEC,
  );
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.PYTH_LAZER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "lazer_not_configured", message: "Pyth Lazer API key not set." },
      { status: 503 },
    );
  }

  // EXTERNAL AUDIT FINDING P-01 (P1). This block used to accept ANY positive integer as `feedId`,
  // behind a comment claiming it "prevents using this same-origin route to spend the server-held key's
  // quota on junk/float/negative feeds". It prevented junk, floats and negatives. It did not prevent
  // 1, 2, 3, 4... and only feed 3154 was cached, so every other value was a guaranteed cache MISS and
  // therefore one upstream Pyth call, on our key, per request, with no authentication and no rate
  // limit. Walk the integers and the entitlement or quota is exhausted; then the price, the mint and
  // the redeem stop working for everyone.
  //
  // The fix is not a better numeric filter, it is an ALLOWLIST. Nothing in this app has ever requested
  // another feed: the client sends `{}` and the contract is bound to 3154 by `config.pyth_lazer_feed_id`.
  // A parameter with exactly one legal value should not be a parameter.
  let requestedFeed: unknown;
  try {
    const body = await req.json().catch(() => ({}));
    requestedFeed = body?.feedId;
  } catch {
    /* no body: the default feed */
  }
  if (requestedFeed !== undefined && requestedFeed !== SILV_FEED_ID) {
    return NextResponse.json(
      {
        error: "feed_not_allowed",
        message: `This proxy serves feed ${SILV_FEED_ID} only.`,
      },
      { status: 400 },
    );
  }
  const feedId = SILV_FEED_ID;

  // A second, independent brake, because the allowlist alone does not bound VOLUME: 3154 is cached,
  // but a cache expires every 2s, so a flood still becomes one upstream call per 2s per warm instance,
  // plus one per cold start. This is a coarse per-instance token bucket, not a distributed limiter, and
  // it is deliberately generous: the UI polls every 5s and a mint fetches one envelope, so a real user
  // needs well under 1 request/second.
  //
  // Being per-instance is a real limitation and worth stating rather than implying otherwise. It caps
  // what ONE serverless instance can spend; it does not stop an attacker who can cause many instances
  // to spin up. The durable fix is a shared limiter (Upstash/Redis) keyed on IP, which needs
  // infrastructure this app does not have yet. Recorded in the audit remediation notes as the
  // follow-up; what is here now turns an unbounded drain into a bounded one.
  if (!allowRequest()) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many price requests. Retry shortly." },
      { status: 429, headers: { "Retry-After": "2" } },
    );
  }

  if (silvCache && Date.now() - silvCache.at < CACHE_TTL_MS) {
    return NextResponse.json(silvCache.payload);
  }

  // Request shape per the Pyth Lazer latest_price API (verified live 2026-06-10).
  // The dominion parser needs price + exponent + publisherCount + confidence +
  // feedUpdateTimestamp on the SOLANA chain at the fixed_rate@1000ms channel.
  const lazerReq = {
    priceFeedIds: [feedId],
    properties: [
      "price",
      "exponent",
      "publisherCount",
      "confidence",
      "feedUpdateTimestamp",
    ],
    chains: ["solana"],
    channel: "fixed_rate@1000ms",
  };

  let resp: Response;
  try {
    resp = await fetch(LAZER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(lazerReq),
      // The key never leaves this server route.
      cache: "no-store",
    });
  } catch (e) {
    return NextResponse.json(
      { error: "lazer_unreachable", message: String(e).slice(0, 500) },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return NextResponse.json(
      { error: "lazer_error", status: resp.status, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  const data = await resp.json().catch(() => null);
  // The live response carries the ed25519-signed SolanaMessage envelope base64-
  // encoded at solana.data (solana.encoding === "base64"). The client decodes
  // it to the dominion ix's message_data arg (see lazer-client.ts).
  const solana = data?.solana;
  if (
    !solana ||
    solana.encoding !== "base64" ||
    typeof solana.data !== "string" ||
    solana.data.length === 0
  ) {
    // Bounded diagnostic only (never echo an unbounded third-party blob).
    return NextResponse.json(
      { error: "lazer_no_solana_message", raw: JSON.stringify(data).slice(0, 500) },
      { status: 502 },
    );
  }

  // Also surface the parsed price for the UI (display + the mint/redeem preview),
  // so the UI shows the SAME feed the contract uses (the Lazer SILV feed), not
  // the retired Core XAG/USD. `parsed.priceFeeds[0]` carries price + exponent +
  // confidence + feedUpdateTimestamp(us) + publisherCount.
  const feed = data?.parsed?.priceFeeds?.[0];
  const price =
    feed && typeof feed.price !== "undefined"
      ? {
          priceUsd: Number(feed.price) * Math.pow(10, Number(feed.exponent)),
          confidence: Number(feed.confidence) * Math.pow(10, Number(feed.exponent)),
          publishTimeSec: Math.floor(Number(feed.feedUpdateTimestamp) / 1e6),
          publisherCount: Number(feed.publisherCount),
          exponent: Number(feed.exponent),
        }
      : null;

  const payload = { envelopeBase64: solana.data, price };
  silvCache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
