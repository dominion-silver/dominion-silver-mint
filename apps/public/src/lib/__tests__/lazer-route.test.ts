/**
 * The /api/lazer proxy holds the server-side Pyth key, so these tests assert two PROPERTIES: only feed
 * 3154 is served, and a flood is refused, both BEFORE any upstream call.
 * Every assertion counts `fetch` calls, because "the request was rejected" and "our key was not spent" are
 * different claims and only the second matters: a 400 that still hit Pyth passes a status-code test and
 * fails .
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const UPSTREAM = "https://pyth-lazer.dourolabs.app/v1/latest_price";

/** A minimal stand-in for NextRequest: the route only ever calls `req.json`. */
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
    // Walking the integers is the attack: each is a cache miss and therefore an upstream call.
    for (const feedId of [1, 2, 3, 4, 100, 3153, 3155, 999999]) {
      const res = await POST(req({ feedId }));
      expect(res.status, `feedId ${feedId} must be refused`).toBe(400);
      expect(await res.json()).toMatchObject({ error: "feed_not_allowed" });
    }
    // The assertion that encodes the scenario: zero upstream calls, so zero quota spent.
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
    // Only a MISS can reach the key, and a sequential flood of legal requests is all cache hits, which are
    // deliberately free. So make upstream fail: the cache never populates and every request is a miss.
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
    // CONCURRENCY, which neither the cache nor the bucket provides: a sequential version of this test is
    // satisfied by the 2s cache alone and still passes with the token bucket deleted.
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
    // Accepting 200 OR 429 here would call a starved caller a success. A joiner incurs no upstream cost, so
    // it must not be rate-limited: every one of the 40 gets the shared answer.
    const statuses = results.map((r) => r.status);
    expect(
      statuses.filter((s) => s === 429).length,
      `no joiner may be starved, got ${statuses.filter((s) => s === 429).length} x 429`,
    ).toBe(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("a cache HIT costs no token, so the limiter cannot deny a warm instance", async () => {
    // Charging tokens for cache hits lets ~25 polling tabs saturate the 5/s refill, and a 429 on the poll
    // disables the mint and redeem buttons for everyone on that instance.
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

  it("a FAILED shared request does not charge the waiters, and they JOIN the retry", async () => {
    // What the burst must do: ONE waiter creates the retry and pays ONE token, the other 38 await it, and
    // all 40 are served. The two failure modes this pins are waiters that each charge for the retry (the
    // burst drains and the last ten get 429) and waiters that are all answered 502, which is worse and on
    // the money path: lib/lazer-client.ts throws on any non-ok status with no retry, and that is the
    // submit-time envelope fetch, so one transient blip abandons every in-flight mint and redeem.
    const { POST } = await freshRoute();
    let rejectFirst: (e: Error) => void = () => {};
    const firstAttempt = new Promise<Response>((_, rej) => {
      rejectFirst = rej;
    });
    let calls = 0;
    fetchSpy.mockImplementation(() => {
      calls += 1;
      // Only the FIRST upstream attempt fails, which is what a transient blip looks like.
      if (calls === 1) return firstAttempt;
      return Promise.resolve(
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
    });

    const inFlight = Array.from({ length: 40 }, () => POST(req({})));
    await new Promise((r) => setImmediate(r));
    rejectFirst(new Error("upstream down"));
    const statuses = (await Promise.all(inFlight)).map((r: Response) => r.status);

    // TWO upstream calls total for 40 requests: the failed one and the single joined retry.
    expect(calls, "the retry must be joined by the waiters, not made by each of them").toBe(2);
    // Nobody is told to come back later because the bucket is empty.
    expect(statuses.filter((st) => st === 429).length, "no waiter may be rate-limited for a retry it did not make").toBe(0);
    // And nobody's transaction is abandoned over a blip the retry already fixed.
    expect(statuses.filter((st) => st === 502).length, "the 502-to-everyone fix was worse than the bug").toBe(0);
    expect(statuses.every((st) => st === 200)).toBe(true);
  });

  it("an upstream that stays down answers 502 rather than looping", async () => {
    // The other half of the bounded retry: two attempts, then a definite answer. Without the bound a
    // persistently dead upstream has request N waiting on retry N-1 forever.
    const { POST } = await freshRoute();
    fetchSpy.mockImplementation(() => Promise.reject(new Error("upstream down for good")));

    const statuses = (await Promise.all(Array.from({ length: 40 }, () => POST(req({}))))).map(
      (r: Response) => r.status,
    );
    expect(statuses.every((st) => st === 502 || st === 429)).toBe(true);
    expect(statuses.filter((st) => st === 200).length).toBe(0);
    // Bounded: two attempts for the whole burst, not one per caller.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

/**
 * The `fresh: true` path, which had NO test at all: every case above goes through the
 * cached path, and the defect lived exactly in the branch none of them entered.
 * The audit measured it: 40 concurrent `fresh` requests produced 30 x 200, 10 x 429 and 2 upstream
 * calls, because a waiter that joined an in-flight call skipped both cache checks (`!fresh` guarded
 * them), fell through to `allowRequest`, and paid a token for a call it had not made.
 * The first fix answered 409 to a contended caller. A showed that turned an
 * unauthenticated endpoint into a free product-wide denial (one curl per second claims every print),
 * so contention is now ADVISORY: everybody is served, and `contended` says whether this caller was
 * first. These tests pin BOTH halves, because reverting either one is a regression.
 */
describe("the fresh (submit) path", () => {
  /** Upstream that always answers with the SAME feed timestamp, which is what a fixed 1s print is. */
  function stubUpstream(feedUpdateTimestamp: string) {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            solana: { encoding: "base64", data: "AAAA" },
            parsed: {
              priceFeeds: [
                { price: "5688400", exponent: -2, confidence: "100", feedUpdateTimestamp, publisherCount: 3 },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  }

  /** A timestamp near now, in microseconds, so the route's forward-skew bound accepts it. */
  function nowUs(offsetSec = 0): string {
    return String((Date.now() + offsetSec * 1000) * 1000);
  }

  it("NO fresh waiter is charged a token for a call it did not make", async () => {
    // THE ORIGINAL FINDING, as an assertion. A joiner causes no upstream cost, so it must never be
    // rate-limited.
    const { POST } = await freshRoute();
    stubUpstream(nowUs());

    const statuses = (await Promise.all(Array.from({ length: 40 }, () => POST(req({ fresh: true })))))
      .map((r: Response) => r.status);

    expect(
      statuses.filter((s) => s === 429).length,
      `no fresh waiter may be 429'd, got ${statuses.filter((s) => s === 429).length}`,
    ).toBe(0);
    // ONE upstream call for the whole burst. A caught that the earlier bound of 3 was
    // ratifying an amplification rather than catching it: the route retried a contended claim in-line,
    // with no sleep, against a feed that returns the same print for a full second, so each request
    // could spend three tokens on three identical answers. That tripled the cost, on our Pyth key, of
    // the anonymous request loop this endpoint has to survive.
    expect(
      fetchSpy.mock.calls.length,
      "a fresh burst must collapse into ONE upstream call, not one per attempt per caller",
    ).toBe(1);
  });

  it("NEVER refuses a submitter, so an anonymous loop cannot deny the mint path", async () => {
    // THE REGRESSION GUARD for the 409 that a removed. Every one of these must be served:
    // this endpoint has no authentication, so a status that means "you may not have a price" is a
    // status anybody can force on everybody else with one request per second.
    const { POST } = await freshRoute();
    stubUpstream(nowUs());

    const results = await Promise.all(Array.from({ length: 40 }, () => POST(req({ fresh: true }))));
    const statuses = results.map((r: Response) => r.status);
    expect(statuses.every((s) => s === 200), `got ${[...new Set(statuses)].join(",")}`).toBe(true);
    for (const r of results) {
      expect((await r.clone().json()).envelopeBase64).toBe("AAAA");
    }
  });

  it("marks exactly ONE caller uncontended per print, and the rest contended", async () => {
    // The advisory half. lets one signed envelope price one operation, so a submitter that is not
    // first should look for a newer print before asking a human to sign.
    const { POST } = await freshRoute();
    stubUpstream(nowUs());

    const bodies = await Promise.all(
      (await Promise.all(Array.from({ length: 40 }, () => POST(req({ fresh: true }))))).map(
        (r: Response) => r.json(),
      ),
    );
    expect(bodies.filter((b) => b.contended === false).length, "exactly one first claimant").toBe(1);
    expect(bodies.filter((b) => b.contended === true).length).toBe(39);
  });

  it("a NEW print is claimable again, so contention is about the print and not a dead end", async () => {
    // Time is driven explicitly, because put a FLOOR on how often this route may call
    // upstream: within MIN_UPSTREAM_INTERVAL_MS a caller is served what we already have, whatever it
    // asks for. Without advancing the clock the second stub would never be fetched, and the test would
    // be asserting the cadence floor while claiming to assert the claim.
    vi.useFakeTimers();
    try {
      const { POST } = await freshRoute();
      stubUpstream(nowUs());
      expect((await (await POST(req({ fresh: true }))).json()).contended).toBe(false);
      expect((await (await POST(req({ fresh: true }))).json()).contended).toBe(true);

      vi.advanceTimersByTime(1100); // past the publish period, so a refresh is due
      stubUpstream(nowUs(1)); // and the feed has advanced one second
      expect((await (await POST(req({ fresh: true }))).json()).contended).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh caller inside the publish period does NOT trigger an upstream call", async () => {
    // THE PROPERTY. `fresh:true` is unauthenticated, and it used to mean "bypass the cache", so
    // one anonymous request loop spent Dominion's Pyth quota with no wallet, no gas and nothing
    // submitted. The upstream cadence is now a property of this module, not of the caller.
    vi.useFakeTimers();
    try {
      const { POST } = await freshRoute();
      stubUpstream(nowUs());
      expect((await POST(req({ fresh: true }))).status).toBe(200);
      const afterWarm = fetchSpy.mock.calls.length;
      expect(afterWarm).toBe(1);

      // Two hundred serialised fresh requests inside one publish period.
      for (let i = 0; i < 200; i++) {
        vi.advanceTimersByTime(4); // 800ms total, still inside the 1000ms period
        expect((await POST(req({ fresh: true }))).status).toBe(200);
      }
      expect(
        fetchSpy.mock.calls.length,
        "a caller must not be able to raise the upstream call rate",
      ).toBe(afterWarm);

      // Past the period, exactly one refresh is due.
      vi.advanceTimersByTime(1100);
      await POST(req({ fresh: true }));
      expect(fetchSpy.mock.calls.length).toBe(afterWarm + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never serves a submitter an envelope aged past the publish period", async () => {
    // The original purpose of `fresh` SURVIVES the change, in the form that is actually true: a
    // submitter is never handed a print older than one publish period, because past that a refresh is
    // due and happens. What changed is that the caller no longer FORCES the refresh; the clock does.
    vi.useFakeTimers();
    try {
      const { POST } = await freshRoute();
      stubUpstream(nowUs());
      expect((await POST(req({}))).status).toBe(200); // banner warms the cache
      expect(fetchSpy.mock.calls.length).toBe(1);

      vi.advanceTimersByTime(1100); // the cached print is now older than the publish period
      stubUpstream(nowUs(1));
      const res = await POST(req({ fresh: true }));
      expect(res.status).toBe(200);
      expect(
        fetchSpy.mock.calls.length,
        "a submitter was served a print older than the publish period",
      ).toBe(2);
      expect((await res.json()).contended).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh burst does not starve the banner, which keeps reading the cache for free", async () => {
    const { POST } = await freshRoute();
    stubUpstream(nowUs());
    await Promise.all(Array.from({ length: 20 }, () => POST(req({ fresh: true }))));

    const callsBefore = fetchSpy.mock.calls.length;
    let served = 0;
    for (let i = 0; i < 100; i++) {
      if ((await POST(req({}))).status === 200) served++;
    }
    expect(served, "the banner must still be served").toBe(100);
    expect(fetchSpy.mock.calls.length, "and from the cache, at no upstream cost").toBe(callsBefore);
  });

  it("an unparseable feed timestamp is never marked uncontended, and still serves", async () => {
    // A payload we cannot pin to a timestamp must not be presented as a clean print, and must not be
    // withheld either.
    const { POST } = await freshRoute();
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ solana: { encoding: "base64", data: "AAAA" }, parsed: { priceFeeds: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await POST(req({ fresh: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).contended).toBe(true);
  });

  it("an ABSURD future timestamp cannot poison the claim state for the instance's lifetime", async () => {
    // `lastClaimedFeedTsUs` only moves forward. Without an upper bound, one upstream response carrying
    // a nanosecond-scale or clock-skewed timestamp would mark every future print contended forever.
    vi.useFakeTimers();
    try {
      const { POST } = await freshRoute();
      stubUpstream(String(Date.now() * 1_000_000)); // nanoseconds, i.e. 1000x too large
      expect((await (await POST(req({ fresh: true }))).json()).contended).toBe(true);

      // A normal print afterwards must still be claimable, once a refresh is due.
      vi.advanceTimersByTime(1100);
      stubUpstream(nowUs());
      expect((await (await POST(req({ fresh: true }))).json()).contended).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
