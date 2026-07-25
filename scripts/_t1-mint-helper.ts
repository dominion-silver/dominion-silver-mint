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

export async function createSilvMintForTest(
  connection: Connection,
  payer: Keypair,
  silvMintKeypair: Keypair,
  silvMintAuthorityPda: PublicKey,
  programId: PublicKey,
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
      payer.publicKey, // permanent delegate == freeze authority == payer, for the test
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
      payer.publicKey, // temp mint authority, rotated below
      payer.publicKey, // freeze authority
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
