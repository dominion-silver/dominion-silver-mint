import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "./constants";

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.config)],
    PROGRAM_ID,
  )[0];
}

export function treasuryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.treasury)],
    PROGRAM_ID,
  )[0];
}

export function silvMintAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.silvMintAuthority)],
    PROGRAM_ID,
  )[0];
}

// The isolated System-owned Lazer fee-payer PDA (the dominion oracle ix funds
// it with the capped Lazer fee; the user wallet is never in the Lazer CPI).
export function lazerFeePayerPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.lazerFeePayer)],
    PROGRAM_ID,
  )[0];
}

export function silvMetadataAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.silvMetadataAuthority)],
    PROGRAM_ID,
  )[0];
}

// `redemptionRequestPda` REMOVED 2026-08-05 with the queued redemption path. No such account
// exists on any cluster: redemptions were never enabled, so none was ever created.

/**
 * Authority of the premium fee vault. Seeds = [b"fee_vault"].
 * The VAULT is this PDA's USDC associated token account, not this address. Derive it with
 * allowOwnerOffCurve = true: the owner is a PDA, and omitting that flag throws
 * TokenOwnerOffCurveError.
 */
export function feeVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.feeVault)],
    PROGRAM_ID,
  )[0];
}

/** Per-wallet fee exemption. Seeds = [b"fee_exempt", wallet]. Present = exempt. */
export function feeExemptPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.feeExempt), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** Per-wallet KYC attestation. Seeds = [b"kyc", wallet]. Present = approved. */
export function kycPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.kyc), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

// V2 (Option B): day/hour epoch PDAs removed - no daily/hourly counters.
