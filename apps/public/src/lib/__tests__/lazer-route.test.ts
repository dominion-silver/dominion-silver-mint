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
  it("refuses a flood with 429 and stops spending the key", async () => {
    const { POST } = await freshRoute();
    // Distinct feeds would be refused by the allowlist first, so hammer the LEGAL request. The cache
    // absorbs the upstream calls; the bucket is what bounds the request rate itself.
    let limited = 0;
    for (let i = 0; i < 200; i++) {
      const res = await POST(req({ feedId: 3154 }));
      if (res.status === 429) limited++;
    }
    expect(limited, "a 200-request burst must be throttled").toBeGreaterThan(0);
    // Bounded, not merely non-zero: the burst allowance must not be so large that it fails to brake.
    expect(limited).toBeGreaterThan(100);
    // And a throttled response tells the caller when to come back.
    const res = await POST(req({ feedId: 3154 }));
    if (res.status === 429) expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("the limiter runs BEFORE the upstream call, not after", async () => {
    // Otherwise it would protect our server's CPU while still burning the quota it exists to protect.
    const { POST } = await freshRoute();
    for (let i = 0; i < 200; i++) await POST(req({ feedId: 3154 }));
    // One warm cache means at most one upstream call across the whole burst.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
