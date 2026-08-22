# Dominion Silver (SILV)

**1 SILV = 1 troy ounce of physical LBMA silver**, held in vault custody. SILV is minted by paying
USDC at the live silver price plus a premium, and redeemed back to USDC. Live on Solana mainnet.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Anchor](https://img.shields.io/badge/Anchor-0.31.1-blue.svg)](https://www.anchor-lang.com/)

## Mainnet addresses

| | |
|---|---|
| Program | `3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ` |
| SILV mint | `SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L` |
| Quote asset | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Authorities are published in [`config/mainnet-authorities.json`](config/mainnet-authorities.json) and
can be checked against the chain with `scripts/verify-mainnet-authorities.ts`. They are public keys, so
anyone can confirm the deployed program's authorities match what is announced.

## The token, for integrators

SILV is a Token-2022 mint with **6 decimals**. It carries exactly three extensions:

| Extension | Value |
|---|---|
| `PermanentDelegate` | `FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3` |
| `MetadataPointer` | self |
| `TokenMetadata` | name, symbol, URI |

There is **no `TransferHook` and no `TransferFee`**, so ordinary Token-2022 transfers and AMM swaps
behave normally and no per-transfer logic can fail. Mint and redemption premiums are charged inside the
protocol's own instructions, never on a transfer.

Because SILV is a claim on physical metal, the freeze authority and the permanent delegate exist so a
court order, a sanctions designation, or a theft where the metal has not moved can be answered. Both are
held by a 3-of-5 Squads multisig vault, so a quorum can freeze or move SILV held in any account,
including an exchange account or a liquidity position. We state this plainly rather than in a footnote.

## How pricing works

Mint and redemption are priced by a signed Pyth Lazer envelope for feed `3154`
(`Metal.Index.SILVER/USD`), verified on chain. The program enforces a minimum publisher count and a
staleness ceiling, and one signed envelope prices exactly one operation, so a replay is refused.

The all-in mint price is

```
price_per_oz = spot / (1 - premium_bps / 10_000)
```

which is not the same as `spot * (1 + premium_bps / 10_000)`. Redemption proceeds are
`spot * (1 - premium_bps / 10_000)`. Current premiums and the supply cap are on-chain config and can be
read from the program's `ConfigAccount`.

## Verifying the deployed program

The point of this repository being public is that anyone can reproduce the deployed bytes.

```bash
solana-verify verify-from-repo \
  --program-id 3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ \
  --library-name dominion_silver_mint \
  https://github.com/dominion-silver/dominion-silver-mint
```

SBF builds are not byte-identical across host platforms, so the container build is the artifact to
compare against. CI runs the same check on every change to the default branch.

## Building from source

Requires Rust 1.89.0, Solana CLI 3.0.x with platform-tools, Anchor 0.31.1, and Node 20+.

```bash
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked
cargo test -p dominion_silver_mint
```

```
programs/dominion_silver_mint_v2/   the on-chain program (crate: dominion_silver_mint)
apps/public/                        mint and redeem frontend
apps/admin/                         operator dashboard
```

## License

[Apache License 2.0](LICENSE).
