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

// AUDIT FINDING P-06: `PYTH_XAG_USD_FEED_ID` (the retired Pyth Core XAG/USD feed) was exported here
// with zero call sites. The program reads Pyth LAZER feed 3154 via a signed message; there is no Core
// receiver account on `initialize` any more. A live-looking export of a retired oracle is how a future
// change reintroduces the wrong price source, and showing a different price than the contract mints at
// is the specific mistake the note at the top of lib/pyth.ts exists to prevent.

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

/**
 * Which cluster this build talks to, and everything that has to follow from it.
 *
 * AUDIT FINDING P-08. Explorer links were built with a literal `?cluster=devnet` in four places and the
 * low-balance notice sent every user to the devnet faucet. Nothing in the app derived any of that from a
 * cluster constant, so a mainnet deploy would have shipped links that open a nonexistent transaction on
 * devnet, and told a mainnet user out of SOL to visit a faucet that cannot fund their transaction. The
 * quiet version of the failure is the worse one: the toast after a successful mint links somewhere the
 * transaction is not, which reads as "my mint did not go through".
 *
 * Derived from the RPC rather than a separate env var on purpose. A separate flag is one more thing to
 * forget, and forgetting it reproduces the bug; the RPC is already required to be right for the app to
 * function at all, so it cannot be stale while anything else works.
 */
/**
 * THE endpoint the app actually connects to. `WalletProvider` passes this to `ConnectionProvider`, so
 * this is the cluster by definition.
 *
 * REVIEW-OF-FIXES P0, found independently by two reviewers. The first version was
 * `/devnet/i.test(HELIUS_RPC) || /devnet/i.test(TRITON_RPC)`, and `TRITON_RPC` falls back to
 * `DEVNET_RPC` when its env var is unset. `NEXT_PUBLIC_TRITON_RPC` has NO consumer anywhere in the app,
 * so in the documented mainnet configuration (the runbook lists only `NEXT_PUBLIC_HELIUS_RPC`) the OR
 * fired on a variable nothing uses and `CLUSTER` came out "devnet". P-08 was therefore not fixed at all
 * for the only configuration that ships: every Solscan link got `?cluster=devnet` and mainnet users out
 * of SOL were sent to the devnet faucet.
 *
 * And `cluster.test.ts` could not see it, because its helper set BOTH variables in every case. The one
 * realistic misconfiguration was the one shape the test could not express.
 *
 * Deriving from the connection endpoint removes the class: there is nothing left to be inconsistent
 * with. A variable that does not affect the connection must not affect the cluster.
 */
export const APP_RPC = HELIUS_RPC;

/** Host-only, never the whole URL: a query string or an API key containing "devnet" is not a cluster. */
function clusterFromRpc(rpc: string): "devnet" | "mainnet-beta" {
  let host: string;
  try {
    host = new URL(rpc).hostname.toLowerCase();
  } catch {
    // An unparseable endpoint is a misconfiguration. Treat it as mainnet, the direction where a wrong
    // guess is visible (links miss the cluster param) rather than dangerous (mainnet labelled devnet).
    return "mainnet-beta";
  }
  if (host === "127.0.0.1" || host === "localhost") return "devnet";
  return host === "api.devnet.solana.com" ||
    host.startsWith("devnet.") ||
    host.endsWith(".devnet.solana.com")
    ? "devnet"
    : "mainnet-beta";
}

export const CLUSTER: "devnet" | "mainnet-beta" = clusterFromRpc(APP_RPC);

/** Query suffix for explorer URLs. Mainnet takes NO cluster parameter. */
export const EXPLORER_CLUSTER_QS = CLUSTER === "devnet" ? "?cluster=devnet" : "";

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}${EXPLORER_CLUSTER_QS}`;
}
export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}${EXPLORER_CLUSTER_QS}`;
}

/**
 * Where to send a user who has no SOL. On devnet that is the faucet. On mainnet there is no faucet, so
 * pointing at one is worse than saying nothing: it sends the user on an errand that cannot work.
 */
export const SOL_TOPUP_URL: string | null =
  CLUSTER === "devnet" ? "https://faucet.solana.com" : null;

// PDA seeds.
// V2 (Option B): daily/hourly seeds removed (those accounts no longer exist);
// redeem_request REMOVED with the queued path (2026-08-05); fee_vault / fee_exempt / kyc added.
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
