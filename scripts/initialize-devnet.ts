/**
 * One-time DEVNET initialization for the V2 (Option B) program.
 *
 * PREREQUISITES (CODEX P0-03 / deploy-prep):
 *   - The program is FRESH-DEPLOYED under the V2 id
 *     GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX (NEVER an in-place upgrade
 *     over V1; the ConfigAccount layout is incompatible).
 *   - `target/idl/dominion_silver_mint.json` MUST be the regenerated V2 IDL
 *     (from the default-features build, dev-hatch EXCLUDED). The bundled IDLs
 *     are still stale V1 until regenerated.
 *   - IDL generation + `anchor`/`solana program deploy` MUST use the toolchain
 *     pinned in Anchor.toml (anchor 0.31.1 / solana 3.x). A mismatched local
 *     anchor-cli (e.g. 0.30.1) breaks IDL/deploy reproducibility.
 *
 * What it does (matches programs/dominion_silver_mint_v2/src/instructions/initialize.rs):
 *   1. Create the SILV Token-2022 mint with EXACTLY these extensions
 *      (V2 strict allowlist, CODEX P1-03): PermanentDelegate + MetadataPointer
 *      + TokenMetadata. Nothing else.
 *        - decimals            = 6           (V2 hard-pins 6)
 *        - mint_authority      = silv_mint_authority PDA   (set in phase 2)
 *        - freeze_authority    = admin / Ops Squads vault  (== freeze_authority_expected; compliance freeze lever)
 *        - PermanentDelegate   = admin / Ops Squads vault  (== permanent_delegate_expected; seize/clawback lever)
 *        - MetadataPointer.authority        = silv_metadata_authority PDA
 *        - MetadataPointer.metadata_address = the mint itself (in-mint metadata)
 *        - TokenMetadata.update_authority   = silv_metadata_authority PDA
 *        - TokenMetadata.mint               = the mint itself
 *   2. Call initialize() with the V2 InitializeArgs (Option A cap/reserve args
 *      removed; all Option B economic params default on-chain).
 *
 * Run:
 *   DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
 *   npx tsx scripts/initialize-devnet.ts --admin <ops_vault_pk> --upgrade-squads <upgrade_vault_pk>
 */
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Idl, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
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
// CODEX P0-01: V2 program id (NOT the V1 id J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5).
// DOMINION_PROGRAM_ID override exists ONLY for the isolated Squads E2E
// (scripts/test-dominion-squads-e2e.ts) which deploys a throwaway instance
// under a fresh id. Unset in all real deploys -> the canonical V2 id.
const PROGRAM_ID = new PublicKey(
  process.env.DOMINION_PROGRAM_ID ||
    "GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX",
);
// Circle devnet USDC (in the V2 initialize allowlist).
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
// Official Pyth pull-oracle receiver (V2 hard-pins exactly this).
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
      "usage: initialize-devnet.ts --admin <ops_vault_pk> --upgrade-squads <upgrade_vault_pk>",
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

/**
 * Create the SILV Token-2022 mint exactly as V2 initialize.rs expects.
 *
 * Two phases because InitializeMetadata must be signed by the mint authority:
 *   Phase 1 (payer + mint keypair sign): create account, init the 3 extensions
 *     and the mint with mint_authority = payer TEMP and freeze_authority = the
 *     compliance multisig (launch spec 2026-07: Mark confirmed the freeze lever;
 *     V2 requires freeze_authority == freeze_authority_expected, NOT None), then
 *     InitializeMetadata (payer signs as mint auth). MetadataPointer.authority and
 *     TokenMetadata.update_authority are set DIRECTLY to the silv_metadata_authority
 *     PDA here - the MetadataPointer authority is NOT rotatable in Token-2022 (only
 *     its address is), so it must be correct at init.
 *   Phase 2 (payer signs): rotate ONLY the mint authority to the
 *     silv_mint_authority PDA. Freeze authority is already the compliance multisig
 *     (set at creation, nothing to rotate). Metadata authorities are already the
 *     metadata PDA.
 */
async function createSilvMint(
  connection: Connection,
  payer: Keypair,
  silvMintKeypair: Keypair,
  silvMintAuthorityPda: PublicKey,
  silvMetadataAuthorityPda: PublicKey,
  permanentDelegate: PublicKey,
  freezeAuthority: PublicKey,
): Promise<void> {
  const decimals = 6; // V2 hard-pins 6 (math.rs assumes 6 for SILV + USDC).
  const metadata: TokenMetadata = {
    mint: silvMintKeypair.publicKey,
    name: "Dominion Silver",
    symbol: "SILV",
    uri: "https://dominion.market/silv-metadata.json",
    additionalMetadata: [],
  };
  // EXACTLY the V2-allowlisted extensions, nothing else.
  const extensions = [
    ExtensionType.PermanentDelegate,
    ExtensionType.MetadataPointer,
  ];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const rent = await connection.getMinimumBalanceForRentExemption(
    mintLen + metadataLen,
  );
  console.log(
    `  - extensions: PermanentDelegate + MetadataPointer (+ in-mint TokenMetadata)`,
  );
  console.log(
    `  - decimals: ${decimals}, mintLen: ${mintLen}, metadataLen: ${metadataLen}, rent: ${rent / 1e9} SOL`,
  );

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: silvMintKeypair.publicKey,
      space: mintLen,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // PermanentDelegate = Ops Squads vault (== initialize args.permanent_delegate_expected).
    createInitializePermanentDelegateInstruction(
      silvMintKeypair.publicKey,
      permanentDelegate,
      TOKEN_2022_PROGRAM_ID,
    ),
    // MetadataPointer: authority = silv_metadata_authority PDA (NOT rotatable
    // post-init), metadata_address = the mint itself (in-mint metadata).
    createInitializeMetadataPointerInstruction(
      silvMintKeypair.publicKey,
      silvMetadataAuthorityPda,
      silvMintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    // Mint: decimals 6, mint_authority = payer TEMP (rotated in phase 2),
    // freeze_authority = the compliance multisig (launch spec 2026-07: Mark confirmed
    // the freeze lever; must equal freezeAuthorityExpected passed to initialize()).
    createInitializeMintInstruction(
      silvMintKeypair.publicKey,
      decimals,
      payer.publicKey,
      freezeAuthority,
      TOKEN_2022_PROGRAM_ID,
    ),
    // TokenMetadata: update_authority = silv_metadata_authority PDA, mint =
    // the mint itself. mintAuthority (payer here) must sign this ix.
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

  const sig1 = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer, silvMintKeypair],
    { commitment: "confirmed" },
  );
  console.log(`  ✅ Phase 1 (mint + 3 extensions + metadata): ${sig1}`);

  // Phase 2: rotate ONLY the mint authority to the program PDA. Freeze is
  // already None; metadata authorities are already the metadata PDA.
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
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ✅ Phase 2 (mint authority -> PDA): ${sig2}`);
}

async function main() {
  const { admin, upgradeSquads } = parseArgs();
  const connection = new Connection(DEVNET_RPC, "confirmed");

  const envKeypair = process.env.DOMINION_KEYPAIR;
  const solanaConfig = path.join(os.homedir(), ".config/solana/cli/config.yml");
  let configKeypair: string | undefined;
  if (fs.existsSync(solanaConfig)) {
    const m = fs
      .readFileSync(solanaConfig, "utf8")
      .match(/keypair_path:\s*(\S+)/);
    if (m) configKeypair = m[1].replace(/^"|"$/g, "");
  }
  const deployerPath =
    envKeypair ||
    configKeypair ||
    path.join(os.homedir(), ".config/solana/id.json");
  const deployer = loadKeypair(deployerPath);
  console.log("Using keypair:", deployerPath);
  console.log("Deployer:", deployer.publicKey.toBase58());
  console.log("Program (V2):", PROGRAM_ID.toBase58());
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

  const idlPath = path.join(
    __dirname,
    "..",
    "target",
    "idl",
    "dominion_silver_mint.json",
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  // Guard: refuse to run against a stale V1 IDL (must be regenerated for V2).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idlAddr = (idl as any).address || (idl as any).metadata?.address;
  if (process.env.DOMINION_PROGRAM_ID) {
    // Isolated Squads E2E: the throwaway program id differs from the IDL's
    // baked canonical id. Point Anchor at the override (Program() derives the
    // program id from idl.address in Anchor 0.31). Safe: this branch is only
    // reachable when the env override is explicitly set by the E2E harness.
    (idl as any).address = PROGRAM_ID.toBase58();
  } else if (idlAddr && idlAddr !== PROGRAM_ID.toBase58()) {
    throw new Error(
      `IDL address ${idlAddr} != V2 program ${PROGRAM_ID.toBase58()}. ` +
        `Regenerate the V2 IDL (default-features build) before running.`,
    );
  }
  const program = new Program(idl, provider);

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
  // CODEX M-01: V2 requires the metadata authorities to be THIS distinct PDA.
  const [silvMetadataAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_metadata_authority")],
    PROGRAM_ID,
  );

  const silvMintKeypair = Keypair.generate();
  const silvMint = silvMintKeypair.publicKey;
  console.log("\n== Step 1: Create SILV Token-2022 mint (V2 shape) ==");
  console.log("SILV mint:", silvMint.toBase58());
  console.log("PermanentDelegate (seize/clawback, Ops vault):", admin.toBase58());
  console.log("Freeze authority (compliance freeze lever, Ops vault):", admin.toBase58());
  console.log("Mint authority PDA:", silvMintAuthorityPda.toBase58());
  console.log("Metadata authority PDA:", silvMetadataAuthorityPda.toBase58());
  await createSilvMint(
    connection,
    deployer,
    silvMintKeypair,
    silvMintAuthorityPda,
    silvMetadataAuthorityPda,
    admin,
    admin, // freezeAuthority = Ops Squads (compliance multisig) on devnet
  );

  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    DEVNET_USDC,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  console.log("\n== Step 2: Call program.initialize() (Lazer args) ==");

  // Pyth Lazer InitializeArgs: the Core pyth_feed_id[32] + pyth_receiver_program
  // were replaced by a single numeric pyth_lazer_feed_id (SILV = 3304); the
  // program/storage/treasury are compile-time constants in the contract. All
  // Option B economic params default on-chain + are admin-tunable post-deploy.
  // launch spec 2026-07: premium 1.5%/2% within ceilings (300/500); admin timelock 24h in [86400, 604800].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .initialize({
      admin,
      upgradeAuthorityInfo: upgradeSquads,
      permanentDelegateExpected: admin,
      freezeAuthorityExpected: admin,
      complianceMode: false,
      premiumBpsMint: 150, // 1.5% (launch spec 2026-07; ceiling 300)
      premiumBpsRedeem: 200, // 2% (ceiling 500)
      pythLazerFeedId: 3304, // SILV
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
  console.log(
    "  SILV_METADATA_AUTHORITY_PDA:",
    silvMetadataAuthorityPda.toBase58(),
  );

  const out = {
    programId: PROGRAM_ID.toBase58(),
    configPda: configPda.toBase58(),
    treasuryPda: treasuryPda.toBase58(),
    usdcTreasuryAta: usdcTreasuryAta.toBase58(),
    silvMint: silvMint.toBase58(),
    silvMintAuthorityPda: silvMintAuthorityPda.toBase58(),
    silvMetadataAuthorityPda: silvMetadataAuthorityPda.toBase58(),
    silvMintSecret: Array.from(silvMintKeypair.secretKey),
    initializeTx: sig,
    deployedAt: new Date().toISOString(),
  };
  const outPath = path.join(
    __dirname,
    "..",
    "target",
    "devnet-deployment.json",
  );
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
