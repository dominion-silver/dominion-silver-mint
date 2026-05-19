# Dominion Silver

Solana smart contract + frontend for SILV, a token where **1 SILV = 1 troy ounce of physical LBMA silver** held in vault custody. Users mint SILV by paying USDC at the live Pyth XAG/USD price plus a configurable premium, and redeem SILV back to USDC.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Anchor](https://img.shields.io/badge/Anchor-0.31.1-blue.svg)](https://www.anchor-lang.com/)
[![Solana](https://img.shields.io/badge/Solana-3.1-9945FF.svg)](https://solana.com/)

---

## Repository layout

```
.
├── programs/
│   ├── dominion_silver_mint_v2/      Solana Anchor program (Rust) - ACTIVE
│   └── dominion_silver_mint_v1/      frozen pre-refactor reference (not built/deployed)
├── apps/
│   ├── public/                       mint/redeem frontend (Next.js)
│   └── admin/                        admin dashboard (Next.js)
├── scripts/                          devnet ops + integration scripts
└── tests/                            Anchor TypeScript tests
```

The active program is the `dominion_silver_mint_v2` crate (crate name
`dominion_silver_mint`). `dominion_silver_mint_v1` is a frozen reference of
the prior design and is excluded from the workspace; do not build or deploy
it.

## Build

### Toolchain

- Rust 1.89.0 (via rustup)
- Solana 3.1.x + platform-tools
- Anchor 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`)
- Node 20+ / npm

### Smart contract

```bash
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml
cargo test -p dominion_silver_mint
```

### Frontend (mint/redeem)

```bash
cd apps/public
npm install
npm run dev          # http://localhost:3000
npm run build
npm run typecheck
```

### Admin dashboard

```bash
cd apps/admin
npm install
npm run dev          # http://localhost:3001
```

## Status

Devnet program: `GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX`

The previous program id (`J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5`) is
**retired** and must not be used.

Deployment is fresh-deploy-only: a new program keypair per environment, never
an in-place upgrade over a prior id. The ad-hoc `scripts/deploy-devnet.sh` and
`scripts/upgrade-devnet.sh` are intentionally hard-disabled to prevent that
footgun; deploys follow the governed runbook (build, hash-verify, fresh
keypair, `solana program deploy`, `scripts/initialize-devnet.ts`, constants +
IDL update, frontend redeploy).

Pre-mainnet. External audit pending.

## License

[Apache License 2.0](LICENSE).
