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
      {/* `gap-3` and `min-w-0` are what stop the header colliding on a phone. Measured on production at
          320px: the "Select Wallet" label wrapped to two lines and clipped (scrollHeight 72 against a
          48px box), and the wordmark sat 23px UNDER the button. At 360px, the Galaxy and Pixel width, the
          disconnected button just cleared it but the CONNECTED trigger (wallet icon plus truncated
          address, about 176px) overlapped the wordmark by 23px. So the header was broken for connected
          users at the single most common Android width, and only for connected users, which is why it
          survived every screenshot of the disconnected page. */}
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <a href="/" className="flex min-w-0 items-center gap-3" aria-label="Dominion home">
          {/* The brand shield, the same transparent asset dominion.market serves. It replaces a
              plain accent-coloured square that stood in for the logo. A plain <img> rather than
              next/image: a 500px PNG needs no optimiser, and next/image would route it through
              /_next/image for nothing. */}
          <img src="/logo.png" alt="" aria-hidden className="h-8 w-8 shrink-0" />
          {/* The wordmark is the one place the display serif earns its keep, set the way the site's
              header sets it: Cormorant Garamond, wide tracking, in the heading colour. */}
          <div className="truncate font-display text-lg tracking-brand text-fg">DOMINION</div>
        </a>
        <div className="flex shrink-0 items-center gap-4">
          {/* "Docs" pointed at https://docs.dominion.market, which does NOT EXIST: NXDOMAIN against both
              1.1.1.1 and 8.8.8.8, and curl cannot resolve the host. Removed rather than repointed,
              because a nav item that goes to the marketing site under the label "Docs" is its own small
              lie. Put it back when the subdomain exists. */}
          <nav className="hidden items-center gap-6 text-sm text-muted md:flex">
            <a href="https://dominion.market" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              About
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
