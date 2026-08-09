/**
 * One-time DEVNET initialization for the V2 program: creates the SILV Token-2022 mint,
 * then calls initialize(). It sends transactions, so it must pass requireSanctionedCluster.
 *
 * `initialize` succeeds ONCE per program id. Run scripts/t1-hostile-bootstrap.ts first:
 * that is the only window in which the DOM-001 authentication can be tested, and its
 * case 5 performs the real init. Requires a fresh deploy (never an in-place upgrade over
 * a program whose ConfigAccount layout differs) and a regenerated V2 IDL at
 * target/idl/dominion_silver_mint.json, built with the toolchain pinned in Anchor.toml.
 *
 * Run: npx tsx scripts/initialize-devnet.ts --admin <ops_vault> --upgrade-squads <upgrade_vault>
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
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";

// The cluster must come from the environment and pass the one guard, which does the
// consent check AND the genesis-hash cross-check. Never hardcode an RPC in a script that
// sends. scripts/verify-cluster-resolution.ts asserts this structurally.
const CLUSTER = resolveCluster();
const DEVNET_RPC = CLUSTER.rpc;
// Never hardcode a program id, not even as a fallback: scripts/_program-id.ts owns it.
// Its DOMINION_PROGRAM_ID override exists ONLY for the isolated Squads E2E
// (scripts/test-dominion-squads-e2e.ts), which deploys a throwaway instance under a fresh
// id. Unset in every real deploy, which yields the canonical id.
const PROGRAM_ID = SHARED_PROGRAM_ID;
// DOM-001: `initialize` requires the signer to BE the program's upgrade authority, proven
// through the loader's ProgramData account. That account is not a PDA of this program, so
// Anchor cannot resolve it and it must be passed explicitly.
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
function programDataAddress(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBytes()],
    BPF_LOADER_UPGRADEABLE,
  );
  return pda;
}
// Circle devnet USDC (in the V2 initialize allowlist).
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

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
 * Create the SILV Token-2022 mint exactly as V2 initialize.rs expects: decimals 6 and
 * EXACTLY the extensions {PermanentDelegate, MetadataPointer, in-mint TokenMetadata}.
 *
 * Two phases, because InitializeMetadata must be signed by the mint authority. Phase 1
 * creates the mint with mint_authority = payer and freeze_authority = the compliance
 * multisig (V2 requires freeze_authority == freeze_authority_expected, NOT None), then
 * initializes the metadata. MetadataPointer.authority and TokenMetadata.update_authority
 * go straight to silv_metadata_authority: in Token-2022 the MetadataPointer authority is
 * not rotatable (only its address is), so it must be right at init. Phase 2 rotates the
 * mint authority to silv_mint_authority.
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
    // PERMANENT. Must equal initialize's args.permanent_delegate_expected.
    createInitializePermanentDelegateInstruction(
      silvMintKeypair.publicKey,
      permanentDelegate,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataPointerInstruction(
      silvMintKeypair.publicKey,
      silvMetadataAuthorityPda,
      silvMintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    // mint_authority = payer, rotated in phase 2. freeze_authority is PERMANENT and must
    // equal the freezeAuthorityExpected passed to initialize().
    createInitializeMintInstruction(
      silvMintKeypair.publicKey,
      decimals,
      payer.publicKey,
      freezeAuthority,
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

  const sig1 = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer, silvMintKeypair],
    { commitment: "confirmed" },
  );
  console.log(`  ✅ Phase 1 (mint + 3 extensions + metadata): ${sig1}`);

  // Phase 2 rotates ONLY the mint authority; the others are already final.
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
  await requireSanctionedCluster(DEVNET_RPC, "initialize-devnet");
  console.log("  " + describeCluster(CLUSTER));
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
    // Isolated Squads E2E: the throwaway id differs from the IDL's baked canonical id, and
    // Anchor 0.31 derives the program id from idl.address.
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
  // V2 requires the metadata authorities to be this distinct PDA, not the mint authority.
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

  // ROUND 8 L1-02: a distinct key for the first guardian. DOMINION_DEVNET_GUARDIAN when the operator
  // has one to keep; otherwise a fresh one, whose private key is discarded. That is acceptable on
  // devnet, where nothing needs to be paused, and it is exactly what must NOT happen on mainnet:
  // there the guardian is a real independent holder, read from the manifest by T1.
  const devnetGuardian = process.env.DOMINION_DEVNET_GUARDIAN
    ? new PublicKey(process.env.DOMINION_DEVNET_GUARDIAN)
    : Keypair.generate().publicKey;
  console.log("  first guardian (devnet stand-in):", devnetGuardian.toBase58());

  // Lazer InitializeArgs: one numeric pyth_lazer_feed_id replaces the Core feed id plus
  // receiver account. Every economic param below is admin-tunable after deploy.
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
      // 3154 = Metal.Index.SILVER/USD, pure spot. Not 3304, which carried a hidden 5%
      // premium: all margin must live in premium_bps_*, where it is visible on-chain.
      pythLazerFeedId: 3154,
      adminTimelockSeconds: 24 * 3600, // 24h
      maxGuardianCount: 5,
      // ROUND 8 L1-01. REQUIRED, and the omission was invisible: Anchor's client coder encodes an
      // absent Pubkey as 32 zero bytes, so the transaction is well-formed and the program reverts
      // InventoryWalletNotSet. On devnet the admin stands in for the inventory wallet, exactly as it
      // stands in for every other ceremony authority here.
      inventoryWallet: admin,
      // ROUND 8 L1-02. The first guardian, appointed by initialize. On devnet a throwaway key stands
      // in, exactly as the admin stands in for every other ceremony authority here. It must NOT be
      // the admin: the program refuses that, because a guardian slot held by the admin is a brake
      // wired to the same lever.
      guardian: devnetGuardian,
    })
    .accounts({
      deployer: deployer.publicKey,
      // Passed explicitly despite the IDL's `address` literal: the DOMINION_PROGRAM_ID
      // override rewrites only idl.address, so the throwaway-id path would send the
      // canonical program here instead.
      dominionProgram: PROGRAM_ID,
      programData: programDataAddress(PROGRAM_ID),
      config: configPda,
      treasuryPda,
      usdcMint: DEVNET_USDC,
      silvMint,
      usdcTreasury: usdcTreasuryAta,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      // ROUND 8 L1-02: initialize creates the first GuardianAccount.
      firstGuardian: PublicKey.findProgramAddressSync(
        [Buffer.from("guardian"), devnetGuardian.toBuffer()],
        PROGRAM_ID,
      )[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Pre-flight, because step 1 already created the mint: a wrong signer would otherwise
  // fail with an opaque DeployerNotUpgradeAuthority after the SOL is spent. On mainnet, if
  // the upgrade authority is already an Upgrade Squads vault, initialize must run AS that
  // vault (it signs and pays rent, so it must hold SOL): initialize before transferring the
  // authority, or route this through the vault. See private/DEPLOY_CHECKLIST.md.
  {
    const pdAddr = programDataAddress(PROGRAM_ID);
    const pd = await connection.getAccountInfo(pdAddr);
    if (!pd) {
      throw new Error(
        `ProgramData ${pdAddr.toBase58()} not found. Is ${PROGRAM_ID.toBase58()} deployed with the upgradeable loader?`,
      );
    }
    // UpgradeableLoaderState::ProgramData = 4-byte enum tag, 8-byte slot,
    // 1-byte Option tag, then 32-byte authority when present.
    const hasAuthority = pd.data[12] === 1;
    if (!hasAuthority) {
      throw new Error(
        "The program's upgrade authority has been revoked, so initialize can never succeed. " +
          "Initialize before making the program immutable.",
      );
    }
    const authority = new PublicKey(pd.data.subarray(13, 45));
    if (!authority.equals(deployer.publicKey)) {
      throw new Error(
        `initialize must be signed by the upgrade authority.\n` +
          `  upgrade authority: ${authority.toBase58()}\n` +
          `  this signer:       ${deployer.publicKey.toBase58()}\n` +
          `If the authority is a Squads vault, run initialize as a vault transaction.`,
      );
    }
    console.log("Upgrade-authority pre-flight OK:", authority.toBase58());
  }

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
