// Live SILV/USD for display and for the mint/redeem preview, from the SAME feed the contract prices
// from on-chain: Lazer 3154 (Metal.Index.SILVER/USD) via the same-origin /api/lazer proxy, which holds
// the API key. Quoting any other source would mislead the preview and risk a slippage revert.

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
    body: "{}", // default feed = Metal.Index.SILVER/USD (3154)
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

/**
 * All-in USD per ounce a minter pays: `spot / (1 - bps/1e4)`, NOT `spot * (1 + bps/1e4)`. The program
 * takes the premium OFF THE TOP of the incoming USDC and mints the remainder at pure spot
 * (math.rs::fee_from_amount). The multiplicative form under-prices by `bps^2/1e8`, promising more SILV
 * than the program mints; past roughly 317 bps of premium that exceeds the slippage selector's 10 bps
 * minimum and every mint reverts.
 */
export function effectiveMintPrice(spot: number, premiumBps: number): number {
  return (spot * 10_000) / (10_000 - premiumBps);
}

/**
 * USD per ounce a redeemer receives: `spot * (1 - bps/1e4)`. Asymmetric with the mint side in FORM
 * only: the redeem fee comes off the OUTPUT (`gross = silv * spot`, minus `gross * bps/1e4`), the mint
 * fee off the input.
 */
export function effectiveRedeemPrice(spot: number, premiumBps: number): number {
  return (spot * (10_000 - premiumBps)) / 10_000;
}

/** Floor a float to 6 decimals as a string, for feeding `minOut` into the program. Must FLOOR:
 *  `toFixed(6)` rounds half UP, the wrong direction for a slippage floor, and at small amounts that
 *  pushes `minSilvOut` above what the program mints and reverts SlippageExceeded. Lives here rather
 *  than in the component so the parity test exercises the SAME code the tx builder uses. */
export function floor6(n: number): string {
  return (Math.floor(n * 1e6) / 1e6).toFixed(6);
}
