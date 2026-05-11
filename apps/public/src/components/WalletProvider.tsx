"use client";

import { ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  LedgerWalletAdapter,
  CoinbaseWalletAdapter,
} from "@solana/wallet-adapter-wallets";
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
