"use client";

import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { Dashboard } from "@/components/Dashboard";
import { WalletAuthGate } from "@/components/WalletAuthGate";

// SSR-disabled (wallet state is client-only) -> avoids the React #418
// hydration mismatch the static import caused.
const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

export default function AdminPage() {
  const wallet = useWallet();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          {/* THE BRAND SHIELD, the same transparent asset dominion.market and apps/public serve. It
              replaces a plain accent-coloured square, which read as a placeholder and, once the accent
              stopped being green, would have been a periwinkle square instead of a logo.
              A plain <img> rather than next/image, matching apps/public: a 500px PNG needs no
              optimiser and next/image would route it through /_next/image for nothing. */}
          <div className="flex min-w-0 items-center gap-3">
            <img src="/logo.png" alt="" aria-hidden className="h-8 w-8 shrink-0" />
            <div className="min-w-0">
              {/* The wordmark is the one place the display serif earns its keep, set the way the site's
                  header sets it: Cormorant Garamond, brand tracking, in the heading colour. It was in
                  the MONO face at 0.2em, which is the one face the brand does not use for it. */}
              <div className="truncate font-display text-lg tracking-brand text-fg">
                DOMINION
              </div>
              {/* Kept: this console must never be mistaken for the public app, because every control
                  in it is an emergency lever. */}
              <div className="text-xs text-subtle">Admin console</div>
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
