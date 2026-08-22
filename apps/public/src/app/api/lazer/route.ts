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
let silvCache: { at: number; payload: unknown; feedTsUs: number } | null = null;

// The newest `feedUpdateTimestamp` this instance has handed to a SUBMITTER.
// made the on-chain anti-replay strict: one signed envelope prices exactly ONE operation, and the
// loser of the race is refused AFTER paying the Lazer verify fee. `fresh: true` was introduced to stop
// the submit path reusing a CACHED envelope, and the audit was right that this is not the same thing as
// getting a new timestamp: `latest_price` returns the same fixed print for a whole second, so two
// submitters served two separate upstream calls inside that second still receive the same envelope.
// So `fresh` carries an ADVISORY claim on top of the cache bypass: the first caller handed a given
// print is told `contended: false`, everyone after is served the same envelope with `contended: true`
// and can go looking for a newer one before asking a human to sign. It is advisory and not a refusal
// because this endpoint is unauthenticated: a hard refusal would let anyone take the product down with
// one request per second. See the long note on `claimFresh`.
// What this CANNOT do, and the reason it says instance and not protocol: the state is per warm
// instance, and nothing stops a caller fetching envelopes from Pyth directly with their own key.
// Global fairness is an on-chain property, and the on-chain half of it is `config.min_operation_usdc`
// (), which is where a cost actually lands on an attacker.
let lastClaimedFeedTsUs = 0;

// THE FLOOR ON HOW OFTEN THIS INSTANCE MAY CALL PYTH, whatever callers ask for.
// The feed publishes at `fixed_rate@1000ms`, so calling more often than that cannot return anything
// new: it spends quota to receive the same print. Before this, `fresh: true` bypassed the cache and
// each serialised anonymous request became an upstream call, which made Dominion's quota consumable by
// anyone with curl. The number is the publish period, not a throttle chosen for comfort: raising it
// would serve stale prints, lowering it would buy nothing.
const MIN_UPSTREAM_INTERVAL_MS = 1000;

// Token bucket (), per warm instance and NOT distributed: it caps what one instance can spend, not a
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

  // ALLOWLIST, not a numeric filter (). Only 3154 is cached, so any other value is a guaranteed miss
  // and therefore one unauthenticated upstream call on our key; walking the integers exhausts the quota.
  let requestedFeed: unknown;
  // `fresh: true` skips the cache. Only the submit path sets it; see the note at the cache check below.
  let fresh = false;
  try {
    const body = await req.json().catch(() => ({}));
    requestedFeed = body?.feedId;
    fresh = body?.fresh === true;
  } catch {
    /* no body: the default feed, cached */
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

  // THE CALLER NO LONGER DRIVES THE UPSTREAM CADENCE.
  // THE DEFECT. `fresh: true` is unauthenticated and it meant "bypass the cache", so every serialised
  // `{"fresh":true}` request that missed the single-flight window became one authenticated Pyth call on
  // OUR key. An anonymous `while true; do curl ...; done` therefore spent Dominion's quota and
  // entitlement, with no wallet, no gas and no on-chain transaction, and `min_operation_usdc` does not
  // touch it because nothing is submitted. The token bucket bounded it per warm instance, and a
  // serverless deployment multiplies the instances.
  // THE FIX, and it is a REMOVAL rather than another control: `fresh` no longer decides whether we go
  // upstream. The upstream cadence is now a property of THIS MODULE, `MIN_UPSTREAM_INTERVAL_MS`, set to
  // the feed's own publish period. A caller can never make us call Pyth sooner than the next print is
  // due, whatever it asks for and however many callers ask. What `fresh` still does is what it is for:
  // it refuses to serve a print that this instance already handed to a submitter (`contended`), and it
  // waits for the in-flight refresh rather than reading an aged cache.
  // WHAT THIS DOES NOT SOLVE, said plainly because the audit was right about it: the state is per warm
  // instance, so N instances still make N times the calls. Making the cadence global needs a shared
  // store (a KV, a lock, one poller) and that is infrastructure, not a code change. This bounds what one
  // instance can be made to spend from unbounded to one call per print.
  const cacheAge = () => (silvCache ? Date.now() - silvCache.at : Number.POSITIVE_INFINITY);
  // The banner is served from the 2s display cache, exactly as before: a hit costs nothing upstream so
  // it must cost nothing here. Charging hits let ~25 polling tabs saturate the refill, and a 429 on the
  // poll leaves `price` undefined, disabling mint AND redeem for everyone on that instance.
  const cacheHit = () => !fresh && silvCache !== null && cacheAge() < CACHE_TTL_MS;
  if (cacheHit()) {
    return NextResponse.json(silvCache!.payload);
  }
  // THE CADENCE FLOOR. A `fresh` caller arriving inside the interval is served the newest envelope we
  // have, marked `contended` if it was already claimed. It is never a reason to call upstream.
  if (fresh && silvCache !== null && cacheAge() < MIN_UPSTREAM_INTERVAL_MS) {
    const claimed = claimFresh();
    if (claimed) return claimed;
    return NextResponse.json({ ...(silvCache.payload as object), contended: true });
  }

  // JOIN BEFORE CHARGING: only the request that CREATES the upstream call pays a token, so no waiter is
  // 429'd for a call it did not make. On a failed shared attempt the waiters loop back and JOIN the retry
  // rather than all being answered 502 (lazer-client.ts throws on any non-ok status, with no retry, and
  // that is the SUBMIT-time fetch).
  // and this is the bug that was here: the two cache checks inside this loop were both
  // guarded by `!fresh`, so a `fresh` waiter skipped them, fell through to `allowRequest()`, and PAID A
  // TOKEN for an upstream call it had not made. Measured by the audit: 40 concurrent `fresh` requests
  // produced 30 x 200, 10 x 429 and only 2 upstream calls. The comment on that line said "waiters never
  // reach this line", which was true for the cached path and false for the one the money flows through.
  // A joiner is now served or claim-refused, and never charged.
  // Two separate bounds, and they are not the same number on purpose. ATTEMPTS bounds how many times a
  // `fresh` caller may go looking for an unclaimed print. MAX_UPSTREAM_FAILURES bounds how many times a
  // DEAD upstream is retried, and it stays at 2: a persistently dead endpoint must answer, not loop, and
  // that bound is what stops one burst from making three rounds of doomed calls on our key.
  // ONE attempt for `fresh`, and this is a correction to the previous version of this fix.
  // Retrying inside the route was worse than useless. `latest_price` returns the same fixed print for
  // a whole second (see the note at the top), and nothing in this loop sleeps, so a contended caller
  // burned three tokens and made three upstream calls that were guaranteed to return the same
  // timestamp and fail the claim identically. Under the anonymous request loop this endpoint has to
  // survive, that tripled the cost of the attack on OUR key rather than the attacker's: the
  // amplification the 409 revert existed to remove, reintroduced one line lower.
  // Waiting for a NEW print is the client's job, because only the client can afford to sleep: see
  // CLAIM_RETRY_MS in lib/lazer-execute.ts. The non-fresh path keeps its two passes, which are for
  // JOINING a shared call and retrying a failed one, not for chasing a timestamp.
  const ATTEMPTS = fresh ? 1 : 3;
  const MAX_UPSTREAM_FAILURES = 2;
  let upstreamFailures = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Re-checked every pass: the attempt we just waited on may have populated it.
    if (cacheHit()) return NextResponse.json(silvCache!.payload);

    const shared = inflight;
    if (shared) {
      let sharedFailed = false;
      try {
        await shared;
      } catch {
        sharedFailed = true;
      }
      if (!sharedFailed) {
        // Served by SOMEBODY ELSE's upstream call, so no token: we caused no upstream cost. This is the
        // line the `fresh` waiter used to walk past.
        if (cacheHit()) return NextResponse.json(silvCache!.payload);
        if (fresh) {
          const claimed = claimFresh();
          if (claimed) return claimed;
          // The shared payload carries a print somebody else already claimed. Loop: the next pass either
          // joins a newer call or creates one. Still no token spent by us.
          continue;
        }
      }
      if (sharedFailed) {
        upstreamFailures += 1;
        if (upstreamFailures < MAX_UPSTREAM_FAILURES) {
          // `inflight` clears in the creator's `.finally` BEFORE waiters resume, and the assignment below
          // is synchronous, so the first waiter to run becomes the sole creator of the retry.
          continue;
        }
        return NextResponse.json(
          { error: "lazer_unreachable", message: "Upstream price request failed. Retry shortly." },
          { status: 502, headers: { "Retry-After": "1" } },
        );
      }
    }

    // Now we are the one who will create the upstream call, so now we pay.
    // The `!inflight` half is belt-and-braces, and honestly labelled as such: a mutation test showed it
    // is not what closes . It only fires on the narrow non-fresh fallthrough (a shared call
    // succeeded, the cache had already aged out, and another request re-created `inflight` in between).
    // The load-bearing join for the submit path is the `if (fresh)` claim block above; removing THAT is
    // what turns "NO fresh waiter is charged a token" red.
    if (!inflight && !allowRequest()) {
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
      upstreamFailures += 1;
      if (upstreamFailures < MAX_UPSTREAM_FAILURES && attempt + 1 < ATTEMPTS) continue;
      // The body must NOT echo `e`: its upstream status tells an anonymous caller whether our key is 403
      // (no entitlement) or 429 (quota gone). Log it. Same bare body and Retry-After as the waiter path.
      console.error(`[lazer] upstream failed after a retry: ${String(e).slice(0, 300)}`);
      return NextResponse.json(
        { error: "lazer_unreachable", message: "Upstream price request failed. Retry shortly." },
        { status: 502, headers: { "Retry-After": "1" } },
      );
    }

    if (fresh) {
      const claimed = claimFresh();
      if (claimed) return claimed;
      continue;
    }
    if (silvCache) return NextResponse.json(silvCache.payload);
  }

  if (fresh && silvCache) {
    // CONTENDED, and served anyway. See the note on `claimFresh` for why this is a 200 and not a 409.
    return NextResponse.json({ ...(silvCache.payload as object), contended: true });
  }
  // Unreachable for the cached path: the helper either writes the cache or throws.
  return NextResponse.json({ error: "lazer_no_payload" }, { status: 502 });
}

/**
 * Try to be the FIRST caller handed this print for submission. Returns the response on
 * success and null when somebody already took it, which tells the caller to go looking for a newer one.
 * THE CLAIM IS ADVISORY, NOT AN ENTITLEMENT, and that is a deliberate reversal.
 * The first version of this fix answered 409 to every loser. A took the obvious next step
 * and pointed a `while true; do curl -XPOST /api/lazer -d '{"fresh":true}'; done` at it: this endpoint
 * has no authentication of any kind, so an anonymous attacker claims every print within milliseconds of
 * publication and every real mint and redeem in the UI dies with "retry in a moment", for as long as the
 * loop runs, at the cost of one HTTP request per second and no wallet, no gas and no account.
 * That trade was backwards. What the loser of a race actually pays without a claim is one Lazer verify
 * fee, bounded by LAZER_FEE_CEILING at 10_000 lamports, plus a transaction fee: a fraction of a cent,
 * on a transaction they chose to send. What the hard refusal bought was a way to take the product down
 * for free. So a contended caller is now SERVED, with `contended: true` so the client knows it is racing
 * and can go looking for a fresher print before it asks a human to sign.
 * What this leaves unsolved, stated plainly rather than papered over: real coordination needs an
 * AUTHENTICATED reservation, so that a claim costs something and belongs to somebody who will actually
 * submit. That is a product decision, it does not exist here, and no amount of cleverness in an
 * anonymous endpoint substitutes for it. The on-chain half of the same problem is
 * `config.min_operation_usdc` (), which is where the cost actually lands on an attacker.
 * The claim is taken with no `await` between the check and the write, so two concurrent callers on the
 * same instance cannot both be the claimant. This function must stay synchronous for that to hold.
 */
function claimFresh(): NextResponse | null {
  if (!silvCache) return null;
  if (silvCache.feedTsUs <= lastClaimedFeedTsUs) return null;
  lastClaimedFeedTsUs = silvCache.feedTsUs;
  return NextResponse.json({ ...(silvCache.payload as object), contended: false });
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

  // the raw microsecond feed timestamp is kept alongside the payload, because it is what
  // the on-chain high-water mark compares against. `price.publishTimeSec` is a floor to seconds and is
  // for display only; claiming on it would let two prints inside one second look identical.
  // A payload with no parseable feed timestamp gets 0, which `claimFresh` can never hand to a submitter
  // (`0 <= lastClaimedFeedTsUs` for any claim state, including the initial 0). That is the safe
  // direction: an unclaimable envelope costs a retry, an unverifiable one costs a Lazer fee.
  const rawFeedTs = feed ? Number(feed.feedUpdateTimestamp) : NaN;
  // BOUNDED, not merely positive. `lastClaimedFeedTsUs` only ever moves forward, so a single upstream
  // response carrying an out-of-range timestamp (clock skew at Pyth, a unit change from microseconds to
  // nanoseconds, a schema edit) would pin the claim state above every future print and mark every
  // subsequent submit contended for the life of the warm instance. The on-chain policy has
  // LAZER_FUTURE_SKEW_US for the same reason; this is its counterpart. One hour of forward tolerance is
  // far beyond the 1000ms publish cadence and far short of a unit error.
  const nowUs = Date.now() * 1000;
  const feedTsUs =
    Number.isFinite(rawFeedTs) && rawFeedTs > 0 && rawFeedTs < nowUs + 3_600_000_000
      ? rawFeedTs
      : 0;
  silvCache = { at: Date.now(), payload: { envelopeBase64: solana.data, price }, feedTsUs };
}
