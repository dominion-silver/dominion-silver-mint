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

export function silvMetadataAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.silvMetadataAuthority)],
    PROGRAM_ID,
  )[0];
}

// `redemptionRequestPda` REMOVED 2026-08-05 along with the queued redemption path. No such
// account exists on any cluster: redemptions were never enabled, so none was ever created.

/**
 * Authority of the premium fee vault. Seeds = [b"fee_vault"].
 * The VAULT is this PDA's USDC associated token account, NOT this address. Derive it with
 * `getAssociatedTokenAddressSync(USDC_MINT, feeVaultPda(), true, TOKEN_PROGRAM_ID)` and note
 * that the third argument (allowOwnerOffCurve) is MANDATORY: the owner is a PDA, so omitting
 * it throws TokenOwnerOffCurveError. That mistake has already cost this project a debugging
 * session on the treasury ATA.
 */
export function feeVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.feeVault)],
    PROGRAM_ID,
  )[0];
}

/**
 * Per-wallet fee exemption. Seeds = [b"fee_exempt", wallet].
 * The seeds bind the account to the wallet, which is why mint_silv and redeem_silv can accept
 * it as an unauthenticated optional account: it cannot be presented on anyone else's behalf.
 */
export function feeExemptPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.feeExempt), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** Per-wallet KYC attestation. Seeds = [b"kyc", wallet]. Same binding as feeExemptPda. */
export function kycPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.kyc), wallet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/**
 * Timelock action PDA. Seeds = [b"timelock", nonce_u64_le] - matches
 * the contract admin propose, execute, timelock and close_accounts
 * handlers. For propose, `nonce` = the CURRENT
 * config.next_timelock_nonce; for execute and cancel, the action's nonce.
 */
export function timelockPda(nonce: bigint): PublicKey {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(nonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.timelock), n],
    PROGRAM_ID,
  )[0];
}

/**
 * Guardian account PDA. Seeds = [b"guardian", key] - the contract derives
 * it from the SIGNER for pause/cancel, and from the guardian pubkey for
 * add/remove. Pass the relevant key.
 */
export function guardianPda(key: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.guardian), key.toBuffer()],
    PROGRAM_ID,
  )[0];
}

// V2 (Option B): day/hour epoch PDAs removed - no daily/hourly counters.
