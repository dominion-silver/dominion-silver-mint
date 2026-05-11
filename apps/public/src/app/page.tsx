import { Header } from "@/components/Header";
import { PriceBanner } from "@/components/PriceBanner";
import { MintRedeemCard } from "@/components/MintRedeemCard";
import { TransactionHistory } from "@/components/TransactionHistory";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Header />
      <PriceBanner />
      <main className="mx-auto max-w-2xl px-6 py-12">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-bold tracking-tight">
            Mint or redeem SILV
          </h1>
          <p className="text-sm text-muted">
            1 SILV = 1 troy ounce LBMA silver, vaulted with Brink's. Priced via Pyth XAG/USD.
          </p>
        </div>
        <MintRedeemCard />
        <TransactionHistory />
        <footer className="mt-12 text-center text-xs text-muted">
          <p>
            <a
              href="https://dominion.market"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white"
            >
              dominion.market
            </a>{" "}
            ·{" "}
            <a
              href="https://dominion.market/verify"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              proof of reserve
            </a>{" "}
            ·{" "}
            <a
              href="https://solscan.io/account/J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5?cluster=devnet"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              contract on Solscan
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}
