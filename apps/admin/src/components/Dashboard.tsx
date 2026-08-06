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

  // The public devnet RPC rate-limits heavy reads. Keep the lightweight
  // snapshot resilient (retry + keep last good data) so a transient
  // "Failed to fetch" auto-recovers instead of nuking the page.
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
  // Only fire the heavy redemption-list query AFTER the snapshot loads, and
  // refresh it slowly, so the two don't saturate the RPC together.
  // The fetcher THROWS on failure (P2-01 review-of-fixes). With
  // real burned-SILV IOUs with a degraded banner instead of an empty queue.
  // AUDIT review of daac4ac (P1): `pending_removal_at` was written on-chain and
  // read by neither app. DOM-007's security property is that the TARGETED guardian
  // has a full timelock window to react, which requires the console to show that a
  // removal exists and when it fires. Cheap query (a handful of small accounts),
  // and it is the only place a guardian can see it is under notice.
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
      {/* AUDIT FINDING A-01. The snapshot used to convert a failed treasury or supply read into zero and
          return successfully, so the operator saw Treasury $0 / supply 0 oz / 0% cap used with no
          warning and could act on it: a withdrawal, a premint, an opening, all decided on numbers that
          were never read. This banner sits above the tabs deliberately, because the figures it taints
          are spread across several of them and a per-tile marker is missable. */}
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
          tip="Master on/off switch for users selling SILV back for USDC. When OFF, redeem_silv reverts. It does NOT touch minting: this tooltip claimed 'no new mints or redemptions are accepted' (audit A-02), and an operator containing a treasury incident would have closed redemptions, trusted that sentence, and left public mint open the whole time. Minting is governed separately by public_mint_enabled and by paused. To stop everything, use Paused."
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
 * The fee vault, and specifically whether it EXISTS.
 *
 * This panel is here because `fetchFeeVaultBalance` was written to surface a deploy blocker and
 * then never called from anywhere, so the blocker stayed invisible: `mint_silv` and `redeem_silv`
 * both take the vault as a REQUIRED account, and if it does not exist every mint and every redeem
 * reverts with a constraint error that reads like a client bug. An operator had no way to check
 * the precondition before opening the mint.
 *
 * Hence the deliberate three-state render. `null` is NOT "zero": it means the account is absent
 * and the protocol is one open away from being unusable, so it gets a danger banner and the fix
 * command, not a dash.
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
        {/* "Large-redeem threshold" and "Queue delay" REMOVED 2026-08-05. Both fields still
            decode and still hold their old defaults, but no on-chain instruction reads them, and
            their tips described a queue that no longer exists. They sat immediately above the
            panel that says the queue was deleted, so the operator got two contradictory answers
            on one screen and the wrong one rendered as a live metric. */}
        <Metric
          title="Instant budget per window"
          value={`$${formatUsdc(cfg.instantRedeemBudgetUsdc)}`}
          tip="Maximum total treasury OUTFLOW per window, across all users combined. Debited by the GROSS value leaving the treasury (the payout plus the premium leg), not by what the user receives. Exceeding it reverts: there is no queue to fall back to."
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

// The QUEUED redemption path was DELETED on 2026-08-05: redemption is now a single instant
// route, so the program has no RedemptionRequest account type left and there is nothing to
// list here.
//
// This panel is KEPT rather than deleted, on purpose. An operator who remembers the queue
// would otherwise find the tab silently missing a section and wonder whether it failed to
// load. It also states what replaced the queue, because "the queue is gone" on its own invites
// the wrong mental model: the limits did not disappear, they changed shape.
function RedemptionQueue() {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="mb-2 flex items-center text-sm uppercase tracking-wide text-muted">
        Redemption queue (removed)
        <Tip text="The T+3 queue, the per-size tier and the admin off-chain settlement path were all deleted on 2026-08-05. That also removed SolidProof MEDIUM #4, where the admin could mark a request settled with no on-chain proof while the user's SILV was already burned." />
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
          2026-08-05, which also removed SolidProof MEDIUM #4.
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
function GuardianRoster({
  guardians,
  degraded,
}: {
  guardians: GuardianView[];
  degraded: boolean;
}) {
  // Review-of-fixes F4: the fetch error used to be DISCARDED, so any RPC failure
  // (devnet 429, a transient getProgramAccounts error) rendered the affirmative claim
  // below. A guardian actually under notice would have been told, positively, that no
  // guardians exist. That is the same failure this panel was built to fix ("a veto
  // nobody can see is not a veto"), inverted into a veto the console denies exists.
  // An unknown state must never be reported as a known-empty one.
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
                      // The state guardian_count cannot express: registered, not in
                      // cooldown, and yet refused by every authorization site because
                      // this key IS the admin. Called out loudly, because the count
                      // claims a veto that no independent key can exercise.
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
                      // Review-of-fixes: without this branch the cell said "due now,
                      // anyone may finalize" forever, including long after the notice
                      // died. finalize then reverts GuardianRemovalExpired, so the one
                      // surface built to make the veto visible was misreporting the
                      // rule shipped alongside it.
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

