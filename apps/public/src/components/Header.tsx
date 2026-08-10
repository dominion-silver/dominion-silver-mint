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
          {/* The brand shield, the same transparent asset dominion.market serves. It replaces a
              plain accent-coloured square that stood in for the logo. A plain <img> rather than
              next/image: a 500px PNG needs no optimiser, and next/image would route it through
              /_next/image for nothing. */}
          <img src="/logo.png" alt="" aria-hidden className="h-8 w-8" />
          {/* The wordmark is the one place the display serif earns its keep, set the way the site's
              header sets it: Cormorant Garamond, wide tracking, in the heading colour. */}
          <div className="font-display text-lg tracking-brand text-fg">DOMINION</div>
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
