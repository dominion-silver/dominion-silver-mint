"use client";

import useSWR from "swr";
import { fetchSilverPrice } from "@/lib/pyth";
import { REFRESH_INTERVAL_MS } from "@/lib/constants";

export function PriceBanner() {
  const { data, error } = useSWR("silver-price", fetchSilverPrice, {
    refreshInterval: REFRESH_INTERVAL_MS,
    revalidateOnFocus: false,
  });

  if (error) {
    return (
      <div className="border-b border-border bg-card px-6 py-2 text-center text-sm text-danger">
        Pyth price feed unavailable
      </div>
    );
  }

  // FE-L6: align with on-chain max_staleness_seconds. Currently 90s on
  // devnet (commit 9436908). Mainnet will be 15s default. The banner
  // shows "stale" once the off-chain quote is older than what the
  // contract would accept on-chain.
  const STALE_THRESHOLD = 30; // conservative; below devnet 90, near mainnet 15 + ~Hermes lag
  const stale = data && data.ageSeconds > STALE_THRESHOLD;
  return (
    <div className="border-b border-border bg-card px-6 py-2 text-center text-sm">
      <span className="text-muted">XAG/USD (Pyth):</span>{" "}
      <span className="font-mono font-semibold text-accent">
        {data ? `$${data.priceUsd.toFixed(4)}` : "..."}
      </span>
      {data && (
        <span className={`ml-2 text-xs ${stale ? "text-warning" : "text-muted"}`}>
          {data.ageSeconds}s ago
        </span>
      )}
    </div>
  );
}
