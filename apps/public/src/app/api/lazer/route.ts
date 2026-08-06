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

/**
 * The single outstanding upstream request, if any.
 *
 * REVIEW-OF-FIXES P1. The cache was written only AFTER `await fetch` resolved and nothing tracked the
 * in-flight request, so every request arriving during a fetch was a MISS and started its own. Measured on
 * the real route: 40 concurrent requests on a cold instance produced **30 upstream Pyth calls**, and a
 * sustained flood produced 3.7/s against a comment claiming the floor was 0.5/s. Seven times the stated
 * bound, on the key this whole file exists to protect.
 *
 * One shared promise collapses N concurrent misses into one upstream call, which is the actual fix. The
 * token bucket bounds the REQUEST rate; only this bounds the UPSTREAM rate.
 */
let inflight: Promise<unknown> | null = null;
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
  // CACHE FIRST. REVIEW-OF-FIXES P1: `allowRequest()` used to run before this, so requests that would
  // have been served from cache for free still spent tokens. With a global 5/s refill and the price banner
  // polling every 5s per open tab, roughly 25 concurrent visitors saturated it, and a 429 on the poll
  // leaves `price` undefined, which disables the mint AND redeem buttons for everyone on that instance.
  // The limiter existed to protect the Pyth key and had become a cheap anonymous outage instead.
  //
  // Serving a cache hit costs nothing upstream, so it must cost nothing here.
  if (silvCache && Date.now() - silvCache.at < CACHE_TTL_MS) {
    return NextResponse.json(silvCache.payload);
  }

  // JOIN BEFORE CHARGING. RE-AUDIT P2: the token was spent before the `inflight` check, so 40 cold
  // concurrent requests produced ONE upstream call but 30x200 and 10x429: ten callers were starved for a
  // cost they were never going to incur. Only the request that CREATES the upstream call has an upstream
  // cost, so only that one should pay for it.
  //
  // The test previously accepted either status and therefore called those ten starved callers a success,
  // which is why the measurement had to come from the auditor rather than from the suite.
  //
  // REVIEW-OF-FIXES P1, and this loop is the third shape of this code. Round 3 P2 was that joining before
  // charging works only when the shared attempt SUCCEEDS: on a rejection every waiter fell through to
  // `allowRequest()`, so 39 joiners drained a 30-token burst for ONE upstream retry and 10 got 429. My fix
  // returned 502 to all of them instead, which is worse and on the money path: `lib/lazer-client.ts` throws
  // on any non-ok status with no retry, and that is the SUBMIT-time envelope fetch. Of 40 concurrent callers
  // hitting one transient blip, the old code served 29 and starved 10; mine served 0 and abandoned 40 mints
  // and redeems with "Lazer proxy 502". Buying back 29 tokens of a bucket that refills in 6 seconds is not
  // worth failing every in-flight transaction.
  //
  // The actual defect was never the retry existing, it was every waiter CHARGING ITSELF for it. So: loop
  // back and join the retry. Exactly one waiter creates it and pays one token, the rest await that one.
  // 1 token per blip instead of 29, and 40 of 40 served instead of 0 of 40.
  //
  // Bounded at two attempts, deliberately. A persistently dead upstream must answer 502 rather than let
  // request N wait on retry N-1 forever, and one retry is all a transient blip needs.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Re-checked every pass: the attempt we just waited on may have populated it.
    if (silvCache && Date.now() - silvCache.at < CACHE_TTL_MS) {
      return NextResponse.json(silvCache.payload);
    }

    if (inflight) {
      let sharedFailed = false;
      try {
        await inflight;
      } catch {
        sharedFailed = true;
      }
      if (silvCache && Date.now() - silvCache.at < CACHE_TTL_MS) {
        return NextResponse.json(silvCache.payload);
      }
      if (sharedFailed && attempt + 1 < 2) {
        // Join the retry on the next pass. `inflight` is cleared in the creator's `.finally` BEFORE the
        // waiters resume, so whichever waiter runs first becomes the creator and the assignment below is
        // synchronous, which is what keeps this to one retry rather than 39.
        continue;
      }
      if (sharedFailed) {
        return NextResponse.json(
          { error: "lazer_unreachable", message: "Upstream price request failed. Retry shortly." },
          { status: 502, headers: { "Retry-After": "1" } },
        );
      }
    }

    // Now we are the one who will call upstream, so now we pay. Waiters never reach this line.
    if (!allowRequest()) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many price requests. Retry shortly." },
        { status: 429, headers: { "Retry-After": "2" } },
      );
    }

    // SINGLE FLIGHT. A miss arriving while another miss is already upstream awaits that one instead of
    // starting a second.
    //
    // The first attempt at this released the waiters inside the fetch's `finally`, which is too early: the
    // shared promise settled before the cache had been written, so every waiter found the cache still empty
    // and fetched anyway. The test measured 30 upstream calls for 40 concurrent requests, i.e. no dedupe at
    // all. The shared promise has to cover fetch AND parse AND the cache write, so a waiter that wakes finds
    // the answer already there. That is why this is a helper rather than a flag around the fetch.
    if (!inflight) {
      inflight = fetchAndCache(apiKey, feedId).finally(() => {
        inflight = null;
      });
    }
    try {
      await inflight;
    } catch (e) {
      // The CREATOR retries too, on the same terms as the waiters. Without this it was the one caller in
      // forty that got a 502, purely for having been the request that happened to open the upstream call.
      // It has already paid its token; a second attempt costs one more and rescues its own transaction
      // along with everyone else's. Measured: 40 requests, one transient blip, 2 upstream calls, 40x200.
      if (attempt + 1 < 2) continue;
      return NextResponse.json(
        { error: "lazer_unreachable", message: String(e).slice(0, 300) },
        { status: 502 },
      );
    }

    if (silvCache) return NextResponse.json(silvCache.payload);
  }

  // Reachable only if a shared attempt resolved without caching, which the helper never does: it either
  // writes the cache or throws. Kept as a defined answer rather than an assumption.
  return NextResponse.json({ error: "lazer_no_payload" }, { status: 502 });
}

/**
 * Fetch upstream, parse, and WRITE THE CACHE. Throws on any failure.
 *
 * Extracted so exactly one of these can be in flight at a time and so its completion means "the cache is
 * populated", which is what the waiters actually need to observe.
 */
async function fetchAndCache(apiKey: string, feedId: number): Promise<void> {
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

  const resp = await fetch(LAZER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(lazerReq),
    // The key never leaves this server route.
    cache: "no-store",
  });

  if (!resp.ok) {
    // REVIEW-OF-FIXES P2: the route used to echo 500 bytes of the upstream body plus its status to any
    // anonymous caller, which tells an attacker whether our key is 403 (no entitlement) or 429 (quota
    // exhausted), i.e. whether the drain they are attempting is working. The detail goes to the server log
    // where an operator can still read it; the caller gets a bare 502.
    const detail = await resp.text().catch(() => "");
    console.error(`lazer upstream ${resp.status}: ${detail.slice(0, 500)}`);
    throw new Error(`lazer upstream ${resp.status}`);
  }

  const data = await resp.json().catch(() => null);
  // The live response carries the ed25519-signed SolanaMessage envelope base64-encoded at solana.data
  // (solana.encoding === "base64"). The client decodes it to the dominion ix's message_data arg.
  const solana = (data as { solana?: { encoding?: string; data?: string } } | null)?.solana;
  if (
    !solana ||
    solana.encoding !== "base64" ||
    typeof solana.data !== "string" ||
    solana.data.length === 0
  ) {
    console.error(`lazer: no solana message in response: ${JSON.stringify(data).slice(0, 500)}`);
    throw new Error("lazer returned no solana message");
  }

  // Also surface the parsed price for the UI, so it shows the SAME feed the contract uses.
  const feed = (data as { parsed?: { priceFeeds?: Array<Record<string, unknown>> } }).parsed
    ?.priceFeeds?.[0];
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

  silvCache = { at: Date.now(), payload: { envelopeBase64: solana.data, price } };
}
