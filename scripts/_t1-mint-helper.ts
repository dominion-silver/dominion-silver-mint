/**
 * Creates a SILV mint in the shape `initialize` requires, for the T1 hostile-bootstrap test.
 * Mirrors createSilvMint in scripts/initialize-devnet.ts, whose doc has the details. Never
 * persists the mint secret key anywhere (audit A-30).
 *
 * Takes an already-open Connection and resolves no cluster of its own. That is why it sits on
 * the send-detector gate's helper allowlist: the CALLER owns requireSanctionedCluster.
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
 * Create the real SILV mint. `complianceAuthority` becomes BOTH the PermanentDelegate and the
 * freeze authority, and `initialize` hard-requires each to equal its expected arg. Both are
 * PERMANENT: fixed at mint creation, and no program upgrade repairs an external SPL authority.
 *
 * Neither needs to SIGN to be set, so pass the right pubkey instead of hand-editing this file at
 * ceremony time. Hardcoding the payer is green on devnet, where the expected value falls back to
 * the dev keypair, and reverts SilvFreezeAuthorityMismatch on mainnet after the SOL is spent.
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
    uri: "https://app.dominion.market/silv-metadata.json",
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
      complianceAuthority, // == args.permanent_delegate_expected
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
      complianceAuthority, // == args.freeze_authority_expected
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

  // The program asserts mint_authority == this PDA on every value instruction.
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
