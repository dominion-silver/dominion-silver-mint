// Fetch live Pyth XAG/USD price via Hermes HTTP API (off-chain, for display).
// On-chain the program reads via the Solana receiver program.

export interface SilverPrice {
  priceUsd: number; // USD per oz
  confidence: number;
  publishTime: number; // unix seconds
  ageSeconds: number;
}

const HERMES_BASE = "https://hermes.pyth.network";
const XAG_USD_FEED_ID = "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

export async function fetchSilverPrice(): Promise<SilverPrice> {
  const url = `${HERMES_BASE}/api/latest_price_feeds?ids[]=0x${XAG_USD_FEED_ID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pyth fetch failed: ${res.status}`);
  const data = await res.json();
  const feed = data[0];
  const p = feed.price;
  const priceUsd = Number(p.price) * Math.pow(10, Number(p.expo));
  const confidence = Number(p.conf) * Math.pow(10, Number(p.expo));
  const publishTime = Number(p.publish_time);
  const ageSeconds = Math.floor(Date.now() / 1000) - publishTime;
  return { priceUsd, confidence, publishTime, ageSeconds };
}

export function effectiveMintPrice(spot: number, premiumBps: number): number {
  return (spot * (10_000 + premiumBps)) / 10_000;
}

export function effectiveRedeemPrice(spot: number, premiumBps: number): number {
  // FE-L8: rename param from feeBps to premiumBps for unity with the rest
  // of the codebase (we call it "redeem premium" everywhere else).
  return (spot * (10_000 - premiumBps)) / 10_000;
}
