/**
 * Fetch a REAL signed Pyth Lazer envelope for the SILV feed.
 *
 * Extracted from scripts/e2e-lazer-mint.ts on 2026-08-11 so a second live-cluster test could use it
 * without a second copy. That script calls `main()` unconditionally at module scope, so it cannot be
 * imported; copying the fetcher instead would have put the feed id, the channel and the property list
 * in two places, and this repo has been bitten by two-copies-of-one-truth repeatedly.
 *
 * PYTH_LAZER_KEY must be set. The key needs the `pyth-indices` entitlement for feed 3154, which is the
 * same entitlement the app's /api/lazer route needs in production.
 */

/** Metal.Index.SILVER/USD, pure spot. Confirmed 2026-07-26 and pinned in the manifest. */
export const SILV_FEED_ID = 3154;

export async function fetchSilvEnvelope(): Promise<{ envelope: Uint8Array; priceUsd: number }> {
  if (!process.env.PYTH_LAZER_KEY) {
    throw new Error(
      "PYTH_LAZER_KEY is not set. The envelope is SIGNED by Lazer, so there is no offline substitute: " +
        "without it this test cannot exercise the priced path at all.",
    );
  }
  const resp = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.PYTH_LAZER_KEY}`,
    },
    body: JSON.stringify({
      priceFeedIds: [SILV_FEED_ID],
      properties: ["price", "exponent", "publisherCount", "confidence", "feedUpdateTimestamp"],
      chains: ["solana"],
      channel: "fixed_rate@1000ms",
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = await resp.json();
  if (!j?.solana?.data) throw new Error("no envelope: " + JSON.stringify(j).slice(0, 300));
  const f = j.parsed.priceFeeds[0];
  const priceUsd = Number(f.price) * Math.pow(10, Number(f.exponent));
  console.log(
    "  SILV price: $" + priceUsd.toFixed(5),
    "| publishers:",
    f.publisherCount,
    "| feed_ts==ts:",
    f.feedUpdateTimestamp === Number(j.parsed.timestampUs),
  );
  return { envelope: new Uint8Array(Buffer.from(j.solana.data, "base64")), priceUsd };
}
