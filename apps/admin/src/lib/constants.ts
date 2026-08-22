import { PublicKey } from "@solana/web3.js";

// Program ID: MAINNET deploy 2026-08-12 (tx pgWbEKnP..., slot 438841839). The same id served the
// 2026-07-25 devnet deploy. `initialize` can only ever run once per program id, so any
// ConfigAccount + GuardianAccount layout change forces a new id. Retired: AX7seVo6..., GDN5ktEm...
export const PROGRAM_ID = new PublicKey("3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ");

// Token programs.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// USDC on MAINNET (Circle). Devnet was 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU.
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// SILV mint - the MAINNET announced vanity address, bound by `initialize` on 2026-08-12.
// Must be updated after every fresh init: read it back with scripts/read-config.ts.
// Devnet was CebhMovXRM5hEhFDTyq7Y1ez8h11UzFSGjELbyQeJExv.
export const SILV_MINT = new PublicKey("SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L");

// `PYTH_XAG_USD_FEED_ID` (the retired Pyth Core XAG/USD feed) was exported here
// with zero call sites. The program reads Pyth LAZER feed 3154 via a signed message; there is no Core
// receiver account on `initialize` any more. A live-looking export of a retired oracle is how a future
// change reintroduces the wrong price source, and showing a different price than the contract mints at
// is the specific mistake the note at the top of lib/pyth.ts exists to prevent.

// RPC endpoints.
// Default = public devnet RPC (no API key required) so the console reads the
// live V2 devnet deploy out of the box. For mainnet, set NEXT_PUBLIC_HELIUS_RPC.
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const HELIUS_RPC = process.env.NEXT_PUBLIC_HELIUS_RPC || DEVNET_RPC;
export const TRITON_RPC = process.env.NEXT_PUBLIC_TRITON_RPC || DEVNET_RPC;

// PDA seeds. Must match programs/dominion_silver_mint_v2/src/state/config.rs.
// V2 (Option B): daily/hourly seeds removed.
// 2026-08-05: redeem_request removed with the queued path; fee_vault, fee_exempt and kyc added.
export const SEEDS = {
  config: "config",
  treasury: "treasury",
  silvMintAuthority: "silv_mint_authority",
  silvMetadataAuthority: "silv_metadata_authority",
  timelock: "timelock",
  guardian: "guardian",
  /** Authority of the premium fee vault. The vault itself is this PDA's USDC ATA. */
  feeVault: "fee_vault",
  /** Per-wallet fee exemption. Seeds = [b"fee_exempt", wallet]. */
  feeExempt: "fee_exempt",
  /** Per-wallet KYC attestation. Seeds = [b"kyc", wallet]. */
  kyc: "kyc",
} as const;

/** Fee-exemption and KYC scope bits. Mirrors state/side.rs; both bitfields share the
 *  layout deliberately, so one set of constants serves both. */
export const SIDE_MINT_BIT = 1;
export const SIDE_REDEEM_BIT = 2;
export const SIDE_BOTH_BITS = 3;

// UI defaults.
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const CU_LIMIT = 400_000;
export const REFRESH_INTERVAL_MS = 5_000;
