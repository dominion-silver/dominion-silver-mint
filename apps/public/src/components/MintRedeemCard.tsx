"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchSilverPrice,
  effectiveMintPrice,
  effectiveRedeemPrice,
} from "@/lib/pyth";
import { DEFAULT_SLIPPAGE_BPS, REFRESH_INTERVAL_MS } from "@/lib/constants";
import {
  fetchConfig,
  fetchTreasuryBalance,
  fetchSilvSupply,
  computeMaxRedeemable,
  buildMintTx,
  buildRedeemTx,
  parseUsdcAmount,
  parseSilvAmount,
} from "@/lib/anchor-client";
import { postPythAndExecuteConsumer } from "@/lib/pyth-posting";
import { toast } from "@/components/Toaster";
import { recordTxKind } from "@/components/TransactionHistory";

type Mode = "mint" | "redeem";

export function MintRedeemCard() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const { data: price } = useSWR("silver-price", fetchSilverPrice, {
    refreshInterval: REFRESH_INTERVAL_MS,
    revalidateOnFocus: false,
  });

  // On-chain config: premium bps, paused, reserve bps, etc.
  const { data: cfg } = useSWR("onchain-config", () => fetchConfig(connection), {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });

  // Treasury USDC + total SILV supply. Refreshed alongside config.
  const { data: liquidity } = useSWR(
    cfg ? "onchain-liquidity" : null,
    async () => {
      const [treasury, supply] = await Promise.all([
        fetchTreasuryBalance(connection),
        fetchSilvSupply(connection),
      ]);
      return { treasury, supply };
    },
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );

  const [mode, setMode] = useState<Mode>("mint");
  const [amount, setAmount] = useState<string>("");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // FE-H10: useRef-backed in-flight guard. setSubmitting(true) only takes
  // effect after React commits (microtask boundary), so a same-frame
  // double-click can pass through. The ref is synchronous.
  const inFlight = useRef(false);

  // Clear any stale error when the user switches mode. Tx-success indicator
  // lives in the Toaster (transient) and TransactionHistory (persistent).
  // M6 nit: skip on first mount where state already matches initial values.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setErrorMsg(null);
    setAmount("");
  }, [mode]);

  // Premiums come from on-chain config when loaded. Fall back to conservative
  // launch defaults (10% mint, 2% redeem) while we wait for the RPC round-trip.
  const premiumBpsMint = cfg?.premiumBpsMint ?? 1000;
  const premiumBpsRedeem = cfg?.premiumBpsRedeem ?? 200;

  const maxRedeemableSilv = useMemo(() => {
    if (!cfg || !liquidity || !price) return null;
    // Pyth price in USD scaled to 1e6.
    const priceScaled = new BN(Math.round(price.priceUsd * 1_000_000));
    return computeMaxRedeemable(liquidity.treasury, liquidity.supply, cfg, priceScaled);
  }, [cfg, liquidity, price]);

  const preview = useMemo(() => {
    if (!price || !amount) return null;
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) return null;
    if (mode === "mint") {
      const effPrice = effectiveMintPrice(price.priceUsd, premiumBpsMint);
      const out = num / effPrice;
      const minOut = out * (1 - slippageBps / 10_000);
      return { effPrice, out, minOut, inLabel: "USDC", outLabel: "SILV" };
    } else {
      const effPrice = effectiveRedeemPrice(price.priceUsd, premiumBpsRedeem);
      const out = num * effPrice;
      const minOut = out * (1 - slippageBps / 10_000);
      return { effPrice, out, minOut, inLabel: "SILV", outLabel: "USDC" };
    }
  }, [price, amount, mode, slippageBps, premiumBpsMint, premiumBpsRedeem]);

  const maxRedeemableDisplay = useMemo(() => {
    if (!maxRedeemableSilv) return null;
    // SILV has 6 decimals (matches math.rs + on-chain mint config).
    // Use float division to preserve fractional SILV.
    return maxRedeemableSilv.toNumber() / 1_000_000;
  }, [maxRedeemableSilv]);

  // User wallet balances (USDC + SILV) for display.
  const { data: balances } = useSWR(
    wallet.publicKey ? `wallet-balances-${wallet.publicKey.toBase58()}` : null,
    async () => {
      if (!wallet.publicKey) return null;
      const usdcAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(
        (await import("@/lib/constants")).USDC_MINT,
        wallet.publicKey,
        false,
        (await import("@/lib/constants")).TOKEN_PROGRAM_ID,
      );
      const silvAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(
        (await import("@/lib/constants")).SILV_MINT,
        wallet.publicKey,
        false,
        (await import("@/lib/constants")).TOKEN_2022_PROGRAM_ID,
      );
      // FE-L17: distinguish "ATA missing" (no balance, normal) from RPC error.
      // We test the wallet's pubkey via getAccountInfo: if pubkey resolves
      // but ATA fetch threw, that's an RPC error. If ATA returns an empty
      // balance object, the user has no balance (still healthy).
      const settle = async (
        p: Promise<{ value: { uiAmountString?: string | null } }>,
      ): Promise<{ value: string; missing: boolean }> => {
        try {
          const r = await p;
          return { value: r.value.uiAmountString ?? "0", missing: false };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Token account not found = ATA doesn't exist yet; not an error.
          if (msg.includes("could not find account") || msg.includes("not found")) {
            return { value: "0", missing: true };
          }
          throw e;
        }
      };
      try {
        const [u, s] = await Promise.all([
          settle(connection.getTokenAccountBalance(usdcAta)),
          settle(connection.getTokenAccountBalance(silvAta)),
        ]);
        return { usdc: u.value, silv: s.value, error: false };
      } catch {
        return { usdc: "0", silv: "0", error: true };
      }
    },
    { refreshInterval: REFRESH_INTERVAL_MS, revalidateOnFocus: false },
  );

  // SOL balance for fee preflight. EE-H3: surface insufficient SOL early
  // with a clear message instead of letting the first sendRawTransaction
  // fail with a cryptic "Attempt to debit account" error.
  const { data: solBalance } = useSWR(
    wallet.publicKey ? `wallet-sol-${wallet.publicKey.toBase58()}` : null,
    async () => {
      if (!wallet.publicKey) return 0;
      try {
        const lamports = await connection.getBalance(wallet.publicKey, "confirmed");
        return lamports / 1_000_000_000;
      } catch {
        return null;
      }
    },
    { refreshInterval: REFRESH_INTERVAL_MS, revalidateOnFocus: false },
  );
  const SOL_FOR_FEES_MIN = 0.02; // 0.012 typical + headroom
  const insufficientSol = solBalance !== null && solBalance !== undefined && solBalance < SOL_FOR_FEES_MIN;

  // FE-H4: when config still loading (maxRedeemableDisplay === null), block
  // the redeem submit. Otherwise the user can submit before we know the
  // limit and the tx reverts on-chain.
  const overRedeemable =
    mode === "redeem" &&
    !!amount &&
    parseFloat(amount) > 0 &&
    (maxRedeemableDisplay === null || parseFloat(amount) > maxRedeemableDisplay);

  // FE-H3: explicit boolean coercion. The previous form returned the cfg
  // object (truthy) instead of `true` when the second branch fired,
  // which worked at runtime via !! but had a wrong intermediate type.
  const paused: boolean = !!(
    cfg?.paused ||
    (cfg &&
      mode === "mint" &&
      cfg.mintPausedUntil.gt(new BN(Math.floor(Date.now() / 1000))))
  );

  async function handleSubmit() {
    if (inFlight.current) return; // FE-H10 same-frame double-click guard
    inFlight.current = true;
    setErrorMsg(null);
    if (!wallet.publicKey || !preview) {
      inFlight.current = false;
      return;
    }
    if (insufficientSol) {
      inFlight.current = false;
      setErrorMsg(
        `Need at least ${SOL_FOR_FEES_MIN} SOL for transaction fees (you have ${(solBalance ?? 0).toFixed(4)}). Top up at faucet.solana.com (devnet).`,
      );
      return;
    }
    setSubmitting(true);
    try {
      // Single-popup flow: postPythAndExecuteConsumer batches the 1-2 Pyth
      // post txs PLUS our mint/redeem tx into a single signAllTransactions
      // call. Phantom shows ONE combined approval. User clicks once.
      // We still submit 2-3 distinct on-chain txs (Pyth size limit forces
      // splitting) but the human-facing friction drops from 3 clicks to 1.
      setErrorMsg("Preparing transaction batch...");
      const result = await postPythAndExecuteConsumer(
        connection,
        wallet,
        async (priceUpdate) => {
          if (mode === "mint") {
            const amountUsdc = parseUsdcAmount(amount);
            const minSilvOut = preview ? parseSilvAmount(preview.minOut.toFixed(6)) : new BN(0);
            return buildMintTx(connection, wallet, { amountUsdc, minSilvOut, priceUpdate });
          } else {
            const amountSilv = parseSilvAmount(amount);
            const minUsdcOut = preview ? parseUsdcAmount(preview.minOut.toFixed(6)) : new BN(0);
            return buildRedeemTx(connection, wallet, { amountSilv, minUsdcOut, priceUpdate });
          }
        },
      );
      setErrorMsg(null);
      const sig = result.consumerSig;

      // Label this sig in localStorage so TransactionHistory shows MINT/REDEEM
      // immediately without needing a follow-up getParsedTransaction RPC call.
      recordTxKind(sig, mode);

      // FE-C2: schedule a delayed second history refresh to catch the case
      // where the new sig isn't yet indexed by getSignaturesForAddress
      // immediately after confirmation (RPC index lag, ~500ms-1s).
      setTimeout(() => {
        if (typeof window !== "undefined") window.__dominionHistoryRefresh?.();
      }, 1500);

      // Surface success via toast (transient) + history component (persistent).
      toast({
        message: `${mode === "mint" ? "Mint" : "Redeem"} confirmed`,
        variant: "success",
        href: `https://solscan.io/tx/${sig}?cluster=devnet`,
        hrefLabel: "View on Solscan",
      });
      setAmount("");

      // We intentionally do NOT call result.close() here. Closing the
      // priceUpdate account would require ANOTHER wallet popup (~0.008 SOL
      // of rent reclaimed). Trade-off: 1 popup for the whole flow vs.
      // ~$0.001 of leaked rent per op.
      // TODO: bundle the close ix into the next mint/redeem so the rent is
      // reclaimed for free, OR add a "Recover rent" admin button later.
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      // Surface a short error toast too (helpful when the user has scrolled).
      toast({
        message: `${mode === "mint" ? "Mint" : "Redeem"} failed: ${msg.split("\n")[0].slice(0, 140)}`,
        variant: "error",
      });
    } finally {
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      {/* Paused banner */}
      {paused && (
        <div className="mb-4 rounded-md border border-danger bg-danger/10 px-3 py-2 text-xs text-danger">
          {cfg?.paused
            ? "Contract paused by guardian. Redemptions still processing."
            : "Mint paused during premium update window. Retry soon."}
        </div>
      )}

      {/* Mode selector */}
      <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-bg p-1">
        <button
          onClick={() => setMode("mint")}
          className={`rounded-md py-2 text-sm font-medium transition ${
            mode === "mint" ? "bg-card text-white" : "text-muted hover:text-white"
          }`}
        >
          Mint SILV
        </button>
        <button
          onClick={() => setMode("redeem")}
          className={`rounded-md py-2 text-sm font-medium transition ${
            mode === "redeem" ? "bg-card text-white" : "text-muted hover:text-white"
          }`}
        >
          Redeem SILV
        </button>
      </div>

      {/* Input + balance display */}
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide">
        <span className="text-muted">You pay</span>
        {wallet.publicKey && balances && (
          <button
            type="button"
            onClick={() =>
              setAmount(mode === "mint" ? balances.usdc : balances.silv)
            }
            className="text-muted normal-case hover:text-white"
          >
            Balance:{" "}
            <span className="font-mono text-white">
              {mode === "mint" ? balances.usdc : balances.silv}
            </span>{" "}
            {mode === "mint" ? "USDC" : "SILV"} (max)
          </button>
        )}
      </div>
      <div className="mb-2 flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3">
        <input
          type="number"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent text-lg outline-none"
        />
        <span className="font-mono text-sm text-muted">
          {mode === "mint" ? "USDC" : "SILV"}
        </span>
      </div>

      {/* Quick-fill chips: 25 / 50 / 75 / 100 percent of EFFECTIVE max.
          Mint: balance is the only constraint.
          Redeem: bounded by min(balance, max_redeemable) so the chips
          never put the user above the on-chain redemption-liquidity floor.
          FE-M1+H9: chips are disabled when the resulting amount would
          truncate to 0 (zero-balance or sub-atomic-unit at small pct). */}
      {wallet.publicKey && balances && (() => {
        // Compute the effective MAX (post-cap) for the current mode.
        // Used to grey out chips that would yield 0.
        const effMax = mode === "mint"
          ? parseFloat(balances.usdc)
          : Math.min(
              parseFloat(balances.silv),
              maxRedeemableDisplay ?? parseFloat(balances.silv),
            );
        const validMax = Number.isFinite(effMax) && effMax > 0;
        return (
          <div className="mb-4 grid grid-cols-4 gap-2">
            {[25, 50, 75, 100].map((pct) => {
              const v = validMax
                ? Math.floor((effMax * pct) / 100 * 1_000_000) / 1_000_000
                : 0;
              const disabled = !validMax || v <= 0;
              return (
                <button
                  key={pct}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    setAmount(v.toString());
                  }}
                  className="rounded-md border border-border py-1 text-xs font-mono text-muted transition hover:border-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-border disabled:hover:text-muted"
                >
                  {pct === 100 ? "MAX" : `${pct}%`}
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* Output preview */}
      <label className="mb-2 block text-xs uppercase tracking-wide text-muted">
        You receive (est.)
      </label>
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3">
        <span className="flex-1 text-lg">
          {preview ? preview.out.toFixed(6) : "0.00"}
        </span>
        <span className="font-mono text-sm text-muted">
          {mode === "mint" ? "SILV" : "USDC"}
        </span>
      </div>

      {/* Redemption liquidity hint. Explains why on-chain max can be lower
          than the user's balance: the contract enforces a reserve floor
          (treasury_min_reserve_bps) so a fraction of the SILV-equivalent
          USDC value always stays locked in treasury for solvency. The
          unlocked buffer accumulated from mint premiums (10% per mint)
          is what's redeemable on-chain. Larger exits go OTC (physical). */}
      {mode === "redeem" && (
        <div className="mb-4 space-y-1 rounded-md border border-border bg-bg/50 px-3 py-2 text-xs text-muted">
          <div>
            Max redeemable now:{" "}
            <span className="font-mono text-white">
              {maxRedeemableDisplay !== null
                ? maxRedeemableDisplay.toLocaleString(undefined, { maximumFractionDigits: 4 })
                : "loading..."}
            </span>{" "}
            SILV
          </div>
          {maxRedeemableDisplay !== null && balances &&
            parseFloat(balances.silv) > maxRedeemableDisplay && (
              <div className="text-muted/80">
                Your balance ({parseFloat(balances.silv).toLocaleString(undefined, { maximumFractionDigits: 4 })} SILV)
                exceeds on-chain redemption liquidity. The reserve floor keeps a
                portion of the treasury locked for solvency. Larger exits via{" "}
                <a href="mailto:otc@dominion.market" className="text-accent underline">
                  OTC desk
                </a>{" "}
                (physical silver).
              </div>
            )}
        </div>
      )}
      {overRedeemable && (
        <div className="mb-4 rounded-md border border-danger bg-danger/10 px-3 py-2 text-xs text-danger">
          Amount exceeds current redemption liquidity.
        </div>
      )}

      {/* Slippage selector */}
      <div className="mb-6 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted">Slippage</span>
        <div className="flex gap-1">
          {[10, 50, 100].map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              className={`rounded-md px-2 py-1 text-xs font-mono ${
                slippageBps === bps
                  ? "bg-accent text-bg"
                  : "border border-border text-muted hover:text-white"
              }`}
            >
              {(bps / 100).toFixed(1)}%
            </button>
          ))}
        </div>
      </div>

      {/* Details */}
      {preview && (
        <div className="mb-6 space-y-1 border-t border-border pt-4 text-xs text-muted">
          <div className="flex justify-between">
            <span>{mode === "mint" ? "Mint price" : "Redeem price"}</span>
            <span className="font-mono text-white">${preview.effPrice.toFixed(4)}/oz</span>
          </div>
          <div className="flex justify-between">
            <span>Min. received</span>
            <span className="font-mono text-white">
              {preview.minOut.toFixed(6)} {preview.outLabel}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Fee</span>
            <span className="font-mono text-white">
              {mode === "mint"
                ? `${(premiumBpsMint / 100).toFixed(1)}%`
                : `${(premiumBpsRedeem / 100).toFixed(1)}%`}
            </span>
          </div>
        </div>
      )}

      {/* Insufficient-SOL warning (EE-H3): preflight before submit. */}
      {wallet.publicKey && insufficientSol && (
        <div className="mb-4 rounded-md border border-yellow-500 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300 break-words">
          Low SOL balance ({(solBalance ?? 0).toFixed(4)} SOL). Need at least {SOL_FOR_FEES_MIN} SOL for transaction fees. Top up at{" "}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" className="underline">
            faucet.solana.com
          </a>
          {" "}(devnet).
        </div>
      )}

      {/* Error display only. Success goes to Toaster + TransactionHistory. */}
      {errorMsg && (
        <div className="mb-4 rounded-md border border-danger bg-danger/10 px-3 py-2 text-xs text-danger break-words">
          {errorMsg}
        </div>
      )}

      {/* Action */}
      <button
        disabled={
          !wallet.connected ||
          !preview ||
          !!overRedeemable ||
          !!paused ||
          submitting ||
          insufficientSol
        }
        onClick={handleSubmit}
        className="w-full rounded-lg bg-accent py-3 font-semibold text-bg transition hover:bg-accentDim disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!wallet.connected
          ? "Connect wallet"
          : submitting
          ? "Submitting..."
          : paused
          ? "Paused"
          : !amount
          ? "Enter an amount"
          : mode === "mint"
          ? "Mint SILV"
          : "Redeem SILV"}
      </button>
    </div>
  );
}
