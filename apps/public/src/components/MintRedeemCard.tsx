"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchSilverPrice,
  effectiveMintPrice,
  floor6,
  effectiveRedeemPrice,
} from "@/lib/pyth";
import {
  DEFAULT_SLIPPAGE_BPS,
  REFRESH_INTERVAL_MS,
  SOL_TOPUP_URL,
  solscanTx,
} from "@/lib/constants";
import {
  fetchConfig,
  fetchTreasuryBalance,
  computeMaxInstantRedeemableUsdc,
  redeemGrossUsdc,
  classifyRedeem,
  parseRedeemError,
  isStaleOracleError,
  STALE_ORACLE_USER_MESSAGE,
  errorToText,
  parseUsdcAmount,
  parseSilvAmount,
  type RedeemRoute,
} from "@/lib/anchor-client";
import {
  buildLazerMintTx,
  buildLazerRedeemTx,
  resolveWalletFlags,
  effectivePremiumBps,
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

  // AUDIT finding A-26: these used to fall back to 1000 / 200 bps when `cfg` had
  // not loaded. The live mint premium is 150 bps, so the fallback quoted a price
  // 6.7x too expensive and, worse, fed that wrong premium into the min_out the
  // transaction actually enforces. Quote nothing until the real config is in
  // hand: `null` propagates through every memo and disables the preview.
  const configuredBpsMint = cfg?.premiumBpsMint ?? null;
  const configuredBpsRedeem = cfg?.premiumBpsRedeem ?? null;

  const nowSecs = Math.floor(Date.now() / 1000);

  // The caller's on-chain per-wallet accounts. Needed so `classifyRedeem` can answer the KYC
  // question for THIS wallet instead of only reporting that the gate is armed. Cheap: one batched
  // RPC call, and only meaningful once an admin arms the gate.
  //
  // `error` is destructured DELIBERATELY. Making the resolver throw only helps if somebody reads the
  // throw, and the first version of this fix ignored `error`, so a failed read was invisible: the
  // route silently fell back to whatever `undefined` implies and the fee-exemption line just never
  // appeared. The punch list claimed this call site surfaced the error before it actually did.
  const { data: walletFlags, error: walletFlagsError } = useSWR(
    wallet.publicKey ? `wallet-flags-${wallet.publicKey.toBase58()}` : null,
    () => resolveWalletFlags(connection, wallet.publicKey!),
    { refreshInterval: 30_000, keepPreviousData: true },
  );
  // Tri-state, and the third state has to stay reachable: `undefined` means NOT KNOWN, which
  // `classifyRedeem` turns into the "kyc" route whenever the gate is armed (`kycAttested !== true`).
  // That is the fail-closed direction, so an RPC failure blocks rather than promising an instant
  // redeem the chain would revert.
  const kycAttested = walletFlags ? walletFlags.kyc != null : undefined;

  // AUDIT FINDING P-07. The premiums the quote uses are the ones THIS WALLET pays, not the global
  // config values. The exemption PDA was already being loaded and its contents were simply never read,
  // so a wallet whitelisted on mint was shown "1% fee" and an understated SILV output while the program
  // would charge 0%. The user could not verify the commercial terms granted to them before signing.
  //
  // `effectivePremiumBps` mirrors `state/fee_exempt.rs::effective_premium_bps`, including treating a
  // zero expiry as expired (audit C-01). Falling back to the CONFIGURED bps whenever the exemption is
  // unknown is the safe direction: quoting 0% and then being charged the premium would mint less SILV
  // than the quote promised, and `minSilvOut` is derived from this same number, so an over-optimistic
  // quote becomes a hard SlippageExceeded rather than a small surprise.
  const premiumBpsMint =
    configuredBpsMint === null
      ? null
      : effectivePremiumBps(
          configuredBpsMint,
          walletFlags?.feeExemptFlags ?? null,
          walletFlags?.feeExemptExpiresAt ?? null,
          "mint",
          nowSecs,
        );
  const premiumBpsRedeem =
    configuredBpsRedeem === null
      ? null
      : effectivePremiumBps(
          configuredBpsRedeem,
          walletFlags?.feeExemptFlags ?? null,
          walletFlags?.feeExemptExpiresAt ?? null,
          "redeem",
          nowSecs,
        );
  /** True when this wallet's quote is discounted, so the UI can say so instead of silently differing. */
  const exemptSide =
    premiumBpsMint === 0 && premiumBpsRedeem === 0
      ? "both"
      : premiumBpsMint === 0
        ? "mint"
        : premiumBpsRedeem === 0
          ? "redeem"
          : null;


  const preview = useMemo(() => {
    if (!price || !amount) return null;
    // A-26: no quote without the real premium (no fallback).
    if (premiumBpsMint === null || premiumBpsRedeem === null) return null;
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

  // Option B: classify the redeem route (instant / limit / otc / kyc / disabled)
  // for the entered amount, so the UI tells the user up-front.
  // TWO figures, deliberately named apart, because conflating them was bug B2.
  //   GROSS = what leaves the treasury = what the program debits the budget by and checks
  //           solvency against.
  //   NET   = what the user receives = gross minus the premium.
  // Every comparison against a protocol limit uses GROSS, which is what this memo produces. The
  // previous version passed the NET into `classifyRedeem`, understating both checks by the redeem
  // premium (1.5% at launch), so near either boundary the UI promised "instant" and the chain
  // reverted. TypeScript cannot catch that: both are BN.
  //
  // The displayed "You receive" net comes from the float `preview` path above
  // (`effectiveRedeemPrice`), NOT from a BN. That is deliberate. `redeemUsdcOut` (the exact BN net,
  // bit-for-bit with the program) is still exercised by contract-parity.test.ts, but nothing in the
  // UI needs atomic precision on a figure already labelled "(est.)", and keeping a second unused
  // net in this component is what produced the dead binding this cleanup removed.
  const redeemGross = useMemo(() => {
    if (mode !== "redeem" || !price || !amount) return null;
    if (premiumBpsRedeem === null) return null; // A-26
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) return null;
    const priceScaled1e9 = new BN(Math.round(price.priceUsd * 1e9));
    return redeemGrossUsdc(parseSilvAmount(amount), priceScaled1e9);
  }, [mode, price, amount, premiumBpsRedeem]);

  const redeemRoute: RedeemRoute | null = useMemo(() => {
    if (mode !== "redeem" || !cfg || !treasury || !redeemGross) return null;
    // GROSS, not net. See the note above.
    return classifyRedeem(cfg, treasury, redeemGross, nowSecs, kycAttested);
  }, [mode, cfg, treasury, redeemGross, nowSecs, kycAttested]);

  // Max instantly-redeemable, shown as USDC (and approx SILV via price).
  const maxInstant = useMemo(() => {
    if (!cfg || !treasury) return null;
    const usdc = computeMaxInstantRedeemableUsdc(cfg, treasury, nowSecs);
    const usdcNum = usdc.toNumber() / 1e6;
    // `usdc` is the NET the user receives. The SILV that produces it is gross/spot, and
    // gross = net / (1 - bps/1e4), so divide the net by spot*(1-bps/1e4). That is what
    // `effectiveRedeemPrice` returns, and it is exact rather than approximate now that the
    // program takes the fee off the top of the gross.
    const silvApprox =
      price && price.priceUsd > 0 && premiumBpsRedeem !== null
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
  // Launch posture: the redeployed program ships with public direct mint
  // CLOSED (`public_mint_enabled=false` -> `mint_silv` reverts
  // PublicMintDisabled). At launch users trade SILV on a DEX instead of
  // minting/redeeming directly. Gate the CTA so a click can't hit the revert.
  const mintDisabled = !!(mode === "mint" && cfg && !cfg.publicMintEnabled);
  // Either direction's DIRECT path is closed for the current mode.
  const directClosed = mintDisabled || redemptionsOff;

  function afterTx(sig: string, label: string) {
    recordTxKind(sig, mode);
    setTimeout(() => {
      if (typeof window !== "undefined") window.__dominionHistoryRefresh?.();
    }, 1500);
    toast({
      message: `${label} confirmed`,
      variant: "success",
      href: solscanTx(sig),
      hrefLabel: "View on Solscan",
    });
    setAmount("");
  }

  async function handleSubmit() {
    if (inFlight.current) return;
    // A-26 defense in depth: never build a transaction whose enforced min_out
    // was derived from a guessed premium. The button is already disabled without
    // a preview; this makes the invariant explicit at the money path.
    if (premiumBpsMint === null || premiumBpsRedeem === null) {
      setErrorMsg("Protocol parameters are still loading. Please retry in a moment.");
      return;
    }
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
        // Public direct mint is closed at launch (revert PublicMintDisabled).
        if (!cfg.publicMintEnabled) {
          throw new Error(
            "Direct mint isn't open yet. You can buy SILV on the DEX.",
          );
        }
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
                    floor6(
                      (parseFloat(amount) / effectiveMintPrice(priceUsd, premiumBpsMint)) *
                        (1 - slippageBps / 10_000),
                    ),
                  )
                : parseSilvAmount(floor6(preview.minOut));
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
        // The "queue" branch that lived here is GONE, along with the T+3 queue it drove
        // (deleted from the program on 2026-08-05). It was reachable from a LIVE config value
        // (`largeRedeemThresholdUsdc`, dead on chain but still $5,000), so every redemption at
        // or above $5,000 hit a builder that throws. The program would have settled those
        // instantly. Its ~95 lines of nonce-race retry machinery guarded a burn that can no
        // longer happen.
        if (route === "limit") {
          throw new Error(
            "This redemption would exceed the protocol's rolling limit for the current window. " +
              "Nothing has been sent and your SILV is untouched. Retry once the window rolls, " +
              "or redeem a smaller amount now.",
          );
        }
        if (route === "kyc") {
          throw new Error(
            "Redemption requires identity verification on this wallet. Nothing has been sent and " +
              `your SILV is untouched. Contact ${OTC_EMAIL} to start verification, then try again.`,
          );
        }
        {
          // Instant path (Pyth-priced).
          showProgress("Preparing transaction...");
          const r = await fetchAndExecuteLazer(
            connection,
            wallet,
            (envelope, priceUsd) => {
              const minUsdcOut =
                priceUsd != null
                  ? parseUsdcAmount(
                      floor6(
                        parseFloat(amount) *
                          effectiveRedeemPrice(priceUsd, premiumBpsRedeem) *
                          (1 - slippageBps / 10_000),
                      ),
                    )
                  : parseUsdcAmount(floor6(preview.minOut));
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
          : reroute === "limit"
            ? "The protocol's rolling redemption limit for this window is used up. Your SILV was not touched. Retry after the window rolls, or redeem less."
            : reroute === "kyc"
              ? `This wallet needs identity verification before it can redeem. Contact ${OTC_EMAIL}.`
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

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      {/* Genuine halt states (guardian pause / premium-update window) render
          in alarming red. */}
      {paused && (
        <div className="mb-4 rounded-md border border-danger bg-danger/10 px-3 py-2 text-xs text-danger">
          {cfg?.paused
            ? "Protocol paused by guardian."
            : "Mint paused during a premium-update window. Retry soon."}
        </div>
      )}

      {/* Launch posture: direct mint / redeem isn't open yet. Users trade SILV
          on the DEX instead. Neutral (not alarming) informational styling. */}
      {!paused && directClosed && (
        <div className="mb-4 rounded-md border border-border bg-bg/50 px-3 py-2 text-xs text-muted">
          {mode === "mint"
            ? "Direct mint isn't open yet. You can buy SILV on the DEX."
            : "Direct redemption isn't open yet. You can sell SILV on the DEX."}
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

      {/* The per-wallet read failed. Say so, in both modes, because the consequence differs and both
          are things the user would want to know BEFORE signing. On mint, a fee exemption we cannot
          see is a fee exemption the program is not told about, so an exempt wallet pays full
          premium with nothing reverting. On redeem, an attestation we cannot see routes to "kyc". */}
      {wallet.publicKey && walletFlagsError && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Could not read this wallet&apos;s fee-exemption
          {mode === "redeem" ? " or verification" : ""} status from the network.
          {mode === "mint"
            ? " If you hold an exemption it will NOT be applied to this transaction. Retry in a moment rather than signing."
            : " Redemption will be routed as unverified until the read succeeds."}
        </div>
      )}

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
                  : redeemRoute === "limit"
                    ? "text-yellow-300"
                    : "text-danger"
              }
            >
              {redeemRoute === "instant" &&
                "This amount redeems INSTANTLY from the treasury."}
              {redeemRoute === "limit" &&
                "This amount exceeds the protocol's rolling redemption limit for the current window. Nothing is sent and your SILV stays yours: retry once the window rolls, or redeem a smaller amount now."}
              {redeemRoute === "kyc" &&
                `Redemption requires identity verification on this wallet. Contact ${OTC_EMAIL} to start.`}
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
            {/* AUDIT P-07: these two bps values are now the ones THIS WALLET pays, so an exempt wallet
                shows 0.0% here and in the price and min-received rows above. Showing a bare "0.0%"
                would read as a loading glitch, so an exemption is stated, with the configured rate it
                replaces, and the expiry: a wallet holding a term-limited waiver should be able to see
                when it lapses without asking. */}
            <span className="font-mono text-white">
              {(mode === "mint" ? premiumBpsMint : premiumBpsRedeem) === null ? (
                "loading"
              ) : (mode === "mint" ? premiumBpsMint : premiumBpsRedeem) === 0 &&
                (mode === "mint" ? configuredBpsMint : configuredBpsRedeem) !== 0 ? (
                <span className="text-accent">
                  0.0% (waived
                  {(mode === "mint" ? configuredBpsMint : configuredBpsRedeem) !== null &&
                    `, normally ${(((mode === "mint" ? configuredBpsMint : configuredBpsRedeem) ?? 0) / 100).toFixed(1)}%`}
                  )
                </span>
              ) : (
                `${(((mode === "mint" ? premiumBpsMint : premiumBpsRedeem) ?? 0) / 100).toFixed(1)}%`
              )}
            </span>
          </div>
          {exemptSide && walletFlags?.feeExemptExpiresAt ? (
            <div className="flex justify-between text-accent/80">
              <span>
                Fee exemption ({exemptSide === "both" ? "mint and redeem" : exemptSide} side)
              </span>
              <span className="font-mono">
                until{" "}
                {new Date(walletFlags.feeExemptExpiresAt * 1000)
                  .toISOString()
                  .slice(0, 10)}
              </span>
            </div>
          ) : null}
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
          for fees.{" "}
          {/* AUDIT P-08: this always pointed at the devnet faucet. On mainnet there is no faucet, so
              linking one sends the user on an errand that cannot work, at the moment they are already
              stuck. Say nothing rather than something false. */}
          {SOL_TOPUP_URL ? (
            <>
              Top up at{" "}
              <a
                href={SOL_TOPUP_URL}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {new URL(SOL_TOPUP_URL).host}
              </a>{" "}
              (devnet).
            </>
          ) : (
            <>Fund this wallet with SOL from an exchange or another wallet.</>
          )}
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
          mintDisabled ||
          redemptionsOff ||
          // Every route the program cannot serve. "otc" was already here; "limit" and "kyc" were
          // not, so the button stayed clickable while its own label read "Over the window limit" or
          // "Verification required". Harmless (the submit path throws before any wallet interaction)
          // but an enabled button that cannot succeed is an invitation to click it.
          redeemRoute === "otc" ||
          redeemRoute === "limit" ||
          redeemRoute === "kyc" ||
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
              : mintDisabled
                ? "Mint not open yet"
                : redemptionsOff
                  ? "Redemptions not open yet"
                  : !amount
                    ? "Enter an amount"
                    : mode === "mint"
                      ? "Mint SILV"
                      : redeemRoute === "limit"
                        ? "Over the window limit"
                        : redeemRoute === "kyc"
                          ? "Verification required"
                          : redeemRoute === "otc"
                          ? "Use OTC desk"
                          : "Redeem SILV"}
      </button>

      {/* The queued-redemption UI (pending table, Claim, settled table, reclaim-rent) was
          REMOVED on 2026-08-05 with the queue itself. Redemption is one instant transaction:
          it settles or it reverts, so there is no request state for a user to track.

          It was already unreachable, because the request fetch returned an empty list, but
          unreachable is not the same as harmless: it kept two calls to instructions that no
          longer exist in the IDL alive in shipped code, where they would have failed with a
          bare TypeError rather than an explained error. */}
    </div>
  );
}
