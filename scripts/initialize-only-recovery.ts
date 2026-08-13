/**
 * RECOVERY PATH: call `initialize` alone, against a SILV mint that ALREADY EXISTS.
 *
 * WHY THIS EXISTS. SolidProof-adjacent review finding P0-5, 2026-08-12. T1
 * (`t1-hostile-bootstrap.ts`) creates the mint and calls `initialize` in one run. If it dies BETWEEN
 * those two things, the ceremony was stranded:
 *
 *  - T1 refuses to run again on a mint that already exists (`t1-hostile-bootstrap.ts`, the
 *    "ALREADY EXISTS on this cluster" throw), which is correct: it protects against a leaked keypair.
 *  - `initialize-devnet.ts` is not a recovery path. It creates its OWN mint, hardcodes devnet USDC, and
 *    passes premiums 150/200 instead of the ceremony's 100/150.
 *
 * So the only fallback was to re-run T1 WITHOUT `DOMINION_SILV_MINT_KEYPAIR`, which creates the token at
 * a random address while buyers, aggregators and the market maker hold `SiLVFMgD...`. That is losing the
 * announced address to a transient failure. This script closes that branch.
 *
 * IT SHARES THE ARGUMENT BUILDER WITH T1 ON PURPOSE. `buildT1InitializeArgs` is imported, not
 * reimplemented, so this script and the ceremony cannot drift. A hand-copied argument list is exactly how
 * `initialize-devnet.ts` ended up with the wrong premiums.
 *
 * IT VERIFIES THE MINT BEFORE IT COMMITS. `initialize` writes `freeze_authority_expected` and
 * `permanent_delegate_expected` into the config FOREVER, and `assertions.rs` re-asserts both against the
 * MINT on every priced instruction. So a mint whose on-chain authorities do not match what the config is
 * about to record would produce a config that is permanently incompatible with its own token: every mint,
 * redeem and pre-mint would revert, fixable only by a program upgrade. This refuses instead.
 *
 * WHEN NOT TO USE IT: if `initialize` already succeeded. It refuses in that case, because the config PDA
 * exists and `initialize` is one-shot per program id.
 *
 *   DOMINION_ALLOW_MAINNET=i-understand DOMINION_INTENT=initialize \
 *   DOMINION_RPC=... DOMINION_KEYPAIR=/path/to/deployer.json \
 *   npx tsx scripts/initialize-only-recovery.ts <EXISTING_SILV_MINT> [--send]
 *
 * Without `--send` it prints the resolved arguments and every precondition, and sends nothing.
 */
import {
  AnchorProvider,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  getPermanentDelegate,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { resolveCluster } from "./_cluster";
import { redactRpc } from "./_redact";
import { buildT1InitializeArgs } from "./t1-hostile-bootstrap";

const CLUSTER = resolveCluster();

function deployerKeypair(): Keypair {
  const p =
    process.env.DOMINION_KEYPAIR ||
    path.join(os.homedir(), ".config", "solana", "dominion-dev.json");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/** The ProgramData account the loader keeps the upgrade authority in. */
function programDataAddress(id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [id.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  )[0];
}

async function main(): Promise<void> {
  // slice(2) matters: argv[0] is the node binary and argv[1] is this script, and both are long paths
  // that satisfied the old predicate. The first version read the node path as the mint and died on
  // "Non-base58 character", which looks like a bad argument rather than a bad parser.
  const mintArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const send = process.argv.includes("--send");
  if (!mintArg) {
    throw new Error(
      "pass the EXISTING SILV mint address as an argument.\n" +
        "  npx tsx scripts/initialize-only-recovery.ts <MINT> [--send]",
    );
  }
  const silvMint = new PublicKey(mintArg);

  await requireSanctionedCluster(CLUSTER.rpc, "initialize-only-recovery");
  assertReversible("initialize", intentFromEnv());

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const deployer = deployerKeypair();
  const program = new Program(
    loadIdl() as Idl,
    new AnchorProvider(conn, new Wallet(deployer), { commitment: "confirmed" }),
  );

  console.log("initialize-only recovery");
  console.log(`  cluster  : ${redactRpc(CLUSTER.rpc)} (${CLUSTER.cluster})`);
  console.log(`  program  : ${PROGRAM_ID.toBase58()}`);
  console.log(`  deployer : ${deployer.publicKey.toBase58()}`);
  console.log(`  mint     : ${silvMint.toBase58()}`);
  console.log("");

  // ---- refusals, all BEFORE anything is sent ----

  // 1. The config must NOT exist. `initialize` is one-shot per program id.
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
  if (await conn.getAccountInfo(configPda)) {
    throw new Error(
      `config PDA ${configPda.toBase58()} ALREADY EXISTS: this program is already initialized.\n` +
        `  There is nothing to recover. If the config is wrong, the fix is a governed setter, not this.`,
    );
  }

  // 2. The mint must exist. If it does not, T1 is the right tool: it creates the mint AND initializes.
  const mintInfo = await conn.getAccountInfo(silvMint);
  if (!mintInfo) {
    throw new Error(
      `the mint ${silvMint.toBase58()} does not exist.\n` +
        `  This script is ONLY for the case where the mint was created and initialize did not land.\n` +
        `  With no mint, run t1-hostile-bootstrap.ts instead: it does both, and its 19 cases are the\n` +
        `  hostile-authentication proof that this script does not reproduce.`,
    );
  }
  if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`the mint is owned by ${mintInfo.owner.toBase58()}, not Token-2022. Wrong account.`);
  }

  // 3. The deployer must BE the live upgrade authority. The program enforces this
  //    (DeployerNotUpgradeAuthority), so failing here saves a transaction fee and gives a clearer
  //    message than an Anchor error code read at 3am.
  const pd = programDataAddress(PROGRAM_ID);
  const pdInfo = await conn.getAccountInfo(pd);
  if (!pdInfo) throw new Error(`ProgramData ${pd.toBase58()} not found: is the program deployed?`);
  // ProgramData layout: 4-byte enum, 8-byte slot, 1-byte Option, 32-byte pubkey.
  const hasAuthority = pdInfo.data[12] === 1;
  const onChainAuthority = hasAuthority ? new PublicKey(pdInfo.data.subarray(13, 45)) : null;
  if (!onChainAuthority || !onChainAuthority.equals(deployer.publicKey)) {
    throw new Error(
      `the deployer is NOT the upgrade authority.\n` +
        `  on chain : ${onChainAuthority ? onChainAuthority.toBase58() : "IMMUTABLE (authority revoked)"}\n` +
        `  signer   : ${deployer.publicKey.toBase58()}\n` +
        `  initialize binds these two (audit DOM-001). Move the authority back, or sign with that key.`,
    );
  }

  // 4. Build the arguments through the SHARED builder, so this cannot drift from the ceremony.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "config", "mainnet-authorities.json"), "utf8"),
  ) as Record<string, unknown>;
  const args = buildT1InitializeArgs(
    manifest,
    CLUSTER.cluster,
    deployer.publicKey,
    deployer.publicKey,
  );

  // 5. THE CHECK THAT MATTERS MOST. `initialize` freezes freeze_authority_expected and
  //    permanent_delegate_expected into the config, and assertions.rs re-asserts both against the MINT on
  //    every priced instruction. If the existing mint's authorities are not what the config is about to
  //    record, the result is a config permanently incompatible with its own token: every mint, redeem and
  //    pre-mint reverts, fixable only by a program upgrade. Refuse instead of committing that.
  const mint = await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const expected = args.permanentDelegateExpected;
  const freezeOk = mint.freezeAuthority?.equals(expected) ?? false;
  let delegate: PublicKey | null = null;
  try {
    delegate = getPermanentDelegate(mint)?.delegate ?? null;
  } catch {
    delegate = null;
  }
  const delegateOk = delegate?.equals(expected) ?? false;
  const mintAuthPda = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    PROGRAM_ID,
  )[0];
  const mintAuthOk = mint.mintAuthority?.equals(mintAuthPda) ?? false;

  console.log("  the existing mint, checked against what initialize will freeze into the config:");
  console.log(`    decimals          : ${mint.decimals} ${mint.decimals === 6 ? "OK" : "*** expected 6 ***"}`);
  console.log(`    supply            : ${mint.supply.toString()} ${mint.supply === 0n ? "OK" : "*** NOT ZERO ***"}`);
  console.log(`    mint authority    : ${mint.mintAuthority?.toBase58() ?? "none"} ${mintAuthOk ? "OK" : "*** must be the silv_mint_authority PDA ***"}`);
  console.log(`    freeze authority  : ${mint.freezeAuthority?.toBase58() ?? "none"} ${freezeOk ? "OK" : "*** must equal the compliance vault ***"}`);
  console.log(`    permanent delegate: ${delegate?.toBase58() ?? "none"} ${delegateOk ? "OK" : "*** must equal the compliance vault ***"}`);
  console.log(`    compliance vault  : ${expected.toBase58()}`);
  console.log("");

  if (!(freezeOk && delegateOk && mintAuthOk && mint.decimals === 6 && mint.supply === 0n)) {
    throw new Error(
      "the existing mint does not match what initialize would record. REFUSING.\n" +
        "  Initialising against this mint would produce a config permanently incompatible with its own\n" +
        "  token: assertions.rs re-checks the freeze authority and the permanent delegate on every priced\n" +
        "  instruction, so every mint, redeem and pre-mint would revert with no setter to fix it.\n" +
        "  If this mint is unusable, the announced address is lost and a new one must be announced.",
    );
  }

  console.log("  resolved initialize arguments (from the manifest, via T1's own builder):");
  console.log(`    admin             : ${args.admin.toBase58()}`);
  console.log(`    guardian          : ${args.guardian.toBase58()}`);
  console.log(`    inventory wallet  : ${args.inventoryWallet.toBase58()}`);
  console.log(`    premiums          : mint ${args.premiumBpsMint}bps / redeem ${args.premiumBpsRedeem}bps`);
  console.log(`    admin timelock    : ${args.adminTimelockSeconds}s`);
  console.log(`    lazer feed        : ${args.pythLazerFeedId}`);
  console.log(`    max guardians     : ${args.maxGuardianCount}`);
  console.log("");

  const treasuryPda = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID)[0];
  const usdcTreasury = getAssociatedTokenAddressSync(
    CLUSTER.usdcMint,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  );
  const accounts = {
    deployer: deployer.publicKey,
    firstGuardian: PublicKey.findProgramAddressSync(
      [Buffer.from("guardian"), args.guardian.toBuffer()],
      PROGRAM_ID,
    )[0],
    dominionProgram: PROGRAM_ID,
    programData: pd,
    config: configPda,
    treasuryPda,
    usdcMint: CLUSTER.usdcMint,
    silvMint,
    usdcTreasury,
    classicTokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };

  if (!send) {
    console.log("  --send NOT passed: nothing sent. Every precondition above is satisfied.");
    console.log("  Re-run with --send to initialize against this mint.");
    return;
  }

  const sig = await (program.methods as never as Record<string, (a: unknown) => { accounts: (x: unknown) => { rpc: () => Promise<string> } }>)
    .initialize(args as never)
    .accounts(accounts as never)
    .rpc();
  console.log(`  initialize sent: ${sig}`);

  // READ BACK. The transaction succeeding is a different claim from the config being right.
  const cfg = (await (program.account as never as Record<string, { fetch: (k: PublicKey) => Promise<Record<string, unknown>> }>)
    .configAccount.fetch(configPda)) as Record<string, unknown>;
  console.log("");
  console.log("  read back from chain:");
  console.log(`    admin            : ${String(cfg.admin)}`);
  console.log(`    silv mint        : ${String(cfg.silvMint)}`);
  console.log(`    inventory wallet : ${String(cfg.inventoryWallet)}`);
  console.log(`    paused           : ${String(cfg.paused)}`);
  console.log(`    public mint      : ${String(cfg.publicMintEnabled)}`);
  console.log(`    redemptions      : ${String(cfg.redemptionsEnabled)}`);
  console.log(`    guardian count   : ${String(cfg.guardianCount)}`);
  const ok =
    String(cfg.admin) === args.admin.toBase58() &&
    String(cfg.silvMint) === silvMint.toBase58() &&
    cfg.paused === true &&
    Number(cfg.guardianCount) === 1;
  console.log("");
  console.log(ok ? "  RECOVERY OK: the config is initialized and matches the manifest." : "  *** THE CONFIG DOES NOT MATCH. Investigate before doing anything else. ***");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("\ninitialize-only-recovery REFUSED/FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
