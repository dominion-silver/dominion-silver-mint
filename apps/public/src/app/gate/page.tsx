import type { Metadata } from "next";

/**
 * The pre-launch announcement, and the only page an anonymous visitor can reach.
 *
 * It is a server component with a plain HTML form posting to /api/gate: no client JavaScript, no
 * state, nothing to hydrate. A launch page that fails to render is worse than a plain one, and this
 * is the page every early link will land on.
 *
 * THE MINT ADDRESS IS DELIBERATELY ABSENT. It belongs on a launch page, and it will go here, but
 * `SILV_MINT` in lib/constants.ts still holds the DEVNET mint: the mainnet token is pre-generated and
 * not yet created, and runbook step 6c is what swaps the constant over. Rendering the constant today
 * would publish a devnet address to everyone who reads this page, and someone would add a worthless
 * token to a watchlist on our authority. Hardcoding the mainnet address here instead would put a
 * second SILV literal in the tree, which is exactly what the constants gate and its RETIRED_MINTS
 * list exist to prevent. So it waits for 6c.
 */
export const metadata: Metadata = {
  title: "Dominion Silver: SILV goes live 13 August 2026, 15:00 UTC",
  description:
    "SILV is tokenized physical silver on Solana. One SILV represents one troy ounce held in allocated, audited vault storage. Live 13 August 2026 at 15:00 UTC.",
};

export default function GatePage({
  searchParams,
}: {
  searchParams?: Promise<{ e?: string }>;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 py-16 text-center">
      <img src="/logo.png" alt="" aria-hidden className="mb-8 h-20 w-20" />

      <h1 className="mb-3 text-4xl md:text-5xl">DOMINION</h1>
      <p className="mb-12 text-sm uppercase tracking-brand text-accent">Tokenized Silver</p>

      <div className="mb-12 w-full rounded-xl border border-border bg-card px-6 py-8">
        <p className="mb-2 text-xs uppercase tracking-[0.2em] text-subtle">SILV goes live</p>
        <p className="mb-1 font-display text-3xl tracking-[0.08em] text-fg">13 August 2026</p>
        <p className="text-lg font-semibold text-accent">15:00 UTC</p>
      </div>

      <div className="mb-12 space-y-4 text-sm leading-relaxed text-muted">
        <p>
          SILV is a Solana-based token backed one to one by physical silver. Each token represents one
          troy ounce held in allocated, audited vault storage.
        </p>
        <p>
          Holders get real-time price exposure to silver and full DeFi composability from day one.
          Mint and redeem open at launch.
        </p>
      </div>

      <form action="/api/gate" method="POST" className="w-full max-w-sm">
        <label htmlFor="password" className="mb-2 block text-xs uppercase tracking-[0.2em] text-subtle">
          Early access
        </label>
        <div className="flex gap-2">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-subtle focus:border-accent"
          />
          <button
            type="submit"
            className="rounded-md bg-cta px-5 py-2 text-sm font-semibold text-bg transition hover:brightness-110"
          >
            Enter
          </button>
        </div>
        <GateError searchParams={searchParams} />
      </form>

      <footer className="mt-16 text-xs text-subtle">
        <a
          href="https://dominion.market"
          className="underline hover:text-muted"
          target="_blank"
          rel="noopener noreferrer"
        >
          dominion.market
        </a>
      </footer>
    </main>
  );
}

/** Split out so the page itself stays synchronous; searchParams is a promise in Next 15. */
async function GateError({ searchParams }: { searchParams?: Promise<{ e?: string }> }) {
  const sp = searchParams ? await searchParams : undefined;
  if (sp?.e !== "1") return null;
  return (
    <p role="alert" className="mt-3 text-xs text-danger">
      That password is not correct.
    </p>
  );
}
