import { PublicKey } from "@solana/web3.js";

// Program ID: replace post-deploy with the real keypair-derived ID.
export const PROGRAM_ID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC on Solana mainnet.
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// SILV mint (to be set post-deploy).
export const SILV_MINT = new PublicKey("AJxNZeX82pfDbiUXvbe442tX9Vz5XUnfsASvdvG3hNjn");

// Pyth XAG/USD feed.
export const PYTH_XAG_USD_FEED_ID = "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

// RPC endpoints.
export const HELIUS_RPC = process.env.NEXT_PUBLIC_HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY";
export const TRITON_RPC = process.env.NEXT_PUBLIC_TRITON_RPC || "https://rpc.triton.one/?api-key=YOUR_KEY";

// PDA seeds.
export const SEEDS = {
  config: "config",
  treasury: "treasury",
  silvMintAuthority: "silv_mint_authority",
  silvMetadataAuthority: "silv_metadata_authority",
  daily: "daily",
  hourly: "hourly",
  timelock: "timelock",
  guardian: "guardian",
} as const;

// UI defaults.
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const CU_LIMIT = 400_000;
export const REFRESH_INTERVAL_MS = 5_000;
