"use client";

import useSWR from "swr";
import { useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchDashboardSnapshot,
  fetchAllRedemptionRequests,
  formatUsdc,
  formatSilv,
  formatPrice,
  type DashboardSnapshot,
  type RedemptionRequestView,
  type RedemptionStatusKind,
} from "../lib/anchor-client";

const SECS_PER_DAY = 86_400;

export function Dashboard() {
  const { connection } = useConnection();
  // The public devnet RPC (api.devnet.solana.com) rate-limits heavy reads.
  // Keep the lightweight snapshot resilient (retry + keep last good data) so
  // a transient "Failed to fetch" auto-recovers instead of nuking the page.
  const { data, error, isLoading } = useSWR<DashboardSnapshot | null>(
    "dominion-dashboard",
    () => fetchDashboardSnapshot(connection),
    {
      refreshInterval: 10_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 4_000,
      errorRetryCount: 10,
      errorRetryInterval: 2_500,
    },
  );
  // STAGGER the heavy unfiltered getProgramAccounts: only fire it AFTER the
  // snapshot has loaded (conditional key = null until then) and refresh it
  // slowly. Firing it concurrently with the snapshot on mount is what was
  // saturating the public RPC's per-IP limit and failing both. It already
  // degrades to [] on error, so a failure only empties the queue panel.
  const { data: redemptions } = useSWR<RedemptionRequestView[]>(
    data ? "dominion-redemptions" : null,
    () => fetchAllRedemptionRequests(connection),
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 15_000,
    },
  );

  // Only hard-fail if we have NEVER gotten data. With keepPreviousData +
  // retry, a blip is invisible; a sustained outage shows this with a note
  // that it is auto-retrying (no user action needed, not an auth problem).
  if (error && !data) {
    return (
      <div className="rounded-xl border border-danger bg-danger/10 p-6 text-danger">
        Failed to load dashboard: {String(error)}
        <div className="mt-2 text-xs text-muted">
          Retrying automatically. This is the public devnet RPC rate-limiting
          heavy reads, not a wallet/permission issue (the dashboard is
          read-only). It usually clears within a few seconds.
        </div>
      </div>
    );
  }
  if (isLoading && !data) {
    return <div className="p-8 text-muted">Loading on-chain state…</div>;
  }
  if (!data) {
    return <div className="p-8 text-muted">Loading on-chain state…</div>;
  }

  const {
    cfg,
    treasuryUsdc,
    silvSupply,
    supplyUtilizationBps,
    instantBudgetRemainingUsdc,
    instantWindowExpired,
    instantWindowNeverStarted,
    treasuryFloatOk,
  } = data;

  const now = new BN(Math.floor(Date.now() / 1000));
  const mintPauseActive = cfg.mintPausedUntil.gt(now);
  const mintPauseSecs = mintPauseActive
    ? cfg.mintPausedUntil.sub(now).toNumber()
    : 0;

  // SILV notional at the last on-chain recorded price.
  // supply(6dec) * price(1e9) / 1e15 = whole USD.
  const silvValueUsd = (() => {
    if (silvSupply.isZero() || cfg.lastRecordedPriceScaled.isZero())
      return "n/a";
    const total = silvSupply.mul(cfg.lastRecordedPriceScaled);
    const usd = total.div(new BN(10).pow(new BN(15))).toNumber();
    return `~$${usd.toLocaleString()}`;
  })();

  const supplyUtilPct =
    supplyUtilizationBps === null
      ? "n/a"
      : `${(supplyUtilizationBps / 100).toFixed(2)}%`;
  const supplyHealthy =
    supplyUtilizationBps === null || supplyUtilizationBps < 9_500; // <95% of cap

  const pendingProposals: { label: string; nonce: BN | null }[] = [
    { label: "premium mint", nonce: cfg.pendingPremiumMintNonce },
    { label: "premium redeem", nonce: cfg.pendingPremiumRedeemNonce },
    { label: "withdraw", nonce: cfg.pendingWithdrawNonce },
    { label: "treasury float", nonce: cfg.pendingTreasuryFloatNonce },
    { label: "oracle guards", nonce: cfg.pendingOracleGuardsNonce },
    { label: "metadata", nonce: cfg.pendingMetadataNonce },
    { label: "compliance", nonce: cfg.pendingComplianceNonce },
    { label: "pyth feed", nonce: cfg.pendingPythFeedNonce },
    { label: "admin timelock", nonce: cfg.pendingAdminTimelockNonce },
  ];
  const activePending = pendingProposals.filter((p) => p.nonce !== null);

  return (
    <div className="space-y-6">
      {/* Status strip */}
      <div className="flex flex-wrap gap-4">
        <StatusTile
          label="Paused"
          value={cfg.paused ? "YES" : "No"}
          good={!cfg.paused}
        />
        <StatusTile
          label="Redemptions"
          value={cfg.redemptionsEnabled ? "Enabled" : "DISABLED"}
          good={cfg.redemptionsEnabled}
        />
        <StatusTile
          label="Mint pause window"
          value={mintPauseActive ? `${Math.ceil(mintPauseSecs / 60)}min` : "No"}
          good={!mintPauseActive}
        />
        <StatusTile
          label="Active proposals"
          value={`${cfg.activeProposalCount} / 10`}
          good={cfg.activeProposalCount < 10}
        />
        <StatusTile
          label="Treasury vs float"
          value={treasuryFloatOk ? "OK" : "BELOW FLOOR"}
          good={treasuryFloatOk}
        />
        <StatusTile
          label="Supply vs cap"
          value={supplyUtilPct}
          good={supplyHealthy}
        />
      </div>

      {/* Treasury + supply */}
      <Section title="Treasury & supply (Option B: 100% physical backing, no on-chain reserve)">
        <Metric title="Treasury USDC" value={`$${formatUsdc(treasuryUsdc)}`} />
        <Metric
          title="SILV supply"
          value={`${formatSilv(silvSupply)} oz (${silvValueUsd})`}
        />
        <Metric
          title="Max SILV supply (hard cap)"
          value={`${formatSilv(cfg.maxSilvSupply)} oz`}
        />
        <Metric
          title="Treasury min float (admin-withdraw floor)"
          value={`$${formatUsdc(cfg.treasuryMinFloatUsdc)}`}
        />
      </Section>

      {/* Premium + price */}
      <Section title="Pricing">
        <Metric
          title="Mint premium"
          value={`${(cfg.premiumBpsMint / 100).toFixed(2)}%`}
        />
        <Metric
          title="Redeem fee"
          value={`${(cfg.premiumBpsRedeem / 100).toFixed(2)}%`}
        />
        <Metric
          title="Last recorded price (on-chain)"
          value={`$${formatPrice(cfg.lastRecordedPriceScaled)}/oz`}
        />
        <Metric
          title="Last price update"
          value={
            cfg.lastPriceUpdateAt.isZero()
              ? "never"
              : new Date(
                  cfg.lastPriceUpdateAt.toNumber() * 1000,
                ).toLocaleString()
          }
        />
      </Section>

      {/* Option B redemption routing */}
      <Section title="Redemption routing & instant budget (D8/D10)">
        <Metric
          title="Large-redeem threshold (>= forces T+queue)"
          value={`$${formatUsdc(cfg.largeRedeemThresholdUsdc)}`}
        />
        <Metric
          title="Instant budget / window"
          value={`$${formatUsdc(cfg.instantRedeemBudgetUsdc)}`}
        />
        <Metric
          title="Instant window length"
          value={`${(cfg.instantRedeemWindowSeconds / 3600).toFixed(1)}h`}
        />
        <Metric
          title="Instant used (current window)"
          value={
            instantWindowNeverStarted
              ? "$0 (no instant redeems yet)"
              : instantWindowExpired
                ? "$0 (window reset)"
                : `$${formatUsdc(cfg.instantUsedUsdc)}`
          }
        />
        <Metric
          title="Instant budget remaining now"
          value={`$${formatUsdc(instantBudgetRemainingUsdc)}`}
        />
        <Metric
          title="Queue delay (T+N)"
          value={`${(cfg.redeemQueueDelaySeconds / SECS_PER_DAY).toFixed(1)} days`}
        />
      </Section>

      {/* Oracle guards */}
      <Section title="Oracle guards">
        <Metric
          title="Max staleness"
          value={`${cfg.maxStalenessSeconds}s`}
        />
        <Metric
          title="Max confidence"
          value={`${(cfg.maxConfidenceBps / 100).toFixed(2)}%`}
        />
        <Metric
          title="Price band"
          value={`$${formatPrice(cfg.minPriceUsdScaled)} - $${formatPrice(cfg.maxPriceUsdScaled)}`}
        />
        <Metric
          title="Max price delta / decay"
          value={`${(cfg.maxPriceDeltaBps / 100).toFixed(2)}% / ${(cfg.priceDeltaDecaySeconds / 3600).toFixed(1)}h`}
        />
      </Section>

      {/* Governance */}
      <Section title="Governance">
        <Metric
          title="Admin (Ops Squads)"
          value={cfg.admin.toBase58().slice(0, 8) + "…"}
        />
        <Metric
          title="Pending admin"
          value={
            cfg.pendingAdmin
              ? cfg.pendingAdmin.toBase58().slice(0, 8) + "…"
              : "none"
          }
        />
        <Metric
          title="Timelock duration"
          value={`${Math.round(cfg.adminTimelockSeconds / 3600)}h`}
        />
        <Metric
          title="Guardians"
          value={`${cfg.guardianCount} / ${cfg.maxGuardianCount}`}
        />
        <Metric title="Schema version" value={`v${cfg.version}`} />
        <Metric
          title="Compliance mode"
          value={cfg.complianceMode ? "ON" : "off"}
        />
      </Section>

      {/* Pending timelocked proposals */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-3 text-sm uppercase tracking-wide text-muted">
          Pending timelocked proposals ({activePending.length})
        </h3>
        {activePending.length === 0 ? (
          <p className="text-sm text-muted">None pending.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
            {activePending.map((p) => (
              <li
                key={p.label}
                className="rounded-md border border-border px-3 py-2"
              >
                <span className="text-muted">{p.label}</span>{" "}
                <span className="font-mono">#{p.nonce?.toString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Redemption queue / OTC settle */}
      <RedemptionQueue requests={redemptions ?? []} />

      {/* Actions */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-1 text-sm uppercase tracking-wide text-muted">
          Admin actions
        </h3>
        <p className="mb-4 text-xs text-muted">
          Instant setters are direct admin txs; timelocked actions create a
          Squads proposal (24h delay). Squads SDK wiring pending - buttons are
          placeholders.
        </p>
        <div className="mb-2 text-xs uppercase tracking-wide text-muted">
          Instant (no timelock)
        </div>
        <div className="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
          <ActionButton label="Set redemptions enabled" />
          <ActionButton label="Set max SILV supply" />
          <ActionButton label="Set instant redeem budget" />
          <ActionButton label="Set instant redeem window" />
          <ActionButton label="Set large-redeem threshold" />
          <ActionButton label="Set redeem queue delay" />
        </div>
        <div className="mb-2 text-xs uppercase tracking-wide text-muted">
          Timelocked (Squads proposal, 24h)
        </div>
        <div className="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
          <ActionButton label="Propose treasury min float" />
          <ActionButton label="Propose premium mint" />
          <ActionButton label="Propose premium redeem" />
          <ActionButton label="Propose withdraw" />
          <ActionButton label="Propose oracle guards" />
          <ActionButton label="Propose metadata update" />
          <ActionButton label="Propose compliance toggle" />
          <ActionButton label="Propose Pyth feed migration" />
          <ActionButton label="Propose timelock duration" />
        </div>
        <div className="mb-2 text-xs uppercase tracking-wide text-muted">
          Emergency / ops
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
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

function RedemptionQueue({
  requests,
}: {
  requests: RedemptionRequestView[];
}) {
  const nowSecs = Math.floor(Date.now() / 1000);
  const pending = requests.filter((r) => r.status === "pending");
  const claimableOverdue = pending.filter((r) => nowSecs >= r.claimableAt);

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm uppercase tracking-wide text-muted">
          Redemption queue ({pending.length} pending)
        </h3>
        {claimableOverdue.length > 0 && (
          <span className="text-xs text-danger">
            {claimableOverdue.length} past claimable - candidate OTC IOUs
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted">
        T+N queued redemptions. SILV is already burned; USDC is priced at claim.
        Requests past their claimable time that the treasury cannot cover are
        OTC IOUs - settle via admin_settle_redemption_offchain after the desk
        pays the user.
      </p>
      {requests.length === 0 ? (
        <p className="text-sm text-muted">No redemption requests.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4">Owner</th>
                <th className="py-2 pr-4">SILV</th>
                <th className="py-2 pr-4">Requested</th>
                <th className="py-2 pr-4">Claimable</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Action</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {requests.map((r) => {
                const overdue =
                  r.status === "pending" && nowSecs >= r.claimableAt;
                const claimEta = r.claimableAt - nowSecs;
                return (
                  <tr
                    key={r.pubkey.toBase58()}
                    className="border-t border-border"
                  >
                    <td className="py-2 pr-4">
                      {r.owner.toBase58().slice(0, 6)}…
                      {r.owner.toBase58().slice(-4)}
                    </td>
                    <td className="py-2 pr-4">{formatSilv(r.amountSilv)}</td>
                    <td className="py-2 pr-4">
                      {new Date(r.requestedAt * 1000).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4">
                      {r.status !== "pending"
                        ? "-"
                        : overdue
                          ? "now"
                          : `${Math.ceil(claimEta / 3600)}h`}
                    </td>
                    <td className="py-2 pr-4">
                      <StatusPill status={r.status} overdue={overdue} />
                    </td>
                    <td className="py-2 pr-4">
                      {r.status === "pending" ? (
                        <button
                          onClick={() =>
                            alert(
                              `Settle offchain for ${r.owner.toBase58()} (nonce ${r.nonce.toString()}): ` +
                                `builds admin_settle_redemption_offchain via Squads. SDK wiring pending.`,
                            )
                          }
                          className="rounded border border-border px-2 py-1 text-xs transition hover:bg-bg/40"
                        >
                          Settle offchain
                        </button>
                      ) : (
                        <span className="text-xs text-muted">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  status,
  overdue,
}: {
  status: RedemptionStatusKind;
  overdue: boolean;
}) {
  if (status === "claimed")
    return <span className="text-xs text-muted">claimed</span>;
  if (status === "settledOffchain")
    return <span className="text-xs text-accent">settled OTC</span>;
  return (
    <span className={`text-xs ${overdue ? "text-danger" : "text-white"}`}>
      {overdue ? "pending (overdue)" : "pending"}
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm uppercase tracking-wide text-muted">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">{children}</div>
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
      <div
        className={`mt-1 text-lg font-semibold ${good ? "text-white" : "text-danger"}`}
      >
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
      onClick={() =>
        alert(
          `${label}: opens form + builds the tx (instant) or Squads proposal (timelocked). Squads SDK integration pending.`,
        )
      }
      className={`rounded-md border px-3 py-2 text-left transition hover:bg-bg/40 ${
        danger ? "border-danger text-danger" : "border-border"
      }`}
    >
      {label}
    </button>
  );
}
