import { PublicKey } from "@solana/web3.js";

// Program ID: V2 (Option B) fresh devnet deploy 2026-05-18. NOT the V1 id.
export const PROGRAM_ID = new PublicKey("GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC on devnet (Circle's USDC devnet mint).
// For mainnet swap to: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// SILV mint - V2 fresh devnet init 2026-05-18 (target/devnet-deployment.json).
// Note: this needs to be updated after each fresh init.
export const SILV_MINT = new PublicKey("4bNYnE1d8XV1W4iJuWVqmxVi5qqvAopvxekifDVvB4Ew");

// Pyth XAG/USD feed.
export const PYTH_XAG_USD_FEED_ID = "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

// Pyth Lazer (Pyth Pro) on-chain accounts (mainnet == devnet). Hard-pinned in
// the contract (lazer_cpi.rs); the dominion oracle ix passes them.
export const LAZER_PROGRAM_ID = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
export const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
export const LAZER_TREASURY = new PublicKey("Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak");
// SILV's Pyth Lazer feed id.
export const LAZER_SILV_FEED_ID = 3304;

// RPC endpoints.
// Default = public devnet RPC (no API key required, rate-limited but fine for testing).
// For mainnet production, set NEXT_PUBLIC_HELIUS_RPC or NEXT_PUBLIC_TRITON_RPC in env.
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const HELIUS_RPC = process.env.NEXT_PUBLIC_HELIUS_RPC || DEVNET_RPC;
export const TRITON_RPC = process.env.NEXT_PUBLIC_TRITON_RPC || DEVNET_RPC;

// PDA seeds.
// V2 (Option B): daily/hourly seeds removed (those accounts no longer exist);
// redeem_request added for the queued-redemption PDA.
export const SEEDS = {
  config: "config",
  treasury: "treasury",
  silvMintAuthority: "silv_mint_authority",
  silvMetadataAuthority: "silv_metadata_authority",
  timelock: "timelock",
  guardian: "guardian",
  redeemRequest: "redeem_request",
  lazerFeePayer: "lazer_fee_payer",
} as const;

// UI defaults.
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const CU_LIMIT = 400_000;
export const REFRESH_INTERVAL_MS = 5_000;
