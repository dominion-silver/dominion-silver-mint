"use client";

import useSWR from "swr";
import { useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import {
  fetchConfig,
  fetchTreasuryBalance,
  fetchSilvSupply,
  computeMaxInstantRedeemableUsdc,
} from "@/lib/anchor-client";
import { REFRESH_INTERVAL_MS } from "@/lib/constants";

function oz(raw: BN): string {
  return (raw.toNumber() / 1_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}
function usd(raw: BN): string {
  return (raw.toNumber() / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface Snapshot {
  supply: BN;
  maxSupply: BN;
  treasury: BN;
  instantAvail: BN;
  utilBps: number;
  redemptionsEnabled: boolean;
  paused: boolean;
}

export function ReservesPanel() {
  const { connection } = useConnection();
  const { data, error } = useSWR<Snapshot | null>(
    "dominion-reserves",
    async () => {
      const [cfg, treasury, supply] = await Promise.all([
        fetchConfig(connection),
        fetchTreasuryBalance(connection),
        fetchSilvSupply(connection),
      ]);
      if (!cfg) return null;
      const nowSecs = Math.floor(Date.now() / 1000);
      const instantAvail = computeMaxInstantRedeemableUsdc(
        cfg,
        treasury,
        nowSecs,
      );
      const maxSupply = cfg.maxSilvSupply;
      const utilBps = maxSupply.isZero()
        ? 0
        : supply.mul(new BN(10_000)).div(maxSupply).toNumber();
      return {
        supply,
        maxSupply,
        treasury,
        instantAvail,
        utilBps,
        redemptionsEnabled: cfg.redemptionsEnabled,
        paused: cfg.paused,
      };
    },
    { refreshInterval: REFRESH_INTERVAL_MS, revalidateOnFocus: false },
  );

  return (
    <div className="mt-6 rounded-xl border border-border/50 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.15em] text-accent">
          Reserves &amp; Supply
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              error ? "bg-danger" : "bg-accent"
            }`}
            aria-hidden
          />
          {error ? "Offline" : "Live"}
        </span>
      </div>

      {!data ? (
        <div className="py-6 text-center text-sm text-muted">
          {error ? "On-chain state unavailable" : "Loading on-chain state…"}
        </div>
      ) : (
        <>
          {/* Hero: SILV in circulation = troy oz of silver backed */}
          <div className="mb-1 text-center">
            <div className="font-mono text-4xl font-bold text-accent">
              {oz(data.supply)}
            </div>
            {/* Never attach the 1:1 backing claim to a live on-chain figure. Every number in this panel
                is a supply, an admin-set cap or a USDC balance, so the chain proves `supply <= cap` and
                nothing about custody (`admin_premint` mints with no USDC and no attestation). The claim
                is a product statement and belongs on the page as one, below. */}
            <div className="mt-1 text-xs text-muted">SILV in circulation</div>
            <div className="mt-0.5 text-[11px] text-muted/70">
              Each SILV represents 1 troy oz held in custody. Custody is attested off chain, not by
              the figures below.
            </div>
          </div>

          <div className="mt-5 space-y-px overflow-hidden rounded-lg border border-border/50">
            <Row
              label="Mint capacity (cap)"
              value={`${oz(data.maxSupply)} oz`}
              sub={`${(data.utilBps / 100).toFixed(2)}% used`}
            />
            {/* THE TREASURY BALANCE AND THE INSTANT-REDEEMABLE FIGURE BOTH USED TO SIT HERE, and both
                were removed on 2026-08-11 because this panel is the first thing a visitor reads.

                BOTH had to go, not just the treasury row. Instant-redeemable is the MINIMUM of the
                rolling-window budget and the treasury balance, so whenever the treasury is the
                binding constraint the second row printed the first row's number under a different
                name. Removing only the row that says "Treasury" would have moved the figure, not
                withdrawn it.

                It is not hidden, and nobody should think otherwise: the treasury is an on-chain
                account and anyone can read it. What changed is that a protocol-sizing number is no
                longer the headline of a page aimed at buyers.

                A user who is actually redeeming still needs it to size their own transaction, and
                still gets it: MintRedeemCard shows "Max instant now", in USDC and in approximate
                SILV, but only while the redeem tab is open.

                The `paused` and `redemptionsEnabled` states this row also carried are not lost.
                MintRedeemCard surfaces them where they change what the user can do, with a full
                sentence rather than a two-word subtitle. */}
          </div>

          <p className="mt-4 text-center text-xs leading-relaxed text-muted">
            Backed 1:1 by physical silver vaulted with Brink&apos;s. On-chain
            holds USDC only for redemption liquidity, not a reserve.{" "}
            <a
              href="https://dominion.market/verify"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              Proof of reserve
            </a>
          </p>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center justify-between bg-bg/40 px-4 py-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-right">
        <span className="font-mono text-sm font-semibold text-white">
          {value}
        </span>
        {sub && (
          <span className="ml-2 text-xs text-muted">{sub}</span>
        )}
      </span>
    </div>
  );
}
