"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Dashboard } from "@/components/Dashboard";

export default function AdminPage() {
  const wallet = useWallet();

  // TODO: verify wallet is a member of OPS_SQUADS_MULTISIG via @sqds/multisig SDK.
  const isAuthorized = wallet.connected; // placeholder

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-accent" aria-hidden />
            <div>
              <div className="font-mono text-sm uppercase tracking-[0.2em]">Dominion</div>
              <div className="text-xs text-muted">Admin console</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted sm:inline">
              {wallet.connected ? "Squads-gated" : "Connect a member wallet"}
            </span>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {!wallet.connected ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <h2 className="mb-2 text-xl font-semibold">Connect Ops Squads member wallet</h2>
            <p className="mb-6 text-sm text-muted">
              This console is restricted to members of the Ops Squads multisig. Actions create
              Squads proposals that require threshold signatures before execution.
            </p>
            <WalletMultiButton />
          </div>
        ) : !isAuthorized ? (
          <div className="rounded-xl border border-danger bg-danger/10 p-6 text-danger">
            Wallet is not a member of the Ops Squads multisig.
          </div>
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}
