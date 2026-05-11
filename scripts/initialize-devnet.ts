/**
 * One-time devnet initialization script.
 *
 * Steps:
 *   1. Create SILV Token-2022 mint with extensions:
 *      - PermanentDelegate = admin (Ops Squads vault)
 *      - MetadataPointer = mint itself (in-line metadata per Token-2022 pattern)
 *      - TokenMetadata (name/symbol/uri)
 *      - mint_authority = silv_mint_authority PDA
 *      - freeze_authority = silv_mint_authority PDA
 *   2. Call our program's initialize() to create ConfigAccount + USDC treasury ATA
 *
 * Run with:
 *   DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
 *   npx tsx scripts/initialize-devnet.ts --admin <pk> --upgrade-squads <pk>
 */
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, Idl, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
  LENGTH,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  TokenMetadata,
} from "@solana/spl-token-metadata";
import fs from "fs";
import path from "path";
import os from "os";

const DEVNET_RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PYTH_RECEIVER_DEVNET = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);
const PYTH_XAG_USD_FEED_ID_HEX =
  "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

function parseArgs(): { admin: PublicKey; upgradeSquads: PublicKey } {
  const argv = process.argv.slice(2);
  const adminIdx = argv.indexOf("--admin");
  const upgIdx = argv.indexOf("--upgrade-squads");
  if (adminIdx < 0 || upgIdx < 0) {
    console.error(
      "usage: initialize-devnet.ts --admin <pk> --upgrade-squads <pk>",
    );
    process.exit(1);
  }
  return {
    admin: new PublicKey(argv[adminIdx + 1]),
    upgradeSquads: new PublicKey(argv[upgIdx + 1]),
  };
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function createSilvMint(
  connection: Connection,
  payer: Keypair,
  silvMintKeypair: Keypair,
  mintAuthorityPda: PublicKey,
  permanentDelegate: PublicKey,
): Promise<void> {
  const decimals = 9;
  const metadata: TokenMetadata = {
    mint: silvMintKeypair.publicKey,
    name: "Dominion Silver",
    symbol: "SILV",
    uri: "https://dominion.market/silv-metadata.json",
    additionalMetadata: [],
  };

  // Compute sizes.
  const extensions = [ExtensionType.PermanentDelegate, ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const rent = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  console.log(`  - mintLen: ${mintLen}, metadataLen: ${metadataLen}`);
  console.log(`  - rent: ${rent / 1e9} SOL`);

  const tx = new Transaction().add(
    // 1. Create mint account (with room for metadata).
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: silvMintKeypair.publicKey,
      space: mintLen,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // 2. PermanentDelegate extension - delegate = admin (Ops Squads vault).
    createInitializePermanentDelegateInstruction(
      silvMintKeypair.publicKey,
      permanentDelegate,
      TOKEN_2022_PROGRAM_ID,
    ),
    // 3. MetadataPointer extension - point at the mint itself (in-line metadata).
    createInitializeMetadataPointerInstruction(
      silvMintKeypair.publicKey,
      mintAuthorityPda, // authority to update the pointer (rotatable)
      silvMintKeypair.publicKey, // metadata lives on the mint account
      TOKEN_2022_PROGRAM_ID,
    ),
    // 4. Initialize mint (decimals + mint_authority + freeze_authority).
    createInitializeMintInstruction(
      silvMintKeypair.publicKey,
      decimals,
      mintAuthorityPda, // mint authority = program's silv_mint_authority PDA
      mintAuthorityPda, // freeze authority = same (for thaw_account ix)
      TOKEN_2022_PROGRAM_ID,
    ),
    // 5. Initialize metadata (name/symbol/uri in-line on the mint).
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: silvMintKeypair.publicKey,
      updateAuthority: mintAuthorityPda,
      mint: silvMintKeypair.publicKey,
      mintAuthority: mintAuthorityPda,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
  );

  // NOTE: InitializeMetadata instruction requires mintAuthority to sign,
  // but mintAuthority is a PDA. On first init the mint_authority is still
  // the payer (set by createInitializeMintInstruction above). Actually wait:
  // we set mint_authority = mintAuthorityPda directly in step 4. That means
  // step 5 needs the PDA to sign, which requires an on-chain CPI.
  //
  // Fix: create the mint with payer as mint_authority first, init metadata
  // (payer signs), then transfer mint_authority to PDA.

  throw new Error(
    "InitializeMetadata requires PDA signer; needs on-chain CPI. Restructuring...",
  );
}

async function createSilvMintTwoPhase(
  connection: Connection,
  payer: Keypair,
  silvMintKeypair: Keypair,
  mintAuthorityPda: PublicKey,
  permanentDelegate: PublicKey,
): Promise<void> {
  // IMPORTANT: SILV decimals MUST match the on-chain math assumption.
  // programs/.../math.rs line 3: "USDC and SILV: 6 decimals"
  // If this doesn't match, user sees wrong SILV amounts in their wallet
  // (off by 10^(n-6)). PLAN.md Q6 default = 6.
  const decimals = 6;
  const metadata: TokenMetadata = {
    mint: silvMintKeypair.publicKey,
    name: "Dominion Silver",
    symbol: "SILV",
    uri: "https://dominion.market/silv-metadata.json",
    additionalMetadata: [],
  };
  const extensions = [ExtensionType.PermanentDelegate, ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const rent = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  console.log(`  - extensions: PermanentDelegate + MetadataPointer`);
  console.log(`  - mintLen: ${mintLen}, metadataLen: ${metadataLen}, rent: ${rent / 1e9} SOL`);

  // Phase 1: create account + all extensions + init mint with payer as authority
  //   + init metadata (payer signs as mint authority)
  //   + set mint authority to PDA at the end (within same tx if possible).
  // Keep payer as freeze authority initially, then transfer to PDA.
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
      permanentDelegate,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataPointerInstruction(
      silvMintKeypair.publicKey,
      payer.publicKey, // pointer-update authority = payer (can rotate later)
      silvMintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      silvMintKeypair.publicKey,
      decimals,
      payer.publicKey, // mint authority = payer TEMPORARILY
      payer.publicKey, // freeze authority = payer TEMPORARILY
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: silvMintKeypair.publicKey,
      updateAuthority: payer.publicKey,
      mint: silvMintKeypair.publicKey,
      mintAuthority: payer.publicKey, // payer signs the tx
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
  );

  const sig1 = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer, silvMintKeypair],
    { commitment: "confirmed" },
  );
  console.log(`  ✅ Mint + extensions + metadata: ${sig1}`);

  // Phase 2: transfer mint authority + freeze authority + metadata update
  // authority to the program's PDA.
  const { createSetAuthorityInstruction, AuthorityType } = await import(
    "@solana/spl-token"
  );
  const { createUpdateAuthorityInstruction } = await import(
    "@solana/spl-token-metadata"
  );

  const tx2 = new Transaction().add(
    createSetAuthorityInstruction(
      silvMintKeypair.publicKey,
      payer.publicKey,
      AuthorityType.MintTokens,
      mintAuthorityPda,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createSetAuthorityInstruction(
      silvMintKeypair.publicKey,
      payer.publicKey,
      AuthorityType.FreezeAccount,
      mintAuthorityPda,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: silvMintKeypair.publicKey,
      oldAuthority: payer.publicKey,
      newAuthority: mintAuthorityPda,
    }),
  );

  const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ✅ Authorities transferred to PDA: ${sig2}`);
}

async function main() {
  const { admin, upgradeSquads } = parseArgs();
  const connection = new Connection(DEVNET_RPC, "confirmed");

  // Load deployer.
  const envKeypair = process.env.DOMINION_KEYPAIR;
  const solanaConfig = path.join(os.homedir(), ".config/solana/cli/config.yml");
  let configKeypair: string | undefined;
  if (fs.existsSync(solanaConfig)) {
    const m = fs.readFileSync(solanaConfig, "utf8").match(/keypair_path:\s*(\S+)/);
    if (m) configKeypair = m[1].replace(/^"|"$/g, "");
  }
  const deployerPath =
    envKeypair || configKeypair || path.join(os.homedir(), ".config/solana/id.json");
  const deployer = loadKeypair(deployerPath);
  console.log("Using keypair:", deployerPath);
  console.log("Deployer:", deployer.publicKey.toBase58());
  console.log("Admin (Ops Squads vault):", admin.toBase58());
  console.log("Upgrade Squads vault:", upgradeSquads.toBase58());

  const wallet: Wallet = {
    publicKey: deployer.publicKey,
    signTransaction: async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx as any).partialSign(deployer);
      return tx;
    },
    signAllTransactions: async (txs) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txs.forEach((t) => (t as any).partialSign(deployer));
      return txs;
    },
    payer: deployer,
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idlPath = path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  const program = new Program(idl, provider);

  // PDAs
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    PROGRAM_ID,
  );
  const [silvMintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    PROGRAM_ID,
  );

  // Generate SILV mint keypair.
  const silvMintKeypair = Keypair.generate();
  const silvMint = silvMintKeypair.publicKey;
  console.log("\n== Step 1: Create SILV Token-2022 mint ==");
  console.log("SILV mint:", silvMint.toBase58());
  console.log("PermanentDelegate:", admin.toBase58());
  console.log("Mint/Freeze authority (PDA):", silvMintAuthorityPda.toBase58());
  await createSilvMintTwoPhase(
    connection,
    deployer,
    silvMintKeypair,
    silvMintAuthorityPda,
    admin,
  );

  // Derived accounts for initialize.
  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    DEVNET_USDC,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  const feedIdBytes = Array.from(Buffer.from(PYTH_XAG_USD_FEED_ID_HEX, "hex"));
  if (feedIdBytes.length !== 32) {
    throw new Error("XAG/USD feed id must be 32 bytes");
  }

  console.log("\n== Step 2: Call program.initialize() ==");

  // Correct InitializeArgs per programs/.../instructions/initialize.rs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .initialize({
      admin,
      upgradeAuthorityInfo: upgradeSquads,
      permanentDelegateExpected: admin,
      complianceMode: false,
      premiumBpsMint: 1000, // 10%
      premiumBpsRedeem: 200, // 2%
      pythFeedId: feedIdBytes,
      pythReceiverProgram: PYTH_RECEIVER_DEVNET,
      // Dollar amounts in USDC atomic (6 decimals)
      minMintAmountUsdc: new BN(10_000_000), // $10 minimum mint
      maxMintAmountPerTxUsdc: new BN(1_000_000_000_000), // $1M per tx
      minRedeemAmountUsdc: new BN(10_000_000), // $10 minimum redeem
      maxRedeemAmountPerTxUsdc: new BN(1_000_000_000_000), // $1M per tx
      dailyMintCapUsdc: new BN(10_000_000_000_000), // $10M / day
      dailyRedeemCapUsdc: new BN(10_000_000_000_000), // $10M / day
      hourlyRedeemCapBpsOfSnapshot: 1000, // 10% of treasury per hour
      treasuryMinReserveBps: 2000, // 20% floor
      adminTimelockSeconds: 24 * 3600, // 24h
      maxGuardianCount: 5,
    })
    .accounts({
      deployer: deployer.publicKey,
      config: configPda,
      treasuryPda,
      usdcMint: DEVNET_USDC,
      silvMint,
      usdcTreasury: usdcTreasuryAta,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ix);
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = deployer.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [deployer], {
    commitment: "confirmed",
  });

  console.log("\n✅ Initialize complete.");
  console.log("Tx sig:", sig);
  console.log("\n== Deployed values ==");
  console.log("  PROGRAM_ID:", PROGRAM_ID.toBase58());
  console.log("  CONFIG_PDA:", configPda.toBase58());
  console.log("  TREASURY_PDA:", treasuryPda.toBase58());
  console.log("  USDC_TREASURY_ATA:", usdcTreasuryAta.toBase58());
  console.log("  SILV_MINT:", silvMint.toBase58());
  console.log("  SILV_MINT_AUTHORITY_PDA:", silvMintAuthorityPda.toBase58());

  // Save SILV_MINT to a file so the UIs can pick it up.
  const out = {
    programId: PROGRAM_ID.toBase58(),
    configPda: configPda.toBase58(),
    treasuryPda: treasuryPda.toBase58(),
    usdcTreasuryAta: usdcTreasuryAta.toBase58(),
    silvMint: silvMint.toBase58(),
    silvMintAuthorityPda: silvMintAuthorityPda.toBase58(),
    silvMintSecret: Array.from(silvMintKeypair.secretKey),
    initializeTx: sig,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "target", "devnet-deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n📄 Deployment state saved to ${outPath}`);
}

main().catch((e) => {
  console.error("\n❌ FAILED:", e);
  if (e.transactionLogs) {
    console.error("Logs:\n" + e.transactionLogs.join("\n"));
  }
  process.exit(1);
});
