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
        Pyth Lazer price feed unavailable
      </div>
    );
  }

  // Align with on-chain max_staleness. The Lazer SILV feed updates ~every 1s, so
  // a healthy quote is a few seconds old at most; flag anything older.
  const STALE_THRESHOLD = 30;
  const stale = data && data.ageSeconds > STALE_THRESHOLD;
  return (
    <div className="border-b border-border bg-card px-6 py-2 text-center text-sm">
      <span className="text-muted">SILV/USD (Pyth Lazer):</span>{" "}
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
