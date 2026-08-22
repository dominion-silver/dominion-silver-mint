"use client";

import { useState } from "react";
import useSWR from "swr";
import { useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchDashboardSnapshot,
  fetchGuardians,
  formatUsdc,
  formatSilv,
  formatPrice,
  formatCountdown,
  secondsUntil,
  type DashboardSnapshot,
  type GuardianView,
} from "../lib/anchor-client";
import { fetchFeeVaultBalance } from "../lib/admin-actions";
import { REFRESH_INTERVAL_MS } from "../lib/constants";
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

  // The public devnet RPC rate-limits heavy reads, so retry and keep the last good data: a transient
  // "Failed to fetch" must auto-recover instead of blanking the page.
  const { data, error } = useSWR<DashboardSnapshot | null>(
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
  // Gated on the snapshot and refreshed slowly so the two queries never saturate the RPC together. The
  // fetcher THROWS on failure rather than returning [], because an unknown roster must not render as a
  // known-empty one. This is the only surface that shows `pending_removal_at`, and 's guarantee
  // is that a TARGETED guardian can see its own notice and react inside the timelock window.
  const { data: guardians, error: guardiansError } = useSWR<GuardianView[]>(
    data ? "dominion-guardians" : null,
    () => fetchGuardians(connection, data?.cfg.admin),
    {
      refreshInterval: 20_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 10_000,
    },
  );


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
      {/* A failed read renders as zero, so it MUST be announced: an operator cannot be allowed to
          withdraw or premint on a Treasury $0 that was never read. Above the tabs on purpose, because
          the tainted figures are spread across several of them and a per-tile marker is missable. */}
      {data.degraded.length > 0 && (
        <div className="rounded-md border border-danger bg-danger/10 p-4 text-sm text-danger">
          <div className="font-semibold">
            DEGRADED SNAPSHOT: {data.degraded.length} on-chain read(s) FAILED.
          </div>
          <ul className="mt-1 list-inside list-disc text-xs">
            {data.degraded.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <div className="mt-2 text-xs">
            The affected figures below are showing ZERO because they could not be read, not because
            they are zero. Do NOT withdraw, premint, or change a limit until this clears.
          </div>
        </div>
      )}
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
        <RedemptionsTab data={data} />
      )}
      {tab === "governance" && (
        <GovernanceTab
          data={data}
          guardians={guardians ?? []}
          guardiansDegraded={!!guardiansError}
        />
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
          tip="Master on/off switch for users selling SILV back for USDC. When OFF, redeem_silv reverts. It does NOT touch minting. Closing redemptions during a treasury incident leaves public mint open, so do not rely on this switch alone. Minting is governed separately by public_mint_enabled and by paused. To stop everything, use Paused."
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

/* ---------------- Premium fee vault ---------------- */

/**
 * The fee vault, and specifically whether it EXISTS. Three states, and `null` is NOT zero: it means the
 * account is absent, and since `mint_silv` and `redeem_silv` both take it as a REQUIRED account, every
 * mint and redeem then reverts with what looks like a client bug. That state gets a danger banner and
 * the fix command, never a dash, because it is a launch blocker an operator must check before opening.
 */
function FeeVault() {
  const { connection } = useConnection();
  const { data, error, isLoading } = useSWR(
    "fee-vault-balance",
    () => fetchFeeVaultBalance(connection),
    { refreshInterval: REFRESH_INTERVAL_MS, keepPreviousData: true },
  );

  const missing = data === null && !isLoading && !error;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="mb-2 flex items-center text-sm uppercase tracking-wide text-muted">
        Premium fee vault
        <Tip text="Where the mint and redeem premiums accrue. It is a program-owned account (the USDC ATA of the fee_vault PDA), so it can never be closed and no admin typo can redirect it. Sweep it with the 'Withdraw accrued fees' action; the destination is chosen per sweep." />
      </h3>

      {missing ? (
        <div className="rounded-md border border-danger bg-danger/10 p-4 text-sm text-danger">
          <div className="font-semibold">
            THE FEE VAULT DOES NOT EXIST. Do not open public mint or redemption.
          </div>
          <div className="mt-2">
            Both mint_silv and redeem_silv require this account. Until it is
            created, every mint and every redeem will revert
            (AccountNotInitialized), which looks like a broken product rather
            than a missing setup step.
          </div>
          <div className="mt-2 font-mono text-xs">
            npx tsx scripts/create-fee-vault.ts
          </div>
          <div className="mt-2">
            It only has to be created once per cluster. A PDA-owned token
            account cannot be closed, so this can never regress afterwards.
          </div>
        </div>
      ) : error ? (
        <div className="rounded-md border border-warning bg-warning/10 p-4 text-sm text-warning">
          Could not read the fee vault (RPC error, retrying). This is NOT
          &quot;the vault is missing&quot;: the two states are different and
          only the missing one blocks a launch.
        </div>
      ) : (
        <>
          <div className="text-2xl">
            ${data != null ? formatUsdc(new BN(data.toString())) : "..."}
          </div>
          <p className="mt-2 text-xs text-muted">
            Accrued premium, withdrawable instantly by the admin. It backs
            nothing: user redemptions draw on the treasury, not on this. Sweep
            on a regular cadence so the standing balance stays small, since
            this is the one instant money movement in the program.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------- Redemptions ---------------- */

function RedemptionsTab({
  data,
}: {
  data: DashboardSnapshot;
}) {
  const {
    cfg,
    effectiveUsedUsdc,
    instantBudgetRemainingUsdc,
    instantWindowExpired,
    instantWindowNeverStarted,
  } = data;
  return (
    <div className="space-y-6">
      <Section title="Redemption routing">
        {/* Do not render `largeRedeemThresholdUsdc` or the queue delay here. Both still decode and still
            hold their old defaults, but no instruction reads them, so they render as live metrics that
            contradict the panel below saying the queue is gone. */}
        <Metric
          title="Instant budget per window"
          value={`$${formatUsdc(cfg.instantRedeemBudgetUsdc)}`}
          tip="Maximum total treasury OUTFLOW per window, across all users combined. Debited by what ACTUALLY LEAVES: the payout plus the premium leg while fee routing is ON, and the payout alone while it is OFF (the premium is then retained, so it never leaves). This said the GROSS is always debited, which overstates the consumed capacity by the premium (1.5% at launch) during exactly the incident that turns routing off. Exceeding it reverts: there is no queue to fall back to."
        />
        <Metric
          title="Window length"
          value={`${(cfg.instantRedeemWindowSeconds / 3600).toFixed(1)}h`}
          tip="Length of the SLIDING window the redemption budget is measured over. Nothing 'resets': the previous window's usage decays out linearly as this one fills. The worst case is still TWICE the budget, but it now requires two drains nearly a full window apart rather than one second apart, which is the difference between an unobservable event and one a guardian can pause during. Size the budget at half the daily outflow you are willing to see."
        />
        <Metric
          title="Counting against the budget now"
          value={
            instantWindowNeverStarted
              ? "$0 (none yet)"
              : `$${formatUsdc(effectiveUsedUsdc)}`
          }
          tip="What the PROGRAM currently counts: this bucket's usage plus the previous bucket's, weighted by how much of it still lies inside the trailing window. This used to render cfg.instantUsedUsdc with a '(window reset)' label, which understated it for most of every window and read as $0 in exactly the state where the program had almost no headroom left."
        />
        <Metric
          title="Instant remaining now"
          value={`$${formatUsdc(instantBudgetRemainingUsdc)}`}
          tip="Instant redemption value still available in the current window."
        />
      </Section>

      <FeeVault />

      <RedemptionQueue />
    </div>
  );
}

// The program has no RedemptionRequest type left, so there is nothing to list. This panel is kept
// deliberately: an operator who remembers the queue would otherwise read a missing section as a failed
// load, and needs to be told what replaced it, since the limits changed shape rather than disappeared.
function RedemptionQueue() {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="mb-2 flex items-center text-sm uppercase tracking-wide text-muted">
        Redemption queue (removed)
        <Tip text="The T+3 queue, the per-size tier and the admin off-chain settlement path do not exist. There is no path for an admin to mark a redemption settled without on-chain proof." />
      </h3>
      <p className="mb-3 text-xs text-muted">
        Redemption is a single instant route: burn SILV, receive USDC, in one
        transaction. There are no pending requests to track, no burned SILV
        sitting on an IOU, and no off-chain settlement step.
      </p>
      <p className="text-xs text-muted">
        What bounds a redemption now: the global rolling budget shown above, and
        the treasury USDC balance. Exceeding either reverts the transaction.
      </p>
    </div>
  );
}


/* ---------------- Governance ---------------- */

function GovernanceTab({
  data,
  guardians,
  guardiansDegraded,
}: {
  data: DashboardSnapshot;
  guardians: GuardianView[];
  guardiansDegraded: boolean;
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

      <GuardianRoster guardians={guardians} degraded={guardiansDegraded} />

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
          tip="The Pyth Lazer feed id the protocol prices from. 3154 = Metal.Index.SILVER/USD, pure spot with NO premium baked in: all protocol margin lives in the premium settings instead."
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
          Low-risk operational settings change instantly: lowering the supply
          cap, tightening the redemption budget or window, CLOSING redemptions
          or public mint, the fee-exemption whitelist, the fee sweep and the
          KYC scope. Note both switches are close-only: OPENING redemptions or
          public mint takes the 24-hour path.
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
          One instant route. The user burns SILV and receives USDC from the
          treasury in the same transaction, or the whole thing reverts and
          their SILV is untouched. Two things can refuse it: the sliding
          window budget (retry once it decays) and the treasury balance. There
          is no queue, no burned-SILV IOU and no off-chain settlement step. The
          T+3 queue and the off-chain settlement instruction were deleted on
          removed.
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
 * The guardian roster, with the removal countdown. defers removal so the TARGETED guardian can
 * react inside the timelock window, including cancelling its own removal once, which is worthless if it
 * cannot see the notice. This is the only surface that reads `pending_removal_at`.
 */
function GuardianRoster({
  guardians,
  degraded,
}: {
  guardians: GuardianView[];
  degraded: boolean;
}) {
  // An unknown roster must never be reported as a known-empty one. Discarding the fetch error let any
  // RPC failure render the affirmative "no guardians exist" claim below, at a guardian under notice.
  if (degraded && !guardians.length) {
    return (
      <Section title="Guardian roster">
        <p className="text-sm text-amber-400">
          Could not read the guardian accounts (RPC error). This is NOT a
          statement that no guardians exist: the roster is unknown right now.
          Retrying automatically.
        </p>
      </Section>
    );
  }
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
                    {g.inertBecauseAdmin ? (
                      // The state guardian_count cannot express: registered and not in cooldown, yet
                      // refused by every authorization site because this key IS the admin. Loud,
                      // because the count claims a veto no independent key can exercise.
                      <span className="text-red-400">
                        INERT: this key is the admin
                      </span>
                    ) : g.active ? (
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
                    ) : g.removalExpired ? (
                      // Distinct from "due now": past the expiry, finalize reverts
                      // GuardianRemovalExpired and a new removal must be scheduled.
                      <span className="text-muted">
                        notice EXPIRED, no longer finalizable (schedule a new one)
                      </span>
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
        {degraded && (
          <p className="mt-3 text-xs text-amber-400">
            Showing the last successful read; the latest refresh failed, so this
            may be stale.
          </p>
        )}
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

