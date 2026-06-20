// Live SILV/USD price for display + the mint/redeem preview. Fetched from the
// SAME feed the contract uses on-chain: the Pyth Lazer SILV feed (id 3304), via
// our same-origin /api/lazer proxy (which holds the API key). NOT the retired
// Core XAG/USD Hermes feed - showing a different price than the contract mints at
// would mislead the preview and risk a slippage revert.

export interface SilverPrice {
  priceUsd: number; // USD per SILV
  confidence: number;
  publishTime: number; // unix seconds
  ageSeconds: number;
}

export async function fetchSilverPrice(): Promise<SilverPrice> {
  const res = await fetch("/api/lazer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}", // default feed = SILV (3304)
  });
  if (res.status === 503) throw new Error("Pyth Lazer is not configured yet");
  if (!res.ok) throw new Error(`Lazer price fetch failed: ${res.status}`);
  const { price } = (await res.json()) as {
    price: { priceUsd: number; confidence: number; publishTimeSec: number } | null;
  };
  if (!price) throw new Error("Lazer returned no price");
  return {
    priceUsd: price.priceUsd,
    confidence: price.confidence,
    publishTime: price.publishTimeSec,
    // clamp: a small client/server clock skew could otherwise show "-1s ago".
    ageSeconds: Math.max(0, Math.floor(Date.now() / 1000) - price.publishTimeSec),
  };
}

export function effectiveMintPrice(spot: number, premiumBps: number): number {
  return (spot * (10_000 + premiumBps)) / 10_000;
}

export function effectiveRedeemPrice(spot: number, premiumBps: number): number {
  // FE-L8: rename param from feeBps to premiumBps for unity with the rest
  // of the codebase (we call it "redeem premium" everywhere else).
  return (spot * (10_000 - premiumBps)) / 10_000;
}
