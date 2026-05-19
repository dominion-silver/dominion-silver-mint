"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Dashboard } from "@/components/Dashboard";
import { WalletAuthGate } from "@/components/WalletAuthGate";

export default function AdminPage() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-accent" aria-hidden />
            <div>
              <div className="font-mono text-sm uppercase tracking-[0.2em]">
                Dominion
              </div>
              <div className="text-xs text-muted">Admin console</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted sm:inline">
              {wallet.connected ? "Wallet linked" : "Connect wallet"}
            </span>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <WalletAuthGate>
          <Dashboard />
        </WalletAuthGate>
      </main>
    </div>
  );
}
