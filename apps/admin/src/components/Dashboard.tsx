"use client";

import { useState } from "react";
import useSWR from "swr";
import { useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchDashboardSnapshot,
  fetchAllRedemptionRequests,
  fetchGuardians,
  formatUsdc,
  formatSilv,
  formatPrice,
  formatCountdown,
  secondsUntil,
  type DashboardSnapshot,
  type GuardianView,
  type RedemptionRequestView,
  type RedemptionQueueResult,
  type RedemptionStatusKind,
} from "../lib/anchor-client";
import { AdminActions } from "./AdminActions";


const SECS_PER_DAY = 86_400;

type TabId = "overview" | "redemptions" | "governance" | "actions" | "help";
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "redemptions", label: "Redemptions" },
  { id: "governance", label: "Governance" },
  { id: "actions", label: "Actions" },
  { id: "help", label: "Help" },
];

export function Dashboard() {
  const { connection } = useConnection();
  const [tab, setTab] = useState<TabId>("overview");

  // The public devnet RPC rate-limits heavy reads. Keep the lightweight
  // snapshot resilient (retry + keep last good data) so a transient
  // "Failed to fetch" auto-recovers instead of nuking the page.
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
  // Only fire the heavy redemption-list query AFTER the snapshot loads, and
  // refresh it slowly, so the two don't saturate the RPC together.
  // The fetcher THROWS on failure (P2-01 review-of-fixes). With
  // keepPreviousData, SWR then keeps the last successful `redemptions`
  // array AND sets `redemptionsError`, so the operator keeps seeing the
  // real burned-SILV IOUs with a degraded banner instead of an empty queue.
  const { data: redemptions, error: redemptionsError } = useSWR<
    RedemptionRequestView[]
  >(
    data ? "dominion-redemptions" : null,
    () => fetchAllRedemptionRequests(connection),
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 15_000,
    },
  );
  // AUDIT review of daac4ac (P1): `pending_removal_at` was written on-chain and
  // read by neither app. DOM-007's security property is that the TARGETED guardian
  // has a full timelock window to react, which requires the console to show that a
  // removal exists and when it fires. Cheap query (a handful of small accounts),
  // and it is the only place a guardian can see it is under notice.
  const { data: guardians } = useSWR<GuardianView[]>(
    data ? "dominion-guardians" : null,
    () => fetchGuardians(connection),
    {
      refreshInterval: 20_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    },
  );

  const queue: RedemptionQueueResult = {
    requests: redemptions ?? [],
    // degraded iff the latest fetch errored. requests may be last-good/stale.
    degraded: !!redemptionsError,
    error: redemptionsError
      ? redemptionsError instanceof Error
        ? redemptionsError.message
        : String(redemptionsError)
      : undefined,
  };

  if (error && !data) {
    return (
      <div className="rounded-xl border border-danger bg-danger/10 p-6 text-danger">
        Failed to load dashboard: {String(error)}
        <div className="mt-2 text-xs text-muted">
          Retrying automatically. This is the public devnet RPC rate-limiting
          heavy reads, not a wallet or permission issue (the dashboard is
          read-only). It usually clears within a few seconds.
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="p-8 text-muted">Loading on-chain state…</div>;
  }

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
              tab === t.id
                ? "border-accent font-semibold text-white"
                : "border-transparent text-muted hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab data={data} />}
      {tab === "redemptions" && (
        <RedemptionsTab data={data} queue={queue} />
      )}
      {tab === "governance" && (
        <GovernanceTab data={data} guardians={guardians ?? []} />
      )}
      {tab === "actions" && <AdminActions />}
      {tab === "help" && <HelpTab />}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab({ data }: { data: DashboardSnapshot }) {
  const {
    cfg,
    treasuryUsdc,
    silvSupply,
    supplyUtilizationBps,
    treasuryFloatOk,
  } = data;
  const now = new BN(Math.floor(Date.now() / 1000));
  const mintPauseActive = cfg.mintPausedUntil.gt(now);
  const mintPauseSecs = mintPauseActive
    ? cfg.mintPausedUntil.sub(now).toNumber()
    : 0;
  const silvValueUsd = (() => {
    if (silvSupply.isZero() || cfg.lastRecordedPriceScaled.isZero())
      return "n/a";
    const total = silvSupply.mul(cfg.lastRecordedPriceScaled);
    return `~$${total.div(new BN(10).pow(new BN(15))).toNumber().toLocaleString()}`;
  })();
  const supplyUtilPct =
    supplyUtilizationBps === null
      ? "n/a"
      : `${(supplyUtilizationBps / 100).toFixed(2)}%`;
  const supplyHealthy =
    supplyUtilizationBps === null || supplyUtilizationBps < 9_500;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <StatusTile
          label="Paused"
          value={cfg.paused ? "YES" : "No"}
          good={!cfg.paused}
          tip="When ON, all minting and redeeming is blocked. Used only in emergencies."
        />
        <StatusTile
          label="Redemptions"
          value={cfg.redemptionsEnabled ? "Enabled" : "DISABLED"}
          good={cfg.redemptionsEnabled}
          tip="Master on/off switch for users selling SILV back for USDC. When OFF, no new redemptions or queue entries are accepted."
        />
        <StatusTile
          label="Mint pause window"
          value={mintPauseActive ? `${Math.ceil(mintPauseSecs / 60)}min` : "No"}
          good={!mintPauseActive}
          tip="A short automatic block on minting while a pricing change is pending, to stop someone front-running the new price."
        />
        <StatusTile
          label="Pending changes"
          value={`${cfg.activeProposalCount} / 10`}
          good={cfg.activeProposalCount < 10}
          tip="Number of sensitive setting changes currently in their 24-hour waiting period (max 10 at once)."
        />
        <StatusTile
          label="Treasury vs floor"
          value={treasuryFloatOk ? "OK" : "BELOW FLOOR"}
          good={treasuryFloatOk}
          tip="Whether the treasury USDC is at or above the minimum balance the admin must leave available for redeemers."
        />
        <StatusTile
          label="Supply vs cap"
          value={supplyUtilPct}
          good={supplyHealthy}
          tip="How much of the maximum allowed SILV has been minted. SILV is capped at the amount of physical silver held."
        />
      </div>

      <Section title="Treasury & supply">
        <Metric
          title="Treasury USDC"
          value={`$${formatUsdc(treasuryUsdc)}`}
          tip="USDC currently held by the protocol, available to pay out instant redemptions."
        />
        <Metric
          title="SILV supply"
          value={`${formatSilv(silvSupply)} oz (${silvValueUsd})`}
          tip="Total SILV in circulation. 1 SILV represents 1 troy ounce of physical silver held in vault."
        />
        <Metric
          title="Max SILV supply"
          value={`${formatSilv(cfg.maxSilvSupply)} oz`}
          tip="Hard ceiling on how much SILV can ever exist. Raised only after buying matching physical silver."
        />
        <Metric
          title="Treasury minimum balance"
          value={`$${formatUsdc(cfg.treasuryMinFloatUsdc)}`}
          tip="The admin cannot withdraw treasury USDC below this amount. It never blocks a user redemption."
        />
      </Section>

      <Section title="Pricing">
        <Metric
          title="Mint premium"
          value={`${(cfg.premiumBpsMint / 100).toFixed(2)}%`}
          tip="Markup over the live silver price that a user pays when minting SILV."
        />
        <Metric
          title="Redeem fee"
          value={`${(cfg.premiumBpsRedeem / 100).toFixed(2)}%`}
          tip="Discount under the live silver price applied when a user redeems SILV."
        />
        <Metric
          title="Last recorded price"
          value={`$${formatPrice(cfg.lastRecordedPriceScaled)}/oz`}
          tip="The most recent silver price the protocol recorded on-chain, in USD per troy ounce."
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
          tip="When the on-chain recorded price was last refreshed."
        />
      </Section>
    </div>
  );
}

/* ---------------- Redemptions ---------------- */

function RedemptionsTab({
  data,
  queue,
}: {
  data: DashboardSnapshot;
  queue: RedemptionQueueResult;
}) {
  const {
    cfg,
    instantBudgetRemainingUsdc,
    instantWindowExpired,
    instantWindowNeverStarted,
  } = data;
  return (
    <div className="space-y-6">
      <Section title="Redemption routing">
        <Metric
          title="Large-redeem threshold"
          value={`$${formatUsdc(cfg.largeRedeemThresholdUsdc)}`}
          tip="Any single redemption worth this much or more is automatically sent to the delayed queue instead of paid instantly."
        />
        <Metric
          title="Instant budget per window"
          value={`$${formatUsdc(cfg.instantRedeemBudgetUsdc)}`}
          tip="Maximum total value of instant redemptions allowed within each fixed reset window, across all users combined."
        />
        <Metric
          title="Window length"
          value={`${(cfg.instantRedeemWindowSeconds / 3600).toFixed(1)}h`}
          tip="Length of the fixed window after which the instant budget fully resets (not a continuous sliding limiter)."
        />
        <Metric
          title="Instant used this window"
          value={
            instantWindowNeverStarted
              ? "$0 (none yet)"
              : instantWindowExpired
                ? "$0 (window reset)"
                : `$${formatUsdc(cfg.instantUsedUsdc)}`
          }
          tip="How much of the instant-redemption budget has been used in the current window."
        />
        <Metric
          title="Instant remaining now"
          value={`$${formatUsdc(instantBudgetRemainingUsdc)}`}
          tip="Instant redemption value still available in the current window."
        />
        <Metric
          title="Queue delay"
          value={`${(cfg.redeemQueueDelaySeconds / SECS_PER_DAY).toFixed(1)} days`}
          tip="How long a queued redemption must wait before the user can claim their USDC."
        />
      </Section>

      <RedemptionQueue queue={queue} />
    </div>
  );
}

function RedemptionQueue({ queue }: { queue: RedemptionQueueResult }) {
  const { requests, degraded } = queue;
  const nowSecs = Math.floor(Date.now() / 1000);
  const pending = requests.filter((r) => r.status === "pending");
  const overdueCount = pending.filter((r) => nowSecs >= r.claimableAt).length;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="flex items-center text-sm uppercase tracking-wide text-muted">
          Redemption queue{" "}
          {degraded
            ? requests.length > 0
              ? `(${pending.length} pending - STALE)`
              : "(unavailable)"
            : `(${pending.length} pending)`}
          <Tip text="Redemptions waiting out the queue delay. The user's SILV is already burned; their USDC amount is set at claim time. If the treasury cannot cover a claim, the request stays open and is settled off-chain by the admin." />
        </h3>
        {overdueCount > 0 && (
          <span className="text-xs text-danger">
            {overdueCount} past claimable time{degraded ? " (stale)" : ""}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted">
        Requests past their claimable time that the treasury cannot cover are
        paid off-chain, then marked settled here so they cannot be claimed
        again.
      </p>
      {/* P2-01 (review-of-fixes): on RPC failure SWR keepPreviousData
          retains the last good queue. Show a degraded banner AND keep
          rendering the last-known table so real burned-SILV IOUs are never
          hidden - only show "no data yet" when there is genuinely none. */}
      {degraded && (
        <div className="mb-4 rounded-md border border-warning bg-warning/10 p-4 text-sm text-warning">
          {requests.length > 0
            ? "Live queue read failed / RPC rate-limiting (retrying). Showing the LAST KNOWN state below - it may be STALE. Do not treat it as current truth until this clears."
            : 'Queue read failed / RPC rate-limiting (retrying) and no snapshot has loaded yet. This is NOT "no redemptions": there may be pending/overdue IOUs not shown.'}
          {queue.error ? (
            <div className="mt-1 font-mono text-xs text-muted">
              {queue.error}
            </div>
          ) : null}
        </div>
      )}
      {requests.length === 0 ? (
        degraded ? null : (
          <p className="text-sm text-muted">No redemption requests.</p>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4">User</th>
                <th className="py-2 pr-4">SILV</th>
                <th className="py-2 pr-4">Requested</th>
                <th className="py-2 pr-4">Claimable in</th>
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
                          onClick={() => {
                            navigator.clipboard
                              ?.writeText(r.owner.toBase58())
                              .catch(() => {});
                            alert(
                              `Settle off-chain (the user's SILV is already burned):\n\nowner: ${r.owner.toBase58()}  (copied to clipboard)\nnonce: ${r.nonce.toString()}\n\nUse the "Settle redemption off-chain" action in the Admin Actions panel below (paste owner + enter nonce). It submits via the Ops Squads multisig. Do this ONLY after the user has been paid off-chain, so the request can no longer be claimed on-chain.`,
                            );
                          }}
                          className="rounded border border-border px-2 py-1 text-xs transition hover:bg-bg/40"
                        >
                          Settle off-chain
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
    return <span className="text-xs text-accent">settled off-chain</span>;
  return (
    <span className={`text-xs ${overdue ? "text-danger" : "text-white"}`}>
      {overdue ? "waiting (overdue)" : "waiting"}
    </span>
  );
}

/* ---------------- Governance ---------------- */

function GovernanceTab({
  data,
  guardians,
}: {
  data: DashboardSnapshot;
  guardians: GuardianView[];
}) {
  const { cfg } = data;
  const pendingProposals: { label: string; nonce: BN | null }[] = [
    { label: "Mint premium", nonce: cfg.pendingPremiumMintNonce },
    { label: "Redeem fee", nonce: cfg.pendingPremiumRedeemNonce },
    { label: "Treasury withdraw", nonce: cfg.pendingWithdrawNonce },
    { label: "Treasury minimum", nonce: cfg.pendingTreasuryFloatNonce },
    { label: "Oracle guards", nonce: cfg.pendingOracleGuardsNonce },
    { label: "Token metadata", nonce: cfg.pendingMetadataNonce },
    { label: "Compliance mode", nonce: cfg.pendingComplianceNonce },
    { label: "Price feed", nonce: cfg.pendingPythFeedNonce },
    { label: "Timelock duration", nonce: cfg.pendingAdminTimelockNonce },
  ];
  const activePending = pendingProposals.filter((p) => p.nonce !== null);

  return (
    <div className="space-y-6">
      <Section title="Control & ownership">
        <Metric
          title="Admin wallet"
          value={cfg.admin.toBase58().slice(0, 8) + "…"}
          tip="The multisig wallet that controls protocol settings. Sensitive changes still wait 24 hours before they take effect."
        />
        <Metric
          title="Pending admin"
          value={
            cfg.pendingAdmin
              ? cfg.pendingAdmin.toBase58().slice(0, 8) + "…"
              : "none"
          }
          tip="A proposed new admin wallet, shown only while an ownership transfer is in progress (it must accept to complete)."
        />
        <Metric
          title="Change delay"
          value={`${Math.round(cfg.adminTimelockSeconds / 3600)}h`}
          tip="How long sensitive setting changes wait before they can be executed. A guardian can cancel during this window."
        />
        <Metric
          title="Guardians"
          value={
            cfg.pendingRemovalCount > 0
              ? `${cfg.guardianCount} / ${cfg.maxGuardianCount} (${cfg.pendingRemovalCount} leaving)`
              : `${cfg.guardianCount} / ${cfg.maxGuardianCount}`
          }
          tip="Trusted keys that can pause the protocol or cancel a pending change. They cannot move funds or change settings. Removal is not instant: it is scheduled, and a guardian under notice keeps every power until it is finalized."
        />
        <Metric
          title="Config version"
          value={`v${cfg.version}`}
          tip="On-chain configuration layout version."
        />
        <Metric
          title="Compliance mode"
          value={cfg.complianceMode ? "ON" : "off"}
          tip="Operator compliance flag for off-chain procedures. It does NOT add token freeze or transfer-restriction controls - this contract has no freeze path. Turning it ON only flips this flag and auto-pauses the protocol. Enforcement (seize/burn) is done via the permanent-delegate authority, not this switch."
        />
      </Section>

      <GuardianRoster guardians={guardians} />

      <Section title="Price feed safety checks">
        <Metric
          title="Max price age"
          value={`${cfg.maxStalenessSeconds}s`}
          tip="Reject the price feed if the latest price is older than this many seconds."
        />
        <Metric
          title="Max uncertainty"
          value={`${(cfg.maxConfidenceBps / 100).toFixed(2)}%`}
          tip="Reject the price if the oracle's reported uncertainty is wider than this."
        />
        <Metric
          title="Accepted price band"
          value={`$${formatPrice(cfg.minPriceUsdScaled)} - $${formatPrice(cfg.maxPriceUsdScaled)}`}
          tip="Minimum and maximum silver price the protocol will accept. A price outside this range is rejected."
        />
        <Metric
          title="Max jump / decay"
          value={`${(cfg.maxPriceDeltaBps / 100).toFixed(2)}% / ${(cfg.priceDeltaDecaySeconds / 3600).toFixed(1)}h`}
          tip="Largest allowed move versus the last recorded price, and how quickly that limit relaxes over time."
        />
        <Metric
          title="Min publishers"
          value={`${cfg.minPublishers}`}
          tip="Minimum Lazer publishers required in a price aggregate. The launch GO-gate requires raising this to at least 2 (via Propose price-feed safety) BEFORE unpausing. A value of 1 is the bare structural floor and is not safe to operate on."
        />
        <Metric
          title="Lazer feed id"
          value={`${cfg.pythLazerFeedId}`}
          tip="The Pyth Lazer feed id the protocol prices from (SILV = 3304)."
        />
      </Section>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-3 flex items-center text-sm uppercase tracking-wide text-muted">
          Pending changes ({activePending.length})
          <Tip text="Sensitive changes that have been proposed and are waiting out the change delay. Each can be executed once the delay passes, or cancelled by a guardian before then." />
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
    </div>
  );
}

/* ---------------- Actions ---------------- */

/* ---------------- Help ---------------- */

function HelpTab() {
  return (
    <div className="space-y-5 rounded-xl border border-border bg-card p-8 text-sm leading-relaxed text-muted">
      <div>
        <h3 className="mb-2 text-base text-white">What this console is</h3>
        <p>
          A read-only view of the live protocol state plus the controls an
          operator uses to run it. Viewing data never changes anything.
          Actions are explicit and either take effect immediately or after a
          24-hour delay.
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-base text-white">Why you signed a message</h3>
        <p>
          Connecting a wallet only links the extension. Signing the message
          proves you actually control the wallet key. It is a signature only -
          no transaction, no fee, nothing is sent on-chain. The proof lasts
          for the browser session.
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-base text-white">How SILV is backed</h3>
        <p>
          Every SILV represents one troy ounce of physical silver held in
          vault custody. The protocol does not hold a USDC reserve; the USDC
          in the treasury exists only to pay out redemptions. The maximum SILV
          supply is a hard ceiling that should only be raised after buying
          matching physical silver.
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-base text-white">
          Instant vs delayed changes
        </h3>
        <p>
          Low-risk operational settings (the redemptions switch, supply cap,
          instant budget, window, threshold, queue delay) change instantly.
          Sensitive settings (fees, treasury withdrawals, price-feed safety,
          metadata, ownership) are proposed and only take effect after a
          24-hour delay, during which a guardian can cancel them.
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-base text-white">
          How redemptions work
        </h3>
        <p>
          Small redemptions that fit the instant budget and that the treasury
          can cover are paid instantly. Larger ones, or ones beyond the
          instant budget, go to a queue: the user&apos;s SILV is burned
          immediately and they claim their USDC after the queue delay, priced
          at claim time. If the treasury cannot cover a claim, the request
          stays open and the operator pays the user off-chain, then marks it
          settled here so it cannot be claimed again.
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-base text-white">
          Pause & guardians
        </h3>
        <p>
          Pause immediately blocks all minting and redeeming for emergencies.
          Guardians are trusted keys that can pause and cancel pending
          changes, but can never move funds or change settings on their own.
        </p>
      </div>
    </div>
  );
}

/**
 * The guardian roster, with the removal countdown.
 *
 * AUDIT review of daac4ac (P1): DOM-007 defers guardian removal so the TARGETED
 * guardian has a full timelock window to react, including cancelling its own
 * removal. That property is worthless if the guardian cannot see it is under notice,
 * and `pending_removal_at` was read nowhere in either app. This is the only surface
 * that shows it.
 */
function GuardianRoster({ guardians }: { guardians: GuardianView[] }) {
  if (!guardians.length) {
    return (
      <Section title="Guardian roster">
        <p className="text-sm text-muted">
          No guardian accounts found. The guardian veto is not configured, so
          nothing can cancel a pending admin action except the admin itself.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Guardian roster">
      <div className="col-span-full overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="py-2 pr-4">Guardian</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Removal</th>
              <th className="py-2">Self-veto</th>
            </tr>
          </thead>
          <tbody>
            {guardians.map((g) => {
              const untilRemoval = secondsUntil(g.pendingRemovalAt);
              const untilCooldown = secondsUntil(g.cooldownUntil);
              return (
                <tr
                  key={g.guardian.toBase58()}
                  className="border-t border-border align-top"
                >
                  <td className="py-2 pr-4 font-mono text-xs">
                    {g.guardian.toBase58()}
                  </td>
                  <td className="py-2 pr-4">
                    {g.active ? (
                      <span className="text-accent">active</span>
                    ) : (
                      <span className="text-muted">
                        removed
                        {untilCooldown !== null && untilCooldown > 0
                          ? ` (re-add ${formatCountdown(untilCooldown)})`
                          : ""}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {untilRemoval === null ? (
                      <span className="text-muted">not scheduled</span>
                    ) : untilRemoval > 0 ? (
                      <span className="text-amber-400">
                        scheduled, fires {formatCountdown(untilRemoval)}
                      </span>
                    ) : (
                      <span className="text-red-400">
                        due now ({formatCountdown(untilRemoval)}), anyone may
                        finalize
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    {g.selfCancelUsed ? (
                      <span className="text-muted">used</span>
                    ) : (
                      <span className="text-accent">available</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted">
          A guardian under notice keeps every power until the removal is
          finalized, and may cancel its own removal ONCE. After that only the
          admin can cancel it, so a rogue guardian cannot make itself
          permanently unremovable.
        </p>
      </div>
    </Section>
  );
}

/* ---------------- shared UI ---------------- */

function Tip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1.5 inline-flex align-middle">
      <button
        type="button"
        aria-label="Explanation"
        className="grid h-4 w-4 place-items-center rounded-full border border-border text-[10px] font-bold leading-none text-muted hover:border-accent hover:text-accent focus:outline-none focus:ring-1 focus:ring-accent"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-30 w-64 -translate-x-1/2 rounded-md border border-border bg-bg p-3 text-left text-xs font-normal normal-case leading-relaxed text-muted opacity-0 shadow-xl transition group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
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
  tip,
}: {
  label: string;
  value: string;
  good: boolean;
  tip?: string;
}) {
  return (
    <div
      className={`min-w-[150px] flex-1 rounded-lg border ${good ? "border-border" : "border-danger"} bg-card p-4`}
    >
      <div className="flex items-center text-xs uppercase tracking-wide text-muted">
        {label}
        {tip && <Tip text={tip} />}
      </div>
      <div
        className={`mt-1 text-lg font-semibold ${good ? "text-white" : "text-danger"}`}
      >
        {value}
      </div>
    </div>
  );
}

function Metric({
  title,
  value,
  tip,
}: {
  title: string;
  value: string;
  tip?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center text-xs uppercase tracking-wide text-muted">
        {title}
        {tip && <Tip text={tip} />}
      </div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}

