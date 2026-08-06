// Live SILV/USD price for display + the mint/redeem preview. Fetched from the
// SAME feed the contract uses on-chain: Metal.Index.SILVER/USD (id 3154), via
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
 * The all-in price per ounce a minter actually pays: `spot / (1 - bps/1e4)`.
 *
 * NOT `spot * (1 + bps/1e4)`, which is what this returned until 2026-08-05 and which no longer
 * describes the contract. The program takes the premium OFF THE TOP of the incoming USDC and
 * mints the remainder at pure spot (math.rs::fee_from_amount, mint_silv.rs step 7):
 *
 *   silv_out = (amount - amount*bps/1e4) / spot
 *            = amount * (1 - bps/1e4) / spot
 *   price    = amount / silv_out
 *            = spot / (1 - bps/1e4)
 *
 * The old form under-priced by exactly `bps^2/1e8`, so the quote promised more SILV than the
 * program mints. That is 1 bp at the launch 1%, harmless in itself, but it scales with the SQUARE
 * of the premium: 25 bps at the 500 bps ceiling. Since the slippage selector's minimum is 10 bps,
 * the old formula meant that above roughly 317 bps of mint premium EVERY mint would revert
 * SlippageExceeded, and the premium is 24h-timelock changeable, so that was one executed proposal
 * away from breaking mint entirely.
 *
 * Presentation note, not fixed here: the fee is still shown to users as a marked-up price rather
 * than as the explicit off-the-top fee the contract now charges. The number is right; the framing
 * is a separate UI change.
 */
export function effectiveMintPrice(spot: number, premiumBps: number): number {
  return (spot * 10_000) / (10_000 - premiumBps);
}

/**
 * The price per ounce a redeemer actually receives: `spot * (1 - bps/1e4)`.
 *
 * UNCHANGED, and verified against the new contract rather than assumed. The program computes
 * `gross = silv * spot` then subtracts `gross * bps/1e4`, so what the user receives per ounce is
 * `spot * (1 - bps/1e4)`: exactly this. The two sides are asymmetric in FORM (the mint fee is on
 * the input, the redeem fee is on the output) even though both are "1% of what flows through",
 * which is why only the mint helper needed fixing.
 */
export function effectiveRedeemPrice(spot: number, premiumBps: number): number {
  // FE-L8: rename param from feeBps to premiumBps for unity with the rest
  // of the codebase (we call it "redeem premium" everywhere else).
  return (spot * (10_000 - premiumBps)) / 10_000;
}

/** Floor a float to 6 decimals as a string, for feeding `minOut` into the program.
 *
 * `toFixed(6)` rounds HALF UP, which is the WRONG direction for a slippage FLOOR: it can push
 * `minSilvOut` above what the program mints and turn a valid transaction into a hard
 * SlippageExceeded. The review-of-fixes brute-forced it: 25,025 (bps, slippage, amount)
 * combinations failed, all at amounts at or below $0.0288, because half-up rounding adds up to 0.5
 * atomic on top of the ~1.02 atomic gap left by the program's two floors, and a 10 bps buffer only
 * absorbs that once the quote exceeds roughly 1,500 atomic units.
 *
 * Lives here rather than in the component so the parity test can exercise the SAME code the
 * transaction builder uses. A test that reimplements the rounding would prove nothing about it. */
export function floor6(n: number): string {
  return (Math.floor(n * 1e6) / 1e6).toFixed(6);
}
