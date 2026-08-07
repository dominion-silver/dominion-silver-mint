import { PublicKey } from "@solana/web3.js";

// DEVNET, deployed 2026-07-25. `initialize` runs once per program id, so a config or guardian layout
// change forces a new id: replace PROGRAM_ID and SILV_MINT in the SAME commit, and list the old id in
// RETIRED in scripts/verify-constants-consistency.sh.
export const PROGRAM_ID = new PublicKey("HXaptAcaXBoEAsNuEv4ZwYrciHbMxSpip2VScRVDjo1Z");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC, DEVNET (Circle). Mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// The SILV mint created by the DEVNET init above. Read it back with scripts/read-config.ts after every
// fresh init.
export const SILV_MINT = new PublicKey("G5zez3JWETJMfG3hnCQbdPm7usXMnmKUpajdGJYB5JFF");

// Pyth Lazer (Pyth Pro) accounts, passed by the dominion oracle ix. No Pyth Core / Hermes XAG feed id
// belongs here: the program prices from Lazer 3154 alone, and a second live-looking price source is how
// the wrong one gets wired back in.
export const LAZER_PROGRAM_ID = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt"); // devnet == mainnet
export const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL"); // devnet == mainnet
// CLUSTER-SPECIFIC, DEVNET value here. The contract checks whatever we pass against the Storage's own
// treasury field (read_treasury), so it must be the current cluster's. Mainnet: Gx4MBPb1...
export const LAZER_TREASURY = new PublicKey("opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7");
// Metal.Index.SILVER/USD, PURE SPOT: all protocol margin lives in premium_bps_mint /
// premium_bps_redeem, never baked into the feed.
export const LAZER_SILV_FEED_ID = 3154;

// RPC endpoints. Default = public devnet (rate-limited, fine for testing); set NEXT_PUBLIC_HELIUS_RPC
// for production.
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const HELIUS_RPC = process.env.NEXT_PUBLIC_HELIUS_RPC || DEVNET_RPC;
export const TRITON_RPC = process.env.NEXT_PUBLIC_TRITON_RPC || DEVNET_RPC;

/** The endpoint the app connects to: `WalletProvider` hands this to `ConnectionProvider`. */
export const APP_RPC = HELIUS_RPC;

/** Host-only, never the whole URL: a query string or an API key containing "devnet" is not a cluster. */
function clusterFromRpc(rpc: string): "devnet" | "mainnet-beta" {
  let host: string;
  try {
    host = new URL(rpc).hostname.toLowerCase();
  } catch {
    // An unparseable endpoint resolves to mainnet, the direction where a wrong guess is merely visible
    // (links miss the cluster param) rather than dangerous (mainnet labelled devnet).
    return "mainnet-beta";
  }
  if (host === "127.0.0.1" || host === "localhost") return "devnet";
  return host === "api.devnet.solana.com" ||
    host.startsWith("devnet.") ||
    host.endsWith(".devnet.solana.com")
    ? "devnet"
    : "mainnet-beta";
}

// Derived from APP_RPC alone: a variable that does not affect the connection must not affect the
// cluster. Reading TRITON_RPC here reported "devnet" for a mainnet build, since nothing consumes it and
// it falls back to DEVNET_RPC whenever its env var is unset.
export const CLUSTER: "devnet" | "mainnet-beta" = clusterFromRpc(APP_RPC);

/** Query suffix for explorer URLs. Mainnet takes NO cluster parameter. */
export const EXPLORER_CLUSTER_QS = CLUSTER === "devnet" ? "?cluster=devnet" : "";

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}${EXPLORER_CLUSTER_QS}`;
}
export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}${EXPLORER_CLUSTER_QS}`;
}

/** Where to send a user who has no SOL. `null` on mainnet, where there is no faucet and pointing at
 *  one sends the user on an errand that cannot work. */
export const SOL_TOPUP_URL: string | null =
  CLUSTER === "devnet" ? "https://faucet.solana.com" : null;

// PDA seeds, in one place per app so scripts/verify-constants-consistency.sh has one symbol to compare.
export const SEEDS = {
  config: "config",
  treasury: "treasury",
  silvMintAuthority: "silv_mint_authority",
  silvMetadataAuthority: "silv_metadata_authority",
  timelock: "timelock",
  guardian: "guardian",
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
export const CU_LIMIT = 400_000; // compute units per transaction
export const REFRESH_INTERVAL_MS = 5_000;
