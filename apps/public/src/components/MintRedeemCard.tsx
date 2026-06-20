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
  computeMaxInstantRedeemableUsdc,
  redeemUsdcOut,
  classifyRedeem,
  parseRedeemError,
  isQueuedNonceRaceError,
  isStaleOracleError,
  STALE_ORACLE_USER_MESSAGE,
  errorToText,
  fetchRedemptionRequests,
  buildRedeemQueuedTx,
  buildCloseSettledRedemptionTx,
  parseUsdcAmount,
  parseSilvAmount,
  type RedeemRoute,
  type RedemptionRequestView,
} from "@/lib/anchor-client";
import {
  buildLazerMintTx,
  buildLazerRedeemTx,
  buildLazerClaimTx,
} from "@/lib/lazer-tx";
import { fetchAndExecuteLazer } from "@/lib/lazer-execute";
import { toast } from "@/components/Toaster";
import { recordTxKind } from "@/components/TransactionHistory";

type Mode = "mint" | "redeem";

const OTC_EMAIL = "mark@dominion.market";

export function MintRedeemCard() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const { data: price } = useSWR("silver-price", fetchSilverPrice, {
    refreshInterval: REFRESH_INTERVAL_MS,
    revalidateOnFocus: false,
  });

  const { data: cfg } = useSWR("onchain-config", () => fetchConfig(connection), {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });

  // Treasury USDC (Option B: drives instant-redeem availability, not a reserve).
  const { data: treasury } = useSWR(
    cfg ? "onchain-treasury" : null,
    () => fetchTreasuryBalance(connection),
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );

  // The user's queued redemption requests (Pending panel).
  const { data: requests, mutate: refreshRequests } = useSWR(
    wallet.publicKey ? `redemptions-${wallet.publicKey.toBase58()}` : null,
    () => fetchRedemptionRequests(connection, wallet.publicKey!),
    { refreshInterval: 15_000, revalidateOnFocus: false },
  );

  const [mode, setMode] = useState<Mode>("mint");
  const [amount, setAmount] = useState<string>("");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Red is reserved for ERRORS. Progress/status text (e.g. "Preparing
  // transaction...") renders neutral so normal flow doesn't look alarming.
  const [msgIsError, setMsgIsError] = useState(false);
  const showProgress = (t: string) => {
    setErrorMsg(t);
    setMsgIsError(false);
  };
  const showError = (t: string) => {
    setErrorMsg(t);
    setMsgIsError(true);
  };
  const inFlight = useRef(false);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setErrorMsg(null);
    setAmount("");
  }, [mode]);

  const premiumBpsMint = cfg?.premiumBpsMint ?? 1000;
  const premiumBpsRedeem = cfg?.premiumBpsRedeem ?? 200;

  const preview = useMemo(() => {
    if (!price || !amount) return null;
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) return null;
    if (mode === "mint") {
      const effPrice = effectiveMintPrice(price.priceUsd, premiumBpsMint);
      const out = num / effPrice;
      const minOut = out * (1 - slippageBps / 10_000);
      return { effPrice, out, minOut, inLabel: "USDC", outLabel: "SILV" };
    }
    const effPrice = effectiveRedeemPrice(price.priceUsd, premiumBpsRedeem);
    const out = num * effPrice;
    const minOut = out * (1 - slippageBps / 10_000);
    return { effPrice, out, minOut, inLabel: "SILV", outLabel: "USDC" };
  }, [price, amount, mode, slippageBps, premiumBpsMint, premiumBpsRedeem]);

  // Option B: classify the redeem route (instant / queue / otc / disabled)
  // for the entered amount, so the UI tells the user up-front.
  const nowSecs = Math.floor(Date.now() / 1000);
  const redeemUsdcOutBn = useMemo(() => {
    if (mode !== "redeem" || !price || !amount) return null;
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) return null;
    const priceScaled1e9 = new BN(Math.round(price.priceUsd * 1e9));
    return redeemUsdcOut(
      parseSilvAmount(amount),
      priceScaled1e9,
      premiumBpsRedeem,
    );
  }, [mode, price, amount, premiumBpsRedeem]);

  const redeemRoute: RedeemRoute | null = useMemo(() => {
    if (mode !== "redeem" || !cfg || !treasury || !redeemUsdcOutBn) return null;
    return classifyRedeem(cfg, treasury, redeemUsdcOutBn, nowSecs);
  }, [mode, cfg, treasury, redeemUsdcOutBn, nowSecs]);

  // Max instantly-redeemable, shown as USDC (and approx SILV via price).
  const maxInstant = useMemo(() => {
    if (!cfg || !treasury) return null;
    const usdc = computeMaxInstantRedeemableUsdc(cfg, treasury, nowSecs);
    const usdcNum = usdc.toNumber() / 1e6;
    const silvApprox =
      price && price.priceUsd > 0
        ? usdcNum / effectiveRedeemPrice(price.priceUsd, premiumBpsRedeem)
        : null;
    return { usdcNum, silvApprox };
  }, [cfg, treasury, nowSecs, price, premiumBpsRedeem]);

  const { data: balances } = useSWR(
    wallet.publicKey ? `wallet-balances-${wallet.publicKey.toBase58()}` : null,
    async () => {
      if (!wallet.publicKey) return null;
      const spl = await import("@solana/spl-token");
      const consts = await import("@/lib/constants");
      const usdcAta = spl.getAssociatedTokenAddressSync(
        consts.USDC_MINT,
        wallet.publicKey,
        false,
        consts.TOKEN_PROGRAM_ID,
      );
      const silvAta = spl.getAssociatedTokenAddressSync(
        consts.SILV_MINT,
        wallet.publicKey,
        false,
        consts.TOKEN_2022_PROGRAM_ID,
      );
      const settle = async (
        p: Promise<{ value: { uiAmountString?: string | null } }>,
      ): Promise<string> => {
        try {
          const r = await p;
          return r.value.uiAmountString ?? "0";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("could not find account") || msg.includes("not found"))
            return "0";
          throw e;
        }
      };
      try {
        const [u, s] = await Promise.all([
          settle(connection.getTokenAccountBalance(usdcAta)),
          settle(connection.getTokenAccountBalance(silvAta)),
        ]);
        return { usdc: u, silv: s, error: false };
      } catch {
        return { usdc: "0", silv: "0", error: true };
      }
    },
    { refreshInterval: REFRESH_INTERVAL_MS, revalidateOnFocus: false },
  );

  const { data: solBalance } = useSWR(
    wallet.publicKey ? `wallet-sol-${wallet.publicKey.toBase58()}` : null,
    async () => {
      if (!wallet.publicKey) return 0;
      try {
        return (
          (await connection.getBalance(wallet.publicKey, "confirmed")) / 1e9
        );
      } catch {
        return null;
      }
    },
    { refreshInterval: REFRESH_INTERVAL_MS, revalidateOnFocus: false },
  );
  const SOL_FOR_FEES_MIN = 0.02;
  const insufficientSol =
    solBalance !== null &&
    solBalance !== undefined &&
    solBalance < SOL_FOR_FEES_MIN;

  const paused: boolean = !!(
    cfg?.paused ||
    (cfg &&
      mode === "mint" &&
      cfg.mintPausedUntil.gt(new BN(Math.floor(Date.now() / 1000))))
  );
  const redemptionsOff = !!(mode === "redeem" && cfg && !cfg.redemptionsEnabled);

  function afterTx(sig: string, label: string) {
    recordTxKind(sig, mode);
    setTimeout(() => {
      if (typeof window !== "undefined") window.__dominionHistoryRefresh?.();
    }, 1500);
    toast({
      message: `${label} confirmed`,
      variant: "success",
      href: `https://solscan.io/tx/${sig}?cluster=devnet`,
      hrefLabel: "View on Solscan",
    });
    setAmount("");
  }

  async function handleSubmit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrorMsg(null);
    if (!wallet.publicKey || !preview || !cfg) {
      inFlight.current = false;
      return;
    }
    if (insufficientSol) {
      inFlight.current = false;
      showError(
        `Need at least ${SOL_FOR_FEES_MIN} SOL for fees (you have ${(solBalance ?? 0).toFixed(4)}).`,
      );
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "mint") {
        showProgress("Preparing transaction...");
        const r = await fetchAndExecuteLazer(
          connection,
          wallet,
          (envelope, priceUsd) => {
            // Compute min_out off the ENVELOPE's own price (priceUsd) so the
            // slippage floor matches what the contract prices at; fall back to
            // the preview only if the proxy returned no price.
            const minSilvOut =
              priceUsd != null
                ? parseSilvAmount(
                    (
                      (parseFloat(amount) / effectiveMintPrice(priceUsd, premiumBpsMint)) *
                      (1 - slippageBps / 10_000)
                    ).toFixed(6),
                  )
                : parseSilvAmount(preview.minOut.toFixed(6));
            return buildLazerMintTx(connection, wallet, {
              amountUsdc: parseUsdcAmount(amount),
              minSilvOut,
              envelope,
            });
          },
        );
        setErrorMsg(null);
        afterTx(r.consumerSig, "Mint");
      } else {
        // Redeem routing (Option B §4.3).
        const route = redeemRoute;
        if (route === "disabled") {
          throw new Error(
            cfg.paused
              ? "Protocol paused. Redemptions are temporarily halted."
              : "Redemptions are currently disabled by the admin.",
          );
        }
        if (route === "otc") {
          throw new Error(
            `Treasury can't cover this on-chain right now. For this size, redeem via the OTC desk: ${OTC_EMAIL} (physical-silver settlement).`,
          );
        }
        if (route === "queue") {
          // Burn SILV now, claim USDC after T+3 at the price then. 1 popup,
          // no Pyth. Codex P2-02: next_redeem_request_nonce is global, so a
          // concurrent queued redeem can stale our nonce. The ONLY safe retry
          // signal is the contract's `NonceMismatch`, which provably reverts
          // BEFORE any SILV burn (redeem_queued.rs:99-101 require! precedes
          // the burn at :112; `config` is &mut so txs are write-serialized).
          // Each attempt reads a FRESH config (never the stale preflight cfg).
          // The amount is snapshotted ONCE so a mid-retry input edit cannot
          // change what gets burned vs what the user approved.
          const MAX_QUEUE_ATTEMPTS = 4;
          const amountSilvToBurn = parseSilvAmount(amount);
          let queued: { sig: string; delaySecs: number } | null = null;
          let lastErr: unknown = null;
          for (let attempt = 1; attempt <= MAX_QUEUE_ATTEMPTS; attempt++) {
            const freshCfg = await fetchConfig(connection);
            if (!freshCfg) throw new Error("Could not read protocol config.");
            showProgress(
              attempt === 1
                ? "Submitting queued redemption (burns SILV now)..."
                : `Another redemption was queued first - retrying (${attempt}/${MAX_QUEUE_ATTEMPTS})...`,
            );
            try {
              const tx = await buildRedeemQueuedTx(connection, wallet, {
                amountSilv: amountSilvToBurn,
                requestNonce: freshCfg.nextRedeemRequestNonce,
              });
              const signed = await wallet.signTransaction!(tx);
              const sig = await connection.sendRawTransaction(
                signed.serialize(),
                { skipPreflight: false, maxRetries: 3 },
              );
              const conf = await connection.confirmTransaction(
                {
                  signature: sig,
                  blockhash: tx.recentBlockhash!,
                  lastValidBlockHeight: tx.lastValidBlockHeight!,
                },
                "confirmed",
              );
              // confirmTransaction resolves on INCLUSION, not success. A
              // landed-but-reverted tx has a non-null err here. Never treat
              // that as success: fetch the program logs (carry the
              // `Error Code: NonceMismatch` line) and route it through the
              // same retry/throw decision as a thrown error.
              if (conf.value?.err != null) {
                const txInfo = await connection
                  .getTransaction(sig, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0,
                  })
                  .catch(() => null);
                const onChainErr = Object.assign(
                  new Error("Queued redemption reverted on-chain"),
                  {
                    logs: txInfo?.meta?.logMessages ?? [],
                    onChainErr: conf.value.err,
                  },
                );
                throw onChainErr;
              }
              queued = {
                sig,
                delaySecs: freshCfg.redeemQueueDelaySeconds ?? 259200,
              };
              break;
            } catch (qe) {
              lastErr = qe;
              // Only the contract's NonceMismatch is retryable (provably
              // pre-burn). Anything else (user-rejected, insufficient SILV,
              // paused mid-flight, any other on-chain revert) bubbles with
              // its real message - never a false "queued" success.
              if (
                !isQueuedNonceRaceError(qe) ||
                attempt === MAX_QUEUE_ATTEMPTS
              ) {
                throw qe;
              }
            }
          }
          if (!queued) {
            throw lastErr instanceof Error
              ? lastErr
              : new Error("Queued redemption failed after retries.");
          }
          setErrorMsg(null);
          recordTxKind(queued.sig, "redeem");
          toast({
            message: `Queued. Claimable in ~${Math.round(queued.delaySecs / 86400)} days.`,
            variant: "success",
            href: `https://solscan.io/tx/${queued.sig}?cluster=devnet`,
            hrefLabel: "View on Solscan",
          });
          setAmount("");
          refreshRequests();
        } else {
          // Instant path (Pyth-priced).
          showProgress("Preparing transaction...");
          const r = await fetchAndExecuteLazer(
            connection,
            wallet,
            (envelope, priceUsd) => {
              const minUsdcOut =
                priceUsd != null
                  ? parseUsdcAmount(
                      (
                        parseFloat(amount) *
                        effectiveRedeemPrice(priceUsd, premiumBpsRedeem) *
                        (1 - slippageBps / 10_000)
                      ).toFixed(6),
                    )
                  : parseUsdcAmount(preview.minOut.toFixed(6));
              return buildLazerRedeemTx(connection, wallet, {
                amountSilv: parseSilvAmount(amount),
                minUsdcOut,
                envelope,
              });
            },
          );
          setErrorMsg(null);
          afterTx(r.consumerSig, "Redeem");
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Flatten once (message + program logs + structured err): a
      // confirmed-but-reverted tx carries the signal in logs/onChainErr,
      // not just `.message`.
      const flat = errorToText(e);
      // StaleOracle (12004) takes priority on EVERY Pyth path (mint /
      // redeem / claim). pyth-posting already maps the simulation-revert
      // case to this copy; this also covers the confirmed-on-chain-revert
      // path (raw "Transaction reverted on-chain" + logs).
      const reroute =
        mode === "redeem" ? parseRedeemError(flat) : null;
      const friendly =
        isStaleOracleError(flat)
          ? STALE_ORACLE_USER_MESSAGE
          : reroute === "queue"
            ? "Instant budget just filled. Re-submit: it will route to the T+3 queue."
            : reroute === "otc"
              ? `Treasury can't cover this now. Redeem via OTC: ${OTC_EMAIL}.`
              : reroute === "disabled"
                ? "Redemptions are disabled / paused."
                : msg;
      showError(friendly);
      toast({
        message: `${mode === "mint" ? "Mint" : "Redeem"} failed: ${friendly.split("\n")[0].slice(0, 140)}`,
        variant: "error",
      });
    } finally {
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  async function handleClaim(req: RedemptionRequestView) {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrorMsg(null);
    try {
      const r = await fetchAndExecuteLazer(
        connection,
        wallet,
        (envelope) =>
          buildLazerClaimTx(connection, wallet, {
            request: req,
            envelope,
          }),
      );
      toast({
        message: "Redemption claimed",
        variant: "success",
        href: `https://solscan.io/tx/${r.consumerSig}?cluster=devnet`,
        hrefLabel: "View on Solscan",
      });
      refreshRequests();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Classify on the FLATTENED text (message + program logs +
      // structured err): a landed-but-reverted claim carries the signal
      // in logs/onChainErr, so the InsufficientTreasury -> OTC hint works
      // (CODEX P1-01).
      const flat = errorToText(e);
      const reroute = parseRedeemError(flat);
      const friendly = isStaleOracleError(flat)
        ? STALE_ORACLE_USER_MESSAGE
        : reroute === "otc"
          ? `Treasury can't cover this claim yet. It stays queued (on-chain IOU); contact ${OTC_EMAIL} for OTC settlement.`
          : msg;
      showError(friendly);
      toast({ message: `Claim failed: ${friendly.split("\n")[0].slice(0, 120)}`, variant: "error" });
    } finally {
      inFlight.current = false;
    }
  }

  // P2-03: the owner reclaims the PDA rent of a request the admin already
  // settled OTC (status SettledOffchain). No funds move, no oracle, no Pyth.
  async function handleCloseSettled(req: RedemptionRequestView) {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrorMsg(null);
    try {
      const tx = await buildCloseSettledRedemptionTx(connection, wallet, req);
      const signed = await wallet.signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const conf = await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: tx.recentBlockhash!,
          lastValidBlockHeight: tx.lastValidBlockHeight!,
        },
        "confirmed",
      );
      // confirmTransaction resolves on INCLUSION, not success: a
      // landed-but-reverted tx has a non-null err. Never treat that as
      // success (CODEX P1-01 pattern, mirrors the queued-redeem path).
      if (conf.value?.err != null) {
        throw new Error("Close reverted on-chain");
      }
      toast({
        message: "Request closed, rent reclaimed",
        variant: "success",
        href: `https://solscan.io/tx/${sig}?cluster=devnet`,
        hrefLabel: "View on Solscan",
      });
      refreshRequests();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showError(msg);
      toast({
        message: `Close failed: ${msg.split("\n")[0].slice(0, 120)}`,
        variant: "error",
      });
    } finally {
      inFlight.current = false;
    }
  }

  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const settled = (requests ?? []).filter(
    (r) => r.status === "settledOffchain",
  );

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      {(paused || redemptionsOff) && (
        <div className="mb-4 rounded-md border border-danger bg-danger/10 px-3 py-2 text-xs text-danger">
          {cfg?.paused
            ? "Protocol paused by guardian."
            : redemptionsOff
              ? "Redemptions are currently disabled by the admin."
              : "Mint paused during a premium-update window. Retry soon."}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-bg p-1">
        <button
          onClick={() => setMode("mint")}
          className={`rounded-md py-2 text-sm font-medium transition ${mode === "mint" ? "bg-card text-white" : "text-muted hover:text-white"}`}
        >
          Mint SILV
        </button>
        <button
          onClick={() => setMode("redeem")}
          className={`rounded-md py-2 text-sm font-medium transition ${mode === "redeem" ? "bg-card text-white" : "text-muted hover:text-white"}`}
        >
          Redeem SILV
        </button>
      </div>

      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide">
        <span className="text-muted">You pay</span>
        {wallet.publicKey && balances && (
          <button
            type="button"
            onClick={() => setAmount(mode === "mint" ? balances.usdc : balances.silv)}
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
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent text-lg outline-none"
        />
        <span className="font-mono text-sm text-muted">
          {mode === "mint" ? "USDC" : "SILV"}
        </span>
      </div>

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

      {/* Option B redeem routing hint. */}
      {mode === "redeem" && (
        <div className="mb-4 space-y-1 rounded-md border border-border bg-bg/50 px-3 py-2 text-xs text-muted">
          <div>
            Max instant now:{" "}
            <span className="font-mono text-white">
              {maxInstant
                ? `$${maxInstant.usdcNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                : "loading..."}
            </span>
            {maxInstant?.silvApprox != null && (
              <span>
                {" "}
                (≈{" "}
                {maxInstant.silvApprox.toLocaleString(undefined, {
                  maximumFractionDigits: 4,
                })}{" "}
                SILV)
              </span>
            )}
          </div>
          {redeemRoute && (
            <div
              className={
                redeemRoute === "instant"
                  ? "text-accent"
                  : redeemRoute === "queue"
                    ? "text-yellow-300"
                    : "text-danger"
              }
            >
              {redeemRoute === "instant" &&
                "This amount redeems INSTANTLY from the treasury."}
              {redeemRoute === "queue" &&
                `This amount is above the instant limit -> T+3 QUEUE: SILV is burned now, you claim USDC in ~${Math.round((cfg?.redeemQueueDelaySeconds ?? 259200) / 86400)} days at the price then.`}
              {redeemRoute === "otc" &&
                `Treasury can't cover this on-chain now -> redeem via the OTC desk (${OTC_EMAIL}).`}
              {redeemRoute === "disabled" && "Redemptions are disabled/paused."}
            </div>
          )}
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted">Slippage</span>
        <div className="flex gap-1">
          {[10, 50, 100].map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              className={`rounded-md px-2 py-1 text-xs font-mono ${slippageBps === bps ? "bg-accent text-bg" : "border border-border text-muted hover:text-white"}`}
            >
              {(bps / 100).toFixed(1)}%
            </button>
          ))}
        </div>
      </div>

      {preview && (
        <div className="mb-6 space-y-1 border-t border-border pt-4 text-xs text-muted">
          <div className="flex justify-between">
            <span>{mode === "mint" ? "Mint price" : "Redeem price"}</span>
            <span className="font-mono text-white">
              ${preview.effPrice.toFixed(4)}/oz
            </span>
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
          {/* Pyth Lazer rides the signed price inside the consumer tx (no
              separate temporary price account is posted), so the old Core
              price-account rent disclosure no longer applies. The only costs
              are the standard tx fee + a one-time token-account rent the first
              time you mint, both standard Solana costs. */}
        </div>
      )}

      {wallet.publicKey && insufficientSol && (
        <div className="mb-4 rounded-md border border-yellow-500 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300 break-words">
          Low SOL ({(solBalance ?? 0).toFixed(4)}). Need ≥ {SOL_FOR_FEES_MIN} SOL
          for fees. Top up at{" "}
          <a
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            faucet.solana.com
          </a>{" "}
          (devnet).
        </div>
      )}

      {errorMsg && (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-xs break-words ${
            msgIsError
              ? "border-danger bg-danger/10 text-danger"
              : "border-border bg-bg/50 text-muted"
          }`}
        >
          {errorMsg}
        </div>
      )}

      <button
        disabled={
          !wallet.connected ||
          !preview ||
          !!paused ||
          redemptionsOff ||
          redeemRoute === "otc" ||
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
              : redemptionsOff
                ? "Redemptions disabled"
                : !amount
                  ? "Enter an amount"
                  : mode === "mint"
                    ? "Mint SILV"
                    : redeemRoute === "queue"
                      ? "Queue redemption (T+3)"
                      : redeemRoute === "otc"
                        ? "Use OTC desk"
                        : "Redeem SILV"}
      </button>

      {/* Pending queued redemptions. */}
      {wallet.publicKey && pending.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-muted">
            Pending redemptions ({pending.length})
          </div>
          <div className="space-y-2">
            {pending.map((r) => {
              const claimable = nowSecs >= r.claimableAt;
              const inDays = Math.max(
                0,
                Math.ceil((r.claimableAt - nowSecs) / 86400),
              );
              return (
                <div
                  key={r.pubkey.toBase58()}
                  className="flex items-center justify-between rounded-md border border-border bg-bg/50 px-3 py-2 text-xs"
                >
                  <div>
                    <div className="font-mono text-white">
                      {(r.amountSilv.toNumber() / 1e6).toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}{" "}
                      SILV
                    </div>
                    <div className="text-muted">
                      {claimable
                        ? "Ready to claim (priced at claim)"
                        : `Claimable in ~${inDays} day(s)`}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!claimable || submitting}
                    onClick={() => handleClaim(r)}
                    className="rounded-md bg-accent px-3 py-1 font-semibold text-bg transition hover:bg-accentDim disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    Claim
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[11px] text-muted/80">
            If the treasury can&apos;t cover a claim, it stays queued (on-chain
            IOU); contact{" "}
            <a href={`mailto:${OTC_EMAIL}`} className="text-accent underline">
              {OTC_EMAIL}
            </a>{" "}
            for OTC settlement.
          </div>
        </div>
      )}

      {/* P2-03: requests settled OTC by the desk. The owner reclaims the
          small PDA rent (no funds move, no oracle). */}
      {wallet.publicKey && settled.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-muted">
            Settled (reclaim rent) ({settled.length})
          </div>
          <div className="space-y-2">
            {settled.map((r) => (
              <div
                key={r.pubkey.toBase58()}
                className="flex items-center justify-between rounded-md border border-border bg-bg/50 px-3 py-2 text-xs"
              >
                <div>
                  <div className="font-mono text-white">
                    {(r.amountSilv.toNumber() / 1e6).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}{" "}
                    SILV
                  </div>
                  <div className="text-muted">
                    Settled off-chain. You were paid by the OTC desk.
                  </div>
                </div>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => handleCloseSettled(r)}
                  className="rounded-md bg-accent px-3 py-1 font-semibold text-bg transition hover:bg-accentDim disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Close
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-muted/80">
            This only frees the small Solana rent of the request account. Your
            redemption was already settled by the desk.
          </div>
        </div>
      )}
    </div>
  );
}
