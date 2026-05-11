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
│   └── dominion_silver_mint/        Solana Anchor program (Rust)
├── apps/
│   ├── public/                       mint/redeem frontend (Next.js 15)
│   └── admin/                        read-only admin dashboard (Next.js)
├── scripts/                          devnet ops + integration scripts
└── tests/                            Anchor TypeScript tests
```

## Build

### Toolchain

- Rust 1.89.0 (via rustup)
- Solana 3.1.x + platform-tools v1.52
- Anchor 0.31.1 (`avm install 0.31.1 && avm use 0.31.1`)
- Node 20+ / npm

### Smart contract

```bash
cargo build-sbf --manifest-path programs/dominion_silver_mint/Cargo.toml
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

Devnet program: `J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5`

Pre-mainnet. External audit pending.

## License

[Apache License 2.0](LICENSE).
