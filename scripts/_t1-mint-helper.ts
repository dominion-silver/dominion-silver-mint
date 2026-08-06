/**
 * Creates a SILV mint in exactly the shape `initialize` requires, for the T1
 * hostile-bootstrap test. Mirrors createSilvMint in scripts/initialize-devnet.ts:
 * Token-2022, decimals 6, extensions {PermanentDelegate, MetadataPointer,
 * in-mint TokenMetadata}, freeze authority set, then the mint authority rotated
 * to the program's silv_mint_authority PDA.
 *
 * Deliberately does NOT persist the mint secret key anywhere (audit A-30).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializePermanentDelegateInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  LENGTH_SIZE,
  TYPE_SIZE,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata";

/**
 * Create the real SILV mint.
 *
 * REVIEW-OF-FIXES P0. `complianceAuthority` used to be absent and both the PermanentDelegate and the
 * freeze authority were hardcoded to `payer.publicKey`, with the comment "== payer, for the test". The
 * D-01 fix then changed what `initialize` EXPECTS to the compliance Squads vault on any non-devnet
 * cluster, and `initialize` hard-requires equality (initialize.rs:270 and :340). On devnet the two
 * agreed, because the ceremony authority falls back to the dev keypair, so every test passed. On mainnet
 * they could not agree, and the ceremony would have reverted `SilvFreezeAuthorityMismatch` at case 5,
 * having already paid ~9 SOL for the deploy and created a mint whose keypair is deliberately never
 * persisted.
 *
 * That is the S-01 failure shape reintroduced by the commit that closed S-01: green on devnet, dead on
 * mainnet, discovered after the money is spent.
 *
 * Neither authority needs to SIGN to be set: `createInitializePermanentDelegateInstruction` and
 * `createInitializeMintInstruction` both take a plain pubkey. So the fix is to pass the right one, not
 * to hand-edit this file at ceremony time, which the runbook used to instruct and which is exactly the
 * "no ceremony value entered by editing TypeScript" rule the audit asked for.
 *
 * BOTH OF THESE ARE PERMANENT. They are fixed at mint creation and no program upgrade can restore an
 * external SPL authority once it is wrong.
 */
export async function createSilvMintForTest(
  connection: Connection,
  payer: Keypair,
  silvMintKeypair: Keypair,
  silvMintAuthorityPda: PublicKey,
  programId: PublicKey,
  /** Freeze authority AND permanent delegate. On devnet this is the payer; on mainnet the compliance
   *  vault, read from config/mainnet-authorities.json by the caller. */
  complianceAuthority: PublicKey,
): Promise<void> {
  const [silvMetadataAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_metadata_authority")],
    programId,
  );
  const decimals = 6;
  const metadata: TokenMetadata = {
    mint: silvMintKeypair.publicKey,
    name: "Dominion Silver",
    symbol: "SILV",
    uri: "https://dominion.market/silv-metadata.json",
    additionalMetadata: [],
  };
  const extensions = [
    ExtensionType.PermanentDelegate,
    ExtensionType.MetadataPointer,
  ];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const rent = await connection.getMinimumBalanceForRentExemption(
    mintLen + metadataLen,
  );

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: silvMintKeypair.publicKey,
      space: mintLen,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializePermanentDelegateInstruction(
      silvMintKeypair.publicKey,
      complianceAuthority, // PERMANENT. Must equal args.permanent_delegate_expected at initialize.
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataPointerInstruction(
      silvMintKeypair.publicKey,
      silvMetadataAuthorityPda,
      silvMintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      silvMintKeypair.publicKey,
      decimals,
      payer.publicKey, // temp mint authority, rotated to the program PDA below
      complianceAuthority, // PERMANENT. Must equal args.freeze_authority_expected at initialize.
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: silvMintKeypair.publicKey,
      updateAuthority: silvMetadataAuthorityPda,
      mint: silvMintKeypair.publicKey,
      mintAuthority: payer.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [payer, silvMintKeypair], {
    commitment: "confirmed",
  });

  // Rotate the mint authority to the program PDA, which is what the program's
  // invariant asserts on every value instruction.
  const tx2 = new Transaction().add(
    createSetAuthorityInstruction(
      silvMintKeypair.publicKey,
      payer.publicKey,
      AuthorityType.MintTokens,
      silvMintAuthorityPda,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, tx2, [payer], {
    commitment: "confirmed",
  });
}
