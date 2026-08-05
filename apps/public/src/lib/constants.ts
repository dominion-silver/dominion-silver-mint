import { PublicKey } from "@solana/web3.js";

// Program ID: fresh devnet deploy 2026-07-25 (wave-0 audit remediation changed the
// ConfigAccount + GuardianAccount layout, and initialize can only ever run once
// per program id, so a new id was required). Retired: AX7seVo6..., GDN5ktEm...
export const PROGRAM_ID = new PublicKey("6bgSnXYg11BWnGRc3R7xenDPCqt2xu2YswkzQGr4AoYh");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC on devnet (Circle's USDC devnet mint).
// For mainnet swap to: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// SILV mint - created by the 2026-07-25 init (scripts/t1-hostile-bootstrap.ts case 5).
// Must be updated after every fresh init: read it back with scripts/read-config.ts.
export const SILV_MINT = new PublicKey("62dTkSN7FF2HH8tENWL1mXmrCm8ouqX1bditK71yfxPr");

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
// SILV oracle: Metal.Index.SILVER/USD, Lazer feed 3154. CONFIRMED by Thomas
// 2026-07-26. PURE SPOT, no premium embedded in the feed. The retired 3304
// (Crypto.Index.SILV/USD, "DOMINION SILVER / US DOLLAR") was measured to be
// exactly 3154 x 1.05, i.e. it carried a hidden 5% premium. All of the protocol's
// margin now lives in premium_bps_mint / premium_bps_redeem, where it is visible
// on-chain instead of hidden inside a bespoke feed.
export const LAZER_SILV_FEED_ID = 3154;

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
  // 2026-08-05: `redeemRequest` removed with the queued path; these three added. Kept here
  // rather than hardcoded at the derivation sites so BOTH apps read the seeds from ONE place per
  // app, and so `scripts/verify-constants-consistency.sh` has a single symbol to compare.
  /** Authority of the premium fee vault. The vault is this PDA's USDC ATA (off-curve owner). */
  feeVault: "fee_vault",
  /** Per-wallet fee exemption. Seeds = [b"fee_exempt", wallet]. Present = exempt. */
  feeExempt: "fee_exempt",
  /** Per-wallet KYC attestation. Seeds = [b"kyc", wallet]. Present = approved. */
  kyc: "kyc",
  lazerFeePayer: "lazer_fee_payer",
} as const;

// UI defaults.
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const CU_LIMIT = 400_000;
export const REFRESH_INTERVAL_MS = 5_000;
