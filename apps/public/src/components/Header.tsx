"use client";

import dynamic from "next/dynamic";

// Dynamic import with SSR disabled to avoid hydration mismatch.
// WalletMultiButton renders different markup on the server vs client because
// the wallet's connected state is only known in the browser (it reads
// localStorage / extension APIs that don't exist on the server).
const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

export function Header() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-3" aria-label="Dominion home">
          <div className="h-8 w-8 rounded-md bg-accent" aria-hidden />
          <div className="font-mono text-sm uppercase tracking-[0.2em]">Dominion</div>
        </a>
        <div className="flex items-center gap-4">
          <nav className="hidden items-center gap-6 text-sm text-muted md:flex">
            <a href="https://dominion.market" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              About
            </a>
            <a href="https://docs.dominion.market" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              Docs
            </a>
            <a href="https://dominion.market/verify" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              Verify
            </a>
          </nav>
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}
