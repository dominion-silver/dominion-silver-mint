"use client";

import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import useSWR from "swr";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SILV_MINT, TOKEN_2022_PROGRAM_ID, solscanTx } from "@/lib/constants";

/**
 * Last N signatures touching the user's SILV ATA = Dominion mint/redeem
 * activity. Single RPC call to getSignaturesForAddress(silvAta).
 * Kind labelling (mint vs redeem):
 *  - First we read a localStorage cache where MintRedeemCard wrote
 *    { sig: "mint" | "redeem" } at submission time.
 *  - For sigs not in the cache (older txs from another session), we
 *    lazily fetch their parsed tx ONCE, parse the program log for
 *    "Instruction: MintSilv" / "Instruction: RedeemSilv", and write
 *    the label to the cache. Subsequent loads are local.
 * Cache lookups are synchronous in localStorage (cheap). RPC fetches
 * are batched lazily and capped at 10 per page load to stay below
 * devnet public RPC limits.
 */
const LIMIT = 10;
const CACHE_KEY = "dominion-tx-kinds-v1";
const CACHE_MAX_ENTRIES = 1000; // FE-M11: LRU evict at this size.

type TxKind = "mint" | "redeem" | "unknown";

function readCache(): Record<string, TxKind> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "{}");
  } catch {
    // FE-M12: poisoned localStorage entry: reset so we don't loop forever.
    try {
      window.localStorage.removeItem(CACHE_KEY);
    } catch {
      // ignore
    }
    return {};
  }
}

function writeCache(c: Record<string, TxKind>) {
  if (typeof window === "undefined") return;
  try {
    // FE-M11: LRU-trim if over cap. Keys aren't ordered by recency in a
    // plain object, but JS preserves insertion order on string keys, so
    // we keep the LAST N which is approximately "most recently written".
    const entries = Object.entries(c);
    const trimmed: Record<string, TxKind> = entries.length > CACHE_MAX_ENTRIES
      ? Object.fromEntries(entries.slice(-CACHE_MAX_ENTRIES))
      : c;
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage might be full / blocked; fail silently.
  }
}

/**
 * Public helper: MintRedeemCard calls this on tx success to label sigs
 * proactively (no extra RPC needed).
 */
export function recordTxKind(signature: string, kind: TxKind) {
  const cache = readCache();
  cache[signature] = kind;
  writeCache(cache);
  if (typeof window !== "undefined") {
    window.__dominionHistoryRefresh?.();
  }
}

export function TransactionHistory() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const { data, isLoading, mutate } = useSWR(
    wallet.publicKey ? `tx-history-${wallet.publicKey.toBase58()}` : null,
    async () => {
      if (!wallet.publicKey) return [];
      // Query against user's SILV ATA (every mint/redeem touches it; cheap).
      // FE-H8 noted this misses failed mints where the ATA wasn't yet created.
      // Trade-off: switching to user pubkey would 3x the RPC load and
      // re-introduce the 429 we previously fixed. Failed mints already
      // surface via the error toast at submit time. DEFER per REVIEW_REPORT.
      const silvAta = getAssociatedTokenAddressSync(
        SILV_MINT,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const sigs = await connection.getSignaturesForAddress(silvAta, {
        limit: LIMIT,
      });
      const cache = readCache();
      // Identify sigs we don't yet have a label for.
      const missing = sigs
        .filter((s) => !s.err && !cache[s.signature])
        .map((s) => s.signature);

      // Lazy fetch parsed tx for missing sigs, sequential with small delay
      // to avoid 429 on devnet public RPC.
      for (const sig of missing) {
        try {
          const tx = await connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          const logs = tx?.meta?.logMessages ?? [];
          let kind: TxKind = "unknown";
          if (logs.some((l) => l.includes("Instruction: MintSilv"))) kind = "mint";
          else if (logs.some((l) => l.includes("Instruction: RedeemSilv"))) kind = "redeem";
          cache[sig] = kind;
          // Yield to avoid hammering the RPC.
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          // Best-effort: skip on individual fetch failure.
        }
      }
      writeCache(cache);

      return sigs.map((s) => ({
        signature: s.signature,
        blockTime: s.blockTime ?? null,
        err: s.err,
        kind: (cache[s.signature] ?? "unknown") as TxKind,
      }));
    },
    {
      refreshInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30_000,
    },
  );

  // FE-H7: wire the global refresh hook in useEffect (was in render body
  // and reassigning every render created a leaky pattern).
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__dominionHistoryRefresh = mutate;
    return () => {
      if (window.__dominionHistoryRefresh === mutate) {
        delete window.__dominionHistoryRefresh;
      }
    };
  }, [mutate]);

  // FE-L21: debounce manual refresh so rapid clicks don't fire N RPC calls.
  const [refreshing, setRefreshing] = useState(false);
  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await mutate();
    } finally {
      setRefreshing(false);
    }
  }

  if (!wallet.publicKey) return null;

  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium uppercase tracking-wide text-muted">
          Your activity
        </h3>
        <button
          onClick={onRefresh}
          disabled={refreshing || isLoading}
          className="text-xs text-muted hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
        >
          {refreshing || isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {(!data || data.length === 0) && !isLoading && (
        <p className="text-xs text-muted">
          No transactions yet. Mint or redeem to see your history here.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((entry) => (
            <li
              key={entry.signature}
              className="flex items-center justify-between rounded-md border border-border bg-bg px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    entry.err
                      ? "bg-danger"
                      : entry.kind === "mint"
                      ? "bg-accent"
                      : entry.kind === "redeem"
                      ? "bg-yellow-500"
                      : "bg-muted"
                  }`}
                  aria-hidden
                />
                <span className="font-mono uppercase">
                  {entry.err ? "FAILED" : entry.kind}
                </span>
                <span className="text-muted">
                  {entry.blockTime
                    ? new Date(entry.blockTime * 1000).toLocaleString()
                    : "pending"}
                </span>
              </div>
              <a
                href={solscanTx(entry.signature)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent hover:underline"
              >
                {entry.signature.slice(0, 6)}...{entry.signature.slice(-6)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
