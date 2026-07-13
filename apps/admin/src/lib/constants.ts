import { PublicKey } from "@solana/web3.js";

// Program ID: Pyth Lazer fresh devnet deploy 2026-06-10 (config layout changed).
export const PROGRAM_ID = new PublicKey("AX7seVo6Mu1j8jgipvN4dMk4erNrwdSUXNPDACYoHw2W");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC on devnet (Circle's USDC devnet mint) - matches the live V2 devnet deploy.
// For mainnet swap to: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// SILV mint - Pyth Lazer fresh devnet init 2026-06-10 (target/devnet-deployment.json).
export const SILV_MINT = new PublicKey("5i13gz6vGKTYhpWbMuQfiBAApfNHCxxJu2GtDGM1A2Li");

// Pyth XAG/USD feed.
export const PYTH_XAG_USD_FEED_ID = "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

// RPC endpoints.
// Default = public devnet RPC (no API key required) so the console reads the
// live V2 devnet deploy out of the box. For mainnet, set NEXT_PUBLIC_HELIUS_RPC.
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const HELIUS_RPC = process.env.NEXT_PUBLIC_HELIUS_RPC || DEVNET_RPC;
export const TRITON_RPC = process.env.NEXT_PUBLIC_TRITON_RPC || DEVNET_RPC;

// PDA seeds.
// V2 (Option B): daily/hourly seeds removed; redeem_request added.
export const SEEDS = {
  config: "config",
  treasury: "treasury",
  silvMintAuthority: "silv_mint_authority",
  silvMetadataAuthority: "silv_metadata_authority",
  timelock: "timelock",
  guardian: "guardian",
  redeemRequest: "redeem_request",
} as const;

// UI defaults.
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const CU_LIMIT = 400_000;
export const REFRESH_INTERVAL_MS = 5_000;
