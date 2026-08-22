# Dominion Public UI (mint/redeem)

Next.js 15 app at `app.dominion.market`. Users mint SILV with USDC, or burn SILV to redeem USDC.

## Setup

```bash
cd apps/public
yarn install
cp .env.example .env.local  # fill in HELIUS/TRITON keys
yarn dev
```

## Structure

```
src/
├── app/
│   ├── layout.tsx          # root with WalletContextProvider
│   ├── page.tsx            # mint/redeem card
│   └── globals.css         # Tailwind + wallet-adapter overrides
├── components/
│   ├── WalletProvider.tsx  # Solana wallet adapter wiring
│   ├── Header.tsx          # logo + nav + connect button
│   ├── PriceBanner.tsx     # live Pyth XAG/USD price
│   └── MintRedeemCard.tsx  # core interaction card
└── lib/
    ├── constants.ts        # program ID, mints, RPCs, PDA seeds
    ├── pdas.ts             # PDA derivation helpers
    └── pyth.ts             # Pyth Hermes fetcher + effective price math
```

## TODO (once Anchor IDL is available)

1. Generate Anchor client from `target/idl/dominion_silver_mint.json`.
2. Wire `MintRedeemCard.onClick` to build + simulate + sign + send real txs via `Program<DominionSilverMint>`.
3. Fetch `ConfigAccount` state on mount (premiums, caps, reserve params); replace mock constants.
4. Compute `max_redeemable_silv` from on-chain `treasury_balance`, `silv_mint.supply`, `reserve_check_price`, and `treasury_min_reserve_bps`.
5. Tx construction: prepend `ComputeBudgetProgram.setComputeUnitLimit(400_000)` and priority fee from Helius.
6. Dual-RPC simulation (Helius + Triton) with divergence warning.
7. Blockaid / Blowfish integration for pre-sign warnings.
8. Success UI with tx signature + Solscan link.
9. Historical balance + tx history.

## Security

- CSP + HSTS + X-Frame-Options via `next.config.ts`.
- Wallet adapter only, no custom signing paths.
- RPC behind API key (Helius/Triton) with referrer allowlist.
- Blockaid / Blowfish pre-sign warnings (TBD).
- No analytics / tracking.
