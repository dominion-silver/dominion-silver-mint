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

  // ALIGNED WITH THE CHAIN, which is what the comment already claimed and the number contradicted.
  // `config.max_staleness_seconds` reads 15 on the live config; this said 30. So a quote between 16 and
  // 30 seconds old, already too stale for the program to accept, rendered in plain muted text as if it
  // were healthy. The submit path re-fetches a fresh envelope, so the consequence was a misleading
  // preview quote rather than a guaranteed revert, but the banner is the one place a user looks to judge
  // whether the price is trustworthy.
  // Hardcoded rather than read from config on purpose: this component only has the price, not the config
  // account, and adding a second chain read to a banner is worse than a constant that matches. If
  // max_staleness is ever changed by timelock, the readiness gate compares the two.
  const STALE_THRESHOLD = 15;
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
