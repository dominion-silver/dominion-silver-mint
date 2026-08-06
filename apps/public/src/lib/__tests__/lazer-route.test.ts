/**
 * The /api/lazer proxy holds the server-side Pyth key, and until 2026-08-06 it had no test at all.
 *
 * External audit finding P-01 (P1): the route accepted ANY positive integer `feedId`, only 3154 was
 * cached, so every other value was a guaranteed cache miss and therefore one upstream Pyth call on our
 * key per request, unauthenticated and unlimited. Walking the integers exhausts the quota and the price,
 * the mint and the redeem stop working for everybody.
 *
 * The comment on the old validation asserted it prevented exactly this. It rejected junk, floats and
 * negatives, which is not the same set as "everything but 3154", and no test existed to notice the gap.
 * So these tests assert the PROPERTY the comment claimed, not the implementation:
 *
 *   1. Only 3154 is served. Anything else is refused BEFORE any upstream call.
 *   2. A flood is refused, also before any upstream call.
 *
 * Both assertions are made by counting `fetch` calls, because "the request was rejected" and "our key
 * was not spent" are different claims and only the second one matters. A 400 that still hit Pyth would
 * pass a status-code test and fail the audit finding.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const UPSTREAM = "https://pyth-lazer.dourolabs.app/v1/latest_price";

/** A minimal stand-in for NextRequest: the route only ever calls `req.json()`. */
function req(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

/** Fresh module per test, because the cache and the token bucket are module-level state. */
async function freshRoute() {
  vi.resetModules();
  process.env.PYTH_LAZER_API_KEY = "test-key-not-a-real-one";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("../../app/api/lazer/route")) as any;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () =>
    new Response(
      JSON.stringify({
        solana: { encoding: "base64", data: "AAAA" },
        parsed: {
          priceFeeds: [
            { price: "5688400", exponent: -2, confidence: "100", feedUpdateTimestamp: "1785334113000000", publisherCount: 3 },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Lazer proxy only serves feed 3154", () => {
  it("serves the default feed when no feedId is sent", async () => {
    const { POST } = await freshRoute();
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // And it asked upstream for 3154, not for whatever happened to be in scope.
    const sent = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.priceFeedIds).toEqual([3154]);
  });

  it("serves an explicit 3154", async () => {
    const { POST } = await freshRoute();
    expect((await POST(req({ feedId: 3154 }))).status).toBe(200);
  });

  it("REFUSES every other feed WITHOUT spending the key", async () => {
    const { POST } = await freshRoute();
    // 1, 2, 3 is literally the attack from the finding: each was a cache miss and an upstream call.
    for (const feedId of [1, 2, 3, 4, 100, 3153, 3155, 999999]) {
      const res = await POST(req({ feedId }));
      expect(res.status, `feedId ${feedId} must be refused`).toBe(400);
      expect(await res.json()).toMatchObject({ error: "feed_not_allowed" });
    }
    // The assertion that actually encodes the finding: zero upstream calls, so zero quota spent.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still refuses the shapes the OLD filter caught, so the fix is not a regression", async () => {
    const { POST } = await freshRoute();
    for (const feedId of [0, -1, 3154.5, "3154", null, true, {}, []]) {
      expect((await POST(req({ feedId }))).status, `${JSON.stringify(feedId)}`).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caches, so a poll loop does not become a call per poll", async () => {
    const { POST } = await freshRoute();
    await POST(req({}));
    await POST(req({}));
    await POST(req({}));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the Lazer proxy rate-limits", () => {
  it("throttles a flood of MISSES, which is the only kind that can reach upstream", async () => {
    // REVIEW-OF-FIXES: this test used to hammer the legal request and expect 429s. That premise died with
    // the fix: cache hits no longer spend tokens, so a sequential legal flood is all hits and nothing is
    // throttled, by design. Keeping the old assertion would have meant reverting the DoS fix to satisfy a
    // test.
    //
    // What still needs bounding is MISSES, since only a miss can reach the key. Make upstream fail so the
    // cache never populates and every request is a miss.
    const { POST } = await freshRoute();
    fetchSpy.mockImplementation(async () => new Response("upstream down", { status: 503 }));

    let limited = 0;
    let upstreamErrors = 0;
    for (let i = 0; i < 200; i++) {
      const st = (await POST(req({ feedId: 3154 }))).status;
      if (st === 429) limited++;
      if (st === 502) upstreamErrors++;
    }
    expect(limited, "a flood of misses must be throttled").toBeGreaterThan(100);
    expect(upstreamErrors, "and the ones that got through report the upstream failure").toBeGreaterThan(0);
    // The bound that matters: the key was spent far fewer times than the flood asked for.
    expect(fetchSpy.mock.calls.length).toBeLessThan(60);
    const res = await POST(req({ feedId: 3154 }));
    if (res.status === 429) expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("N CONCURRENT misses collapse into ONE upstream call", async () => {
    // REVIEW-OF-FIXES: the test here used to be "the limiter runs BEFORE the upstream call" and asserted
    // fetch was called at most once across 200 SEQUENTIAL requests. The 2s cache alone guarantees that, so
    // deleting the token bucket entirely still passed it. It tested the cache and called it the limiter.
    //
    // This is the property the bucket cannot provide and the cache did not: concurrency. Measured before
    // the fix, 40 concurrent requests on a cold instance produced 30 upstream calls.
    const { POST } = await freshRoute();
    let resolveUpstream: (v: Response) => void = () => {};
    const gate = new Promise<Response>((r) => {
      resolveUpstream = r;
    });
    fetchSpy.mockImplementation(() => gate);

    const inFlight = Array.from({ length: 40 }, () => POST(req({})));
    // Let every request reach the fetch boundary before any upstream response lands.
    await new Promise((r) => setImmediate(r));
    resolveUpstream(
      new Response(
        JSON.stringify({
          solana: { encoding: "base64", data: "AAAA" },
          parsed: { priceFeeds: [{ price: "1", exponent: 0, confidence: "1", feedUpdateTimestamp: "1", publisherCount: 3 }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const results = await Promise.all(inFlight);

    expect(fetchSpy.mock.calls.length, "40 concurrent misses must not become 40 upstream calls").toBe(1);
    // RE-AUDIT P2: this used to accept 200 OR 429, which called a starved caller a success and hid the
    // real measurement (30x200, 10x429). A joiner incurs no upstream cost, so it must not be rate-limited:
    // EVERY one of the 40 gets the shared answer.
    const statuses = results.map((r) => r.status);
    expect(
      statuses.filter((s) => s === 429).length,
      `no joiner may be starved, got ${statuses.filter((s) => s === 429).length} x 429`,
    ).toBe(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("a cache HIT costs no token, so the limiter cannot deny a warm instance", async () => {
    // REVIEW-OF-FIXES: `allowRequest()` used to run before the cache check, so cache hits spent tokens.
    // With a 5/s refill and the banner polling every 5s per tab, ~25 visitors saturated it, and a 429 on
    // the poll disables the mint and redeem buttons for everyone on that instance.
    const { POST } = await freshRoute();
    // One miss to warm the cache. That one legitimately spends a token.
    expect((await POST(req({}))).status).toBe(200);
    // Now far more requests than the bucket could ever allow, all cache hits.
    let served = 0;
    for (let i = 0; i < 500; i++) {
      if ((await POST(req({}))).status === 200) served++;
    }
    expect(served, "every cache hit must be served regardless of the bucket").toBe(500);
    expect(fetchSpy.mock.calls.length, "and none of them touched upstream").toBe(1);
  });

  it("a FAILED shared request does not charge the waiters for the retry", async () => {
    // ROUND 3 P2. Joining before charging only helps when the shared attempt succeeds. On rejection every
    // waiter used to fall through to the bucket: 39 joiners drained the burst, 10 got 429, and only one of
    // them created the retry. 29 tokens for one upstream call, then starvation. The concurrency test above
    // covered only the happy branch, which is why the measurement came from the auditor.
    const { POST } = await freshRoute();
    let rejectUpstream: (e: Error) => void = () => {};
    const gate = new Promise<Response>((_, rej) => {
      rejectUpstream = rej;
    });
    fetchSpy.mockImplementation(() => gate);

    const inFlight = Array.from({ length: 40 }, () => POST(req({})));
    await new Promise((r) => setImmediate(r));
    rejectUpstream(new Error("upstream down"));
    const results = await Promise.all(inFlight);
    const statuses = results.map((r) => r.status);

    // ONE upstream attempt for the whole burst: the creator's. Nobody retried on the way out.
    expect(fetchSpy.mock.calls.length).toBe(1);
    // Everybody hears about the failure; nobody is told to come back later because the bucket is empty.
    expect(statuses.every((st) => st === 502)).toBe(true);
    expect(statuses.filter((st) => st === 429).length, "no waiter may be rate-limited for a retry it did not make").toBe(0);
  });
});
