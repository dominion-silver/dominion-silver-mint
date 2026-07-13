import { PublicKey } from "@solana/web3.js";

// Program ID: Pyth Lazer fresh devnet deploy 2026-06-10 (config layout changed
// again). Old Core/V2 devnet id GDN5ktEm88... retired.
export const PROGRAM_ID = new PublicKey("AX7seVo6Mu1j8jgipvN4dMk4erNrwdSUXNPDACYoHw2W");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC on devnet (Circle's USDC devnet mint).
// For mainnet swap to: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// SILV mint - Pyth Lazer fresh devnet init 2026-06-10 (target/devnet-deployment.json).
// Note: this needs to be updated after each fresh init.
export const SILV_MINT = new PublicKey("5i13gz6vGKTYhpWbMuQfiBAApfNHCxxJu2GtDGM1A2Li");

// Pyth XAG/USD feed.
export const PYTH_XAG_USD_FEED_ID = "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

// Pyth Lazer (Pyth Pro) on-chain accounts. Program + Storage are the same
// address on mainnet + devnet; the dominion oracle ix passes them.
export const LAZER_PROGRAM_ID = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
export const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
// CLUSTER-SPECIFIC: the Storage's treasury differs per cluster (devnet
// opsLibxVY7..., mainnet Gx4MBPb1...). The contract validates whatever we pass
// against the Storage's own treasury field (read_treasury), so this must be the
// current cluster's value. DEVNET here; swap to Gx4MBPb1... for mainnet.
export const LAZER_TREASURY = new PublicKey("opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7");
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
