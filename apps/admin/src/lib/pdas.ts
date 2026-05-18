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

/**
 * V2 queued-redemption request PDA.
 * Seeds = [b"redeem_request", owner, nonce_u64_le] - matches
 * programs/dominion_silver_mint_v2/src/instructions/redeem_queued.rs.
 */
export function redemptionRequestPda(
  owner: PublicKey,
  nonce: bigint,
): PublicKey {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.redeemRequest), owner.toBuffer(), nonceBuf],
    PROGRAM_ID,
  )[0];
}

// V2 (Option B): day/hour epoch PDAs removed - no daily/hourly counters.
