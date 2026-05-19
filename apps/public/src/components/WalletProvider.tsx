"use client";

import { ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
// CODEX P1-02: import the 4 supported adapters from their DIRECT packages
// instead of the `@solana/wallet-adapter-wallets` umbrella, which pulled
// unused Torus/Trezor/WalletConnect/Reown chains (and their high/critical
// npm advisories) into the production graph.
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { LedgerWalletAdapter } from "@solana/wallet-adapter-ledger";
import { CoinbaseWalletAdapter } from "@solana/wallet-adapter-coinbase";
import { HELIUS_RPC } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

export function WalletContextProvider({ children }: { children: ReactNode }) {
  const endpoint = HELIUS_RPC;
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new LedgerWalletAdapter(),
      new CoinbaseWalletAdapter(),
    ],
    []
  );

  // FE-L11: autoConnect is intentional. The mint/redeem app's only privileged
  // operation is balance fetch (read-only). Without autoConnect, every page
  // refresh asks the user to reconnect, which is friction with no security
  // benefit. The wallet adapter only auto-connects to the LAST CONNECTED
  // wallet, not arbitrary new wallets.
  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
