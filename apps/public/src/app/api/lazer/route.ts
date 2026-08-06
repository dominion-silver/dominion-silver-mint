// Server-side Pyth Lazer proxy. Holds PYTH_LAZER_API_KEY (server-only) so the key never reaches the
// browser, and returns the signed SOLANA envelope for the client to assemble into ed25519 + dominion ixs
// (lazer-assembly.ts). 503 while the key is unset. The key needs the `pyth-indices` group for SILV.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAZER_ENDPOINT = "https://pyth-lazer.dourolabs.app/v1/latest_price";
// Metal.Index.SILVER/USD, pure spot.
const SILV_FEED_ID = 3154;

// Per-warm-instance cache: the banner polls every 5s, so without it every poll burns a Lazer call. A 2s
// envelope is inside the staleness ceiling, and the high-water mark accepts one timestamp across mints.
const CACHE_TTL_MS = 2000;
let silvCache: { at: number; payload: unknown } | null = null;

// Token bucket (P-01), per warm instance and NOT distributed: it caps what one instance can spend, not a
// many-instance flood. Refills continuously at RATE tokens/second up to BURST.
const BUCKET_BURST = 30;
const BUCKET_RATE_PER_SEC = 5;
let tokens = BUCKET_BURST;
let lastRefill = Date.now();

// The single outstanding upstream request. One shared promise collapses N concurrent misses into one
// upstream call: the bucket bounds the REQUEST rate, only this bounds the UPSTREAM rate.
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

  // ALLOWLIST, not a numeric filter (P-01). Only 3154 is cached, so any other value is a guaranteed miss
  // and therefore one unauthenticated upstream call on our key; walking the integers exhausts the quota.
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

  // CACHE FIRST, before `allowRequest()`: a hit costs nothing upstream so it must cost nothing here.
  // Charging hits let ~25 polling tabs saturate the 5/s refill, and a 429 on the poll leaves `price`
  // undefined, disabling mint AND redeem for everyone on that instance.
  if (silvCache && Date.now() - silvCache.at < CACHE_TTL_MS) {
    return NextResponse.json(silvCache.payload);
  }

  // JOIN BEFORE CHARGING: only the request that CREATES the upstream call pays a token, so no waiter is
  // 429'd for a call it did not make. On a failed shared attempt the waiters loop back and JOIN the retry
  // rather than all being answered 502 (lazer-client.ts throws on any non-ok status, with no retry, and
  // that is the SUBMIT-time fetch). Two attempts max, so a dead upstream answers instead of looping.
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
        // `inflight` clears in the creator's `.finally` BEFORE waiters resume, and the assignment below is
        // synchronous, so the first waiter to run becomes the sole creator of the retry.
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

    // SINGLE FLIGHT. The shared promise must cover fetch AND parse AND the cache write, or a waking waiter
    // finds an empty cache and fetches anyway. Hence a helper, not a flag around the fetch.
    if (!inflight) {
      inflight = fetchAndCache(apiKey, feedId).finally(() => {
        inflight = null;
      });
    }
    try {
      await inflight;
    } catch (e) {
      // The CREATOR retries on the same terms as the waiters, not a lone 502 for having opened the call.
      if (attempt + 1 < 2) continue;
      // The body must NOT echo `e`: its upstream status tells an anonymous caller whether our key is 403
      // (no entitlement) or 429 (quota gone). Log it. Same bare body and Retry-After as the waiter path.
      console.error(`[lazer] upstream failed after a retry: ${String(e).slice(0, 300)}`);
      return NextResponse.json(
        { error: "lazer_unreachable", message: "Upstream price request failed. Retry shortly." },
        { status: 502, headers: { "Retry-After": "1" } },
      );
    }

    if (silvCache) return NextResponse.json(silvCache.payload);
  }

  // Unreachable: the helper either writes the cache or throws. A defined answer, not an assumption.
  return NextResponse.json({ error: "lazer_no_payload" }, { status: 502 });
}

// Fetch upstream, parse, and WRITE THE CACHE, so resolution means "the cache is populated", which is what
// the waiters observe. Throws on any failure.
async function fetchAndCache(apiKey: string, feedId: number): Promise<void> {
  // Pyth Lazer latest_price shape. The dominion parser needs these five properties on the SOLANA chain.
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
    cache: "no-store",
    // Load-bearing: the two-attempt bound only holds when a failure is FAST. A slow-failing upstream costs
    // two attempts, exceeds the function limit, and the caller gets a platform 504 rather than our 502.
    signal: AbortSignal.timeout(3_000),
  });

  if (!resp.ok) {
    // Detail to the log ONLY: echoing our key's 403 (no entitlement) or 429 (quota gone) would tell an
    // attacker whether their drain is working. The caller gets a bare 502.
    const detail = await resp.text().catch(() => "");
    console.error(`lazer upstream ${resp.status}: ${detail.slice(0, 500)}`);
    throw new Error(`lazer upstream ${resp.status}`);
  }

  const data = await resp.json().catch(() => null);
  // The ed25519-signed SolanaMessage envelope is base64 at solana.data, and becomes `message_data`.
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
