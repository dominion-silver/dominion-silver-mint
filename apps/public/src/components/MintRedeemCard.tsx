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
  isBelowMinimumError,
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
  flagsMatchOwner,
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

  // `fetchConfig` throws on an RPC failure, and without the config there is no premium, no route and no
  // min_out, so `cfgError` must be read: quoting without it would be inventing numbers.
  const { data: cfg, error: cfgError } = useSWR(
    "onchain-config",
    () => fetchConfig(connection),
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );

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
  // Red is reserved for ERRORS. Progress text renders neutral so normal flow does not look alarming.
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

  // A-26: NO default premium. A fallback bps quotes a wrong price and, worse, feeds the wrong premium into
  // the min_out the transaction enforces. `null` propagates through every memo and disables the preview.
  const configuredBpsMint = cfg?.premiumBpsMint ?? null;
  const configuredBpsRedeem = cfg?.premiumBpsRedeem ?? null;

  // The clock the redemption-window prediction runs on. NOT the browser clock: the program uses
  // `Clock::unix_timestamp`, and a client two windows fast takes the `elapsed >= 2*w` branch and reports
  // used = 0 while the chain still counts the full previous bucket, so the card promises "instant" and the
  // chain answers RedeemLimitExceeded. The oracle's `publishTime` is a few seconds old at worst, which
  // makes the prediction slightly CONSERVATIVE: it can refuse what the chain would serve, never the reverse.
  const nowSecs = price?.publishTime ?? Math.floor(Date.now() / 1000);

  // The caller's on-chain per-wallet accounts, so `classifyRedeem` can answer the KYC question for THIS
  // wallet rather than only reporting that the gate is armed. One batched RPC call.
  //
  // ONE SNAPSHOT, used by the quote AND handed to the builder, so the transaction is priced by the same
  // facts the user was shown. Letting the builder re-read at send time puts one transaction on two
  // snapshots that can disagree, and that disagreement surfaces as arithmetic nobody can see (a bare
  // SlippageExceeded, or a budget check that counts 100.00 where the quote classified 98.50). A
  // stale-but-CONSISTENT quote is the better trade: it reverts on a program check the user can read.
  //
  // `error` is destructured deliberately: making the resolver throw only helps if a call site reads it.
  const { data: walletFlags, error: walletFlagsError } = useSWR(
    wallet.publicKey ? `wallet-flags-${wallet.publicKey.toBase58()}` : null,
    () => resolveWalletFlags(connection, wallet.publicKey!),
    { refreshInterval: 30_000, keepPreviousData: true },
  );
  // TRI-STATE, and the third state must stay reachable: `undefined` means NOT KNOWN, never "no exemption".
  // `classifyRedeem` turns it into the "kyc" route whenever the gate is armed, which is the fail-closed
  // direction, so an RPC failure blocks instead of promising an instant redeem the chain would revert.
  //
  // `keepPreviousData` serves the PREVIOUS wallet's flags until the new fetch settles, so a foreign
  // snapshot is downgraded to `undefined`, back onto that same fail-closed path. Uses the SAME predicate
  // the builders use, imported rather than re-expressed: three copies is how one of them drifts.
  const flagsAreForThisWallet = !!wallet.publicKey && flagsMatchOwner(walletFlags, wallet.publicKey);
  const flags = flagsAreForThisWallet ? walletFlags : undefined;
  const kycAttested = flags ? flags.kyc != null : undefined;

  // P-07: the quote uses the premiums THIS WALLET pays, not the global config values, so a whitelisted
  // wallet can see the terms it was granted before signing. `effectivePremiumBps` mirrors
  // `state/fee_exempt.rs::effective_premium_bps`, including a zero expiry counting as expired (C-01).
  // Falling back to the CONFIGURED bps when the exemption is unknown is the safe direction: `minSilvOut`
  // comes from this same number, so an over-optimistic quote is a hard SlippageExceeded, not a surprise.
  const premiumBpsMint =
    configuredBpsMint === null
      ? null
      : effectivePremiumBps(
          configuredBpsMint,
          flags?.feeExemptFlags ?? null,
          flags?.feeExemptExpiresAt ?? null,
          "mint",
          nowSecs,
        );
  const premiumBpsRedeem =
    configuredBpsRedeem === null
      ? null
      : effectivePremiumBps(
          configuredBpsRedeem,
          flags?.feeExemptFlags ?? null,
          flags?.feeExemptExpiresAt ?? null,
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

  // TWO figures, deliberately named apart:
  //   GROSS = the full oracle value of the SILV being burned. This memo produces it, and every comparison
  //           against a protocol limit uses it. Passing the NET into `classifyRedeem` under-states both
  //           checks by the redeem premium, and both are BN, so TypeScript cannot catch it.
  //   NET   = what the user receives, gross minus the premium.
  // The displayed "You receive" net comes from the float `preview` path (`effectiveRedeemPrice`), not from
  // a BN: nothing in the UI needs atomic precision on a figure already labelled "(est.)".
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
    return classifyRedeem(
      cfg,
      treasury,
      redeemGross,
      nowSecs,
      kycAttested,
      premiumBpsRedeem ?? undefined,
    );
  }, [mode, cfg, treasury, redeemGross, nowSecs, kycAttested, premiumBpsRedeem]);

  // Max instantly-redeemable, shown as USDC (and approx SILV via price).
  const maxInstant = useMemo(() => {
    if (!cfg || !treasury) return null;
    const usdc = computeMaxInstantRedeemableUsdc(
      cfg,
      treasury,
      nowSecs,
      premiumBpsRedeem ?? undefined,
    );
    const usdcNum = usdc.toNumber() / 1e6;
    // `usdc` is the NET. The SILV producing it is gross/spot and gross = net / (1 - bps/1e4), so divide the
    // net by `effectiveRedeemPrice`, which is spot*(1-bps/1e4). Exact, not approximate.
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
  // Launch posture: `public_mint_enabled=false`, so `mint_silv` reverts PublicMintDisabled and users trade
  // SILV on a DEX instead. Gate the CTA so a click cannot reach that revert.
  const mintDisabled = !!(mode === "mint" && cfg && !cfg.publicMintEnabled);
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
    // A-26, defence in depth: never build a transaction whose enforced min_out came from a guessed premium.
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
        // ROUND 5 P1-04. The on-chain floor, read from the LIVE config rather than a constant: it is
        // admin-settable and instant, so a copy here would go stale the first time it moves and send the
        // user into a OperationBelowMinimum revert. Checked before the envelope is claimed, so a mint
        // that cannot succeed costs neither a Lazer verify fee nor somebody else's price print.
        const minMintUsdc = cfg.minOperationUsdc?.toNumber() ?? 0;
        if (minMintUsdc > 0 && parseUsdcAmount(amount).lt(new BN(minMintUsdc))) {
          throw new Error(
            `The minimum mint is ${(minMintUsdc / 1e6).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} USDC.`,
          );
        }
        showProgress("Preparing transaction...");
        const r = await fetchAndExecuteLazer(
          connection,
          wallet,
          (envelope, priceUsd) => {
            // min_out comes off the ENVELOPE's own price, so the slippage floor matches what the contract
            // prices at. The preview is the fallback only when the proxy returned no price.
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
                // The SAME snapshot the quote above used.
                walletFlags: flags,
              amountUsdc: parseUsdcAmount(amount),
              minSilvOut,
              envelope,
            });
          },
        );
        setErrorMsg(null);
        afterTx(r.consumerSig, "Mint");
      } else {
        // ROUND 5 P1-04, and the review pass caught that this guard existed on the mint side only.
        // `redeem_silv` compares the GROSS USDC value against the same `config.min_operation_usdc`,
        // and `redeemGross` above is already exactly that number. Checked before the envelope is
        // claimed, so a redeem that cannot succeed neither pays a Lazer verify fee nor takes a price
        // print away from somebody whose transaction would have worked.
        //
        // The floor is a WALL for a small holder, not just a floor: a balance worth less than it has
        // no redeem exit in one call, so the message says the minimum rather than only refusing.
        const minOpUsdc = cfg.minOperationUsdc?.toNumber() ?? 0;
        if (minOpUsdc > 0 && redeemGross != null && redeemGross.lt(new BN(minOpUsdc))) {
          throw new Error(
            `The minimum redemption is ${(minOpUsdc / 1e6).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} USDC of SILV. This redemption is worth less than that.`,
          );
        }

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
        // There is no "queue" branch: the T+3 queue no longer exists in the program.
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
                  // The SAME snapshot the quote and the route used.
                  walletFlags: flags,
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
      // Flatten once (message + program logs + structured err): a confirmed-but-reverted tx carries the
      // signal in logs/onChainErr, not in `.message`.
      const flat = errorToText(e);
      // StaleOracle takes priority on EVERY Pyth path, and this covers the confirmed-on-chain-revert case
      // as well as the simulation revert that pyth-posting already maps.
      const reroute =
        mode === "redeem" ? parseRedeemError(flat) : null;
      // REVIEW PASS ON 3bf3097. `isBelowMinimumError` had ZERO call sites, so the on-chain revert it
      // exists for reached the user as a raw simulation string. It is genuinely reachable: the
      // pre-flight guards are computed off a client-side quote, so the price can move between quote
      // and land, and the admin can raise the floor mid-flight. It is checked on BOTH sides, above the
      // redeem-only reroutes, because mint raises the same error and had no mapping at all.
      const friendly =
        isStaleOracleError(flat)
          ? STALE_ORACLE_USER_MESSAGE
          : isBelowMinimumError(flat)
            ? "That amount is below the protocol's minimum operation size. Nothing was charged. Try a larger amount."
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

      {/* The per-wallet read failed. Surfaced in BOTH modes, because the consequence differs and each
          matters before signing: on mint an unseen exemption means the program is never told about it and
          the wallet pays full premium with nothing reverting; on redeem an unseen attestation routes
          to "kyc". */}
      {cfgError && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          Could not read the protocol configuration from the network, so no quote can be produced. This is
          an RPC problem, not a protocol change: nothing has been sent and your balances are untouched.
          Retry in a moment.
        </div>
      )}

      {wallet.publicKey && walletFlagsError && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Could not read this wallet&apos;s fee-exemption
          {mode === "redeem" ? " or verification" : ""} status from the network.
          {mode === "mint"
            ? " If you hold an exemption it will not be applied, so you may receive MORE SILV than quoted, never less."
            : cfg?.feeRoutingDisabled === true
              ? " Redeeming is held until the read succeeds, because an unread exemption would change the payout the window check uses."
              : " If you hold an exemption it will not be applied, so you may be paid MORE than quoted, never less."}
          {" Retry in a moment."}
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
            {/* P-07: these bps are the ones THIS WALLET pays, so an exempt wallet shows 0.0% here and in
                the rows above. A bare "0.0%" would read as a loading glitch, so the waiver is named with
                the rate it replaces and its expiry. */}
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
          {exemptSide && flags?.feeExemptExpiresAt ? (
            <div className="flex justify-between text-accent/80">
              <span>
                Fee exemption ({exemptSide === "both" ? "mint and redeem" : exemptSide} side)
              </span>
              <span className="font-mono">
                until{" "}
                {new Date(flags!.feeExemptExpiresAt! * 1000)
                  .toISOString()
                  .slice(0, 10)}
              </span>
            </div>
          ) : null}
          {/* No price-account rent to disclose: Lazer rides the signed price inside the consumer tx, so the
              only costs are the tx fee and a one-time token-account rent on the first mint. */}
        </div>
      )}

      {wallet.publicKey && insufficientSol && (
        <div className="mb-4 rounded-md border border-yellow-500 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300 break-words">
          Low SOL ({(solBalance ?? 0).toFixed(4)}). Need ≥ {SOL_FOR_FEES_MIN} SOL
          for fees.{" "}
          {/* P-08: only link a faucet when one exists. On mainnet there is none, and linking it sends an
              already-stuck user on an errand that cannot work. */}
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
          // EVERY route the program cannot serve, not just "otc": an enabled button whose own label reads
          // "Over the window limit" is an invitation to click something that cannot succeed.
          redeemRoute === "otc" ||
          redeemRoute === "limit" ||
          redeemRoute === "kyc" ||
          // NOT-YET-KNOWN blocks too, and it must: `fetchTreasuryBalance` throws on an RPC failure (P-04),
          // so `treasury` becomes undefined and `redeemRoute` becomes null. null matches none of the cases
          // above, and `handleSubmit` would then fall through every guard straight to the instant send.
          // Same tri-state doctrine as `kycAttested`: unknown is not permission.
          (mode === "redeem" && redeemRoute === null) ||
          // Submit is blocked for an unknown exemption in exactly ONE combination, deliberately narrow.
          // MINT, and REDEEM with routing ON: the outflow does not depend on the premium, so an unknown
          // exemption only means the user gets MORE than quoted, and the transaction succeeds. Blocking
          // those would disable the card for every visitor on one failing getMultipleAccountsInfo.
          // REDEEM with routing OFF: outflow is `gross - fee`, so the exemption CHANGES the figure the
          // window check uses. The quote classifies 98.50 as "instant", the chain computes 100.00 and
          // reverts RedeemLimitExceeded after the Lazer fee. That is the launch configuration.
          // An armed KYC gate is already covered: `kycAttested === undefined` routes to "kyc" above.
          (mode === "redeem" && cfg?.feeRoutingDisabled === true && wallet.connected && !flagsAreForThisWallet) ||
          // No config means no premium, no route and no min_out, so there is nothing to submit.
          !!cfgError ||
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
                  : mode === "redeem" && cfg?.feeRoutingDisabled === true && wallet.connected && !flagsAreForThisWallet
                    ? "Checking your fee status..."
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

      {/* There is no queued-redemption UI: redemption settles or reverts in one transaction, so there is
          no request state for a user to track. */}
    </div>
  );
}
