"use client";

import useSWR from "swr";
import { useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchDashboardSnapshot,
  formatUsdc,
  formatSilv,
  formatPrice,
  type DashboardSnapshot,
} from "../lib/anchor-client";

export function Dashboard() {
  const { connection } = useConnection();
  const { data, error, isLoading } = useSWR<DashboardSnapshot | null>(
    "dominion-dashboard",
    () => fetchDashboardSnapshot(connection),
    { refreshInterval: 5_000, revalidateOnFocus: false },
  );

  if (error) {
    return (
      <div className="rounded-xl border border-danger bg-danger/10 p-6 text-danger">
        Failed to load dashboard: {String(error)}
      </div>
    );
  }
  if (isLoading || !data) {
    return <div className="p-8 text-muted">Loading on-chain state…</div>;
  }

  const { cfg, treasuryUsdc, silvSupply, reserveRatioBps } = data;
  const reserveFloorBps = cfg.treasuryMinReserveBps;
  const reserveHealthy =
    reserveRatioBps === null || reserveRatioBps >= reserveFloorBps * 1.1;

  const now = new BN(Math.floor(Date.now() / 1000));
  const mintPauseActive = cfg.mintPausedUntil.gt(now);
  const mintPauseSecs = mintPauseActive
    ? cfg.mintPausedUntil.sub(now).toNumber()
    : 0;

  // CODEX 2nd-pass M-03: corrected scale.
  // SILV supply: 6 decimals. Price scale: 1e9 (PRICE_SCALE in oracle.rs).
  //   total_atoms = supply_atoms * price_scaled  (units: 6dec * 1e9 = 1e15)
  //   raw_USD     = total_atoms / 1e9            (units: 6dec USDC atoms)
  //   USD_dollars = raw_USD / 1e6                (units: USD whole)
  // Combined: divide by 1e9 + 1e6 = 1e15.
  const silvValueUsd = (() => {
    if (silvSupply.isZero() || cfg.lastRecordedPriceScaled.isZero()) return "$0";
    const total = silvSupply.mul(cfg.lastRecordedPriceScaled); // 6dec * 1e9 -> 1e15
    const usd = total.div(new BN(10).pow(new BN(15))).toNumber();
    return `~$${usd.toLocaleString()}`;
  })();

  return (
    <div className="space-y-6">
      {/* Status strip */}
      <div className="flex gap-4">
        <StatusTile
          label="Paused"
          value={cfg.paused ? "YES" : "No"}
          good={!cfg.paused}
        />
        <StatusTile
          label="Mint pause window"
          value={mintPauseActive ? `${Math.ceil(mintPauseSecs / 60)}min` : "No"}
          good={!mintPauseActive}
        />
        <StatusTile
          label="Active proposals"
          value={`${cfg.activeProposalCount} / 9`}
          good={cfg.activeProposalCount < 9}
        />
        <StatusTile
          label="Reserve ratio"
          value={
            reserveRatioBps === null
              ? "N/A"
              : `${(reserveRatioBps / 100).toFixed(1)}% (floor ${(reserveFloorBps / 100).toFixed(1)}%)`
          }
          good={reserveHealthy}
        />
      </div>

      {/* Treasury + supply */}
      <div className="grid grid-cols-2 gap-4">
        <Metric title="Treasury USDC" value={`$${formatUsdc(treasuryUsdc)}`} />
        <Metric
          title="SILV supply"
          value={`${formatSilv(silvSupply)} (${silvValueUsd})`}
        />
      </div>

      {/* Premium + price */}
      <div className="grid grid-cols-2 gap-4">
        <Metric
          title="Mint premium"
          value={`${(cfg.premiumBpsMint / 100).toFixed(1)}%`}
        />
        <Metric
          title="Redeem fee"
          value={`${(cfg.premiumBpsRedeem / 100).toFixed(1)}%`}
        />
        <Metric
          title="Last recorded price (on-chain)"
          value={`$${formatPrice(cfg.lastRecordedPriceScaled)}/oz`}
        />
        <Metric
          title="Reserve check price (slow-tracked)"
          value={`$${formatPrice(cfg.reserveCheckPriceScaled)}/oz`}
        />
      </div>

      {/* Caps - CODEX 2nd-pass M-03: corrected field names against IDL. */}
      <div className="grid grid-cols-2 gap-4">
        <Metric
          title="Max mint per tx"
          value={`$${formatUsdc(cfg.maxMintAmountPerTxUsdc)}`}
        />
        <Metric
          title="Max redeem per tx"
          value={`$${formatUsdc(cfg.maxRedeemAmountPerTxUsdc)}`}
        />
        <Metric
          title="Daily mint cap"
          value={`$${formatUsdc(cfg.dailyMintCapUsdc)}`}
        />
        <Metric
          title="Daily redeem cap"
          value={`$${formatUsdc(cfg.dailyRedeemCapUsdc)}`}
        />
        <Metric
          title="Min mint amount"
          value={`$${formatUsdc(cfg.minMintAmountUsdc)}`}
        />
        <Metric
          title="Min redeem amount"
          value={`$${formatUsdc(cfg.minRedeemAmountUsdc)}`}
        />
        <Metric
          title="Hourly redeem cap"
          value={`${(cfg.hourlyRedeemCapBpsOfSnapshot / 100).toFixed(1)}% of treasury at hour start`}
        />
      </div>

      {/* Governance */}
      <div className="grid grid-cols-2 gap-4">
        <Metric title="Admin" value={cfg.admin.toBase58().slice(0, 8) + "..."} />
        <Metric
          title="Timelock duration"
          value={`${Math.round(cfg.adminTimelockSeconds / 3600)}h`}
        />
        <Metric title="Guardians" value={`${cfg.guardianCount}`} />
        <Metric title="Version" value={`v${cfg.version}`} />
      </div>

      {/* Actions */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-4 text-sm uppercase tracking-wide text-muted">
          Admin actions (Squads)
        </h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <ActionButton label="Propose premium change" />
          <ActionButton label="Propose withdraw" />
          <ActionButton label="Propose oracle guards" />
          <ActionButton label="Propose reserve min" />
          <ActionButton label="Propose metadata update" />
          <ActionButton label="Propose compliance toggle" />
          <ActionButton label="Propose Pyth feed migration" />
          <ActionButton label="Propose timelock duration" />
          <ActionButton label="Pause" danger />
          <ActionButton label="Unpause" />
          <ActionButton label="Add guardian" />
          <ActionButton label="Remove guardian" />
          <ActionButton label="Deposit USDC" />
          <ActionButton label="Transfer admin" />
        </div>
      </div>
    </div>
  );
}

function StatusTile({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good: boolean;
}) {
  return (
    <div
      className={`flex-1 rounded-lg border ${good ? "border-border" : "border-danger"} bg-card p-4`}
    >
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${good ? "text-white" : "text-danger"}`}>
        {value}
      </div>
    </div>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{title}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}

function ActionButton({ label, danger }: { label: string; danger?: boolean }) {
  return (
    <button
      disabled
      onClick={() =>
        alert(`${label}: opens modal + builds Squads proposal. Squads SDK integration pending.`)
      }
      className={`rounded-md border px-3 py-2 text-left transition hover:bg-bg/40 disabled:cursor-not-allowed disabled:opacity-60 ${
        danger ? "border-danger text-danger" : "border-border"
      }`}
    >
      {label}
    </button>
  );
}
