/**
 * Protocole A - ISOLATED dominion-admin-vault E2E on REAL devnet.
 *
 * Closes the one gap the generic Squads E2E (scripts/test-squads-e2e.ts,
 * 7/7) and the 68/68 dominion-with-dev-keypair-admin tests left open:
 *   "does a REAL dominion admin instruction execute correctly when it is
 *    wrapped in a Squads v4 vaultTransaction whose vault PDA IS the
 *    dominion config.admin?"
 *
 * Fully isolated + autonomous: deploys a THROWAWAY dominion program under a
 * fresh id (the orchestrating shell does the build+deploy and exports
 * DOMINION_E2E_PROGRAM_ID), creates a throwaway 2-of-3 test Squads multisig,
 * inits the throwaway dominion instance with config.admin = the test vault
 * (re-using the proven scripts/initialize-devnet.ts via DOMINION_PROGRAM_ID),
 * then drives the EXACT pipeline squads.ts / admin-actions.ts use:
 *   build set_redemptions_enabled(false) [admin = vault PDA]
 *   -> vaultTransactionCreate -> proposalCreate -> proposalApprove x2
 *   -> vaultTransactionExecute
 * and asserts ON-CHAIN that the dominion ConfigAccount actually flipped
 * redemptions_enabled true -> false. Never touches the live devnet instance.
 *
 * Env:
 *   DOMINION_E2E_PROGRAM_ID   (required) throwaway program id (shell-deployed)
 *   SQUADS_E2E_KEYPAIR        funder, default ~/.config/solana/dominion-test-user.json (>= ~8 SOL)
 */
import { createRequire } from "module";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";

const APUB = "/Users/thomasblanc/1_app/dominion/apps/admin/";
const REPO = "/Users/thomasblanc/1_app/dominion";
const r = createRequire(APUB);
/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Transaction,
} = r("@solana/web3.js");
const multisig = r("@sqds/multisig");
const anchor = r("@coral-xyz/anchor");

// RE-AUDIT P0 (the CLASS, not the instance). This script sends transactions and had NO cluster guard:
// it hardcoded the devnet RPC, so `DOMINION_RPC` was ignored and nothing confirmed the chain matched.
// The re-audit named `create-fee-vault.ts` as "the missing fourth"; the structural assertion in
// scripts/verify-cluster-resolution.ts then found NINE more, of which this is one. Every sending script
// now resolves its cluster from the environment and passes through the one guard, which does the consent
// check AND the genesis-hash cross-check.
const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;

function loadFunder(): any {
  const p = (
    process.env.SQUADS_E2E_KEYPAIR ||
    os.homedir() + "/.config/solana/dominion-test-user.json"
  ).replace(/^~/, os.homedir());
  if (!fs.existsSync(p)) {
    console.error(`FAIL: funder keypair not found at ${p}`);
    process.exit(1);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name} ${detail ? ":: " + detail : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${detail ? ":: " + detail : ""}`);
  }
}

async function airdropOrTransfer(
  conn: any,
  funder: any,
  to: any,
  lamports: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: to,
      lamports,
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [funder], {
    commitment: "confirmed",
  });
}

async function confirmSig(conn: any, sig: string) {
  const bh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction(
    {
      signature: sig,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    },
    "confirmed",
  );
}

async function waitForAccount(conn: any, pk: any, tries = 24, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    const ai = await conn.getAccountInfo(pk, "confirmed");
    if (ai) return;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new Error(`account ${pk.toBase58()} not visible after ${tries} polls`);
}

async function main() {
  await requireSanctionedCluster(RPC, "test-dominion-squads-e2e.ts");
  console.log("  " + describeCluster(CLUSTER));
  const programIdStr = process.env.DOMINION_E2E_PROGRAM_ID;
  if (!programIdStr) {
    console.error(
      "FAIL: DOMINION_E2E_PROGRAM_ID not set (shell must build+deploy the throwaway program first).",
    );
    process.exit(1);
  }
  const PROGRAM_ID = new PublicKey(programIdStr);
  const conn = new Connection(RPC, "confirmed");
  const funder = loadFunder();
  const bal = await conn.getBalance(funder.publicKey);
  console.log("Dominion x Squads v4 ISOLATED E2E (devnet)");
  console.log("throwaway program:", PROGRAM_ID.toBase58());
  console.log(
    "funder:",
    funder.publicKey.toBase58(),
    bal / LAMPORTS_PER_SOL,
    "SOL",
  );
  if (bal < 1.0 * LAMPORTS_PER_SOL) {
    console.error(`FAIL: funder has ${bal / LAMPORTS_PER_SOL} SOL, need >= ~1`);
    process.exit(1);
  }

  // --- Phase 1: throwaway 2-of-3 Squads multisig + funded vault ---
  const createKey = Keypair.generate();
  const memberA = Keypair.generate(); // creator + fee payer
  const memberB = Keypair.generate(); // 2nd approver -> threshold 2
  const memberC = Keypair.generate(); // 3rd member (inactive)
  await airdropOrTransfer(
    conn,
    funder,
    memberA.publicKey,
    0.15 * LAMPORTS_PER_SOL,
  );

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });
  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig =
    await multisig.accounts.ProgramConfig.fromAccountAddress(
      conn,
      programConfigPda,
    );
  const treasury = programConfig.treasury;
  const createSig = await multisig.rpc.multisigCreateV2({
    connection: conn,
    treasury,
    createKey,
    creator: memberA,
    multisigPda,
    configAuthority: null,
    threshold: 2,
    members: [memberA, memberB, memberC].map((k) => ({
      key: k.publicKey,
      permissions: multisig.types.Permissions.all(),
    })),
    timeLock: 0,
    rentCollector: null,
    sendOptions: { skipPreflight: false },
  });
  await confirmSig(conn, createSig);
  await waitForAccount(conn, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  // Fund the vault so it can pay the rent of any account the dominion ix
  // creates (set_redemptions_enabled creates none, but keep margin).
  await airdropOrTransfer(conn, funder, vaultPda, 0.05 * LAMPORTS_PER_SOL);
  console.log("multisig:", multisigPda.toBase58());
  console.log("vault (dominion admin):", vaultPda.toBase58());
  check("squads multisig created", true);

  // --- Phase 2: init the throwaway dominion instance, admin = vault PDA ---
  // Re-use the PROVEN scripts/initialize-devnet.ts (creates the SILV mint +
  // calls initialize() with args.admin = vault). DOMINION_PROGRAM_ID points
  // it at the throwaway program; DOMINION_KEYPAIR is the funder/deployer.
  const funderPath = (
    process.env.SQUADS_E2E_KEYPAIR ||
    os.homedir() + "/.config/solana/dominion-test-user.json"
  ).replace(/^~/, os.homedir());
  console.log("running initialize-devnet.ts against the throwaway program ...");
  execFileSync(
    "npx",
    [
      "tsx",
      path.join(REPO, "scripts/initialize-devnet.ts"),
      "--admin",
      vaultPda.toBase58(),
      "--upgrade-squads",
      vaultPda.toBase58(),
    ],
    {
      cwd: REPO,
      stdio: "inherit",
      env: {
        ...process.env,
        DOMINION_PROGRAM_ID: PROGRAM_ID.toBase58(),
        DOMINION_KEYPAIR: funderPath,
      },
    },
  );

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );
  await waitForAccount(conn, configPda);

  // Anchor program bound to the THROWAWAY id (idl.address overridden).
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(REPO, "target/idl/dominion_silver_mint.json"),
      "utf8",
    ),
  );
  idl.address = PROGRAM_ID.toBase58();
  const provider = new anchor.AnchorProvider(
    conn,
    {
      publicKey: memberA.publicKey,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    },
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl, provider);

  const cfg0: any = await program.account.configAccount.fetch(configPda);
  check(
    "init: redemptions_enabled defaults true",
    cfg0.redemptionsEnabled === true,
    `redemptionsEnabled=${cfg0.redemptionsEnabled}`,
  );
  check(
    "init: config.admin == squads vault",
    cfg0.admin.toBase58() === vaultPda.toBase58(),
    cfg0.admin.toBase58(),
  );

  // --- Phase 3: drive set_redemptions_enabled(false) THROUGH Squads ---
  const innerIx = await program.methods
    .setRedemptionsEnabled(false)
    .accounts({ config: configPda, admin: vaultPda })
    .instruction();

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: [innerIx],
  });
  const transactionIndex = 1n;

  await confirmSig(
    conn,
    await multisig.rpc.vaultTransactionCreate({
      connection: conn,
      feePayer: memberA,
      multisigPda,
      transactionIndex,
      creator: memberA.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: innerMessage,
    }),
  );
  check("vaultTransactionCreate (dominion ix wrapped)", true);

  await confirmSig(
    conn,
    await multisig.rpc.proposalCreate({
      connection: conn,
      feePayer: memberA,
      creator: memberA,
      multisigPda,
      transactionIndex,
    }),
  );
  await confirmSig(
    conn,
    await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: memberA,
      member: memberA,
      multisigPda,
      transactionIndex,
    }),
  );
  await confirmSig(
    conn,
    await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: memberA,
      member: memberB,
      multisigPda,
      transactionIndex,
    }),
  );
  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
  });
  await waitForAccount(conn, proposalPda);
  let proposal: any = await multisig.accounts.Proposal.fromAccountAddress(
    conn,
    proposalPda,
  );
  check(
    "proposal approved to threshold",
    (proposal.approved?.length ?? 0) >= 2,
    `${proposal.approved?.length} approvals`,
  );

  await confirmSig(
    conn,
    await multisig.rpc.vaultTransactionExecute({
      connection: conn,
      feePayer: memberA,
      multisigPda,
      transactionIndex,
      member: memberA.publicKey,
    }),
  );

  // --- Phase 4: assertions ---
  await new Promise((res) => setTimeout(res, 2500));
  proposal = await multisig.accounts.Proposal.fromAccountAddress(
    conn,
    proposalPda,
  );
  check(
    "proposal status = Executed",
    proposal.status?.__kind === "Executed",
    proposal.status?.__kind,
  );
  const cfg1: any = await program.account.configAccount.fetch(configPda);
  check(
    "DOMINION CONFIG MUTATED via Squads vault: redemptions_enabled true -> false",
    cfg1.redemptionsEnabled === false,
    `redemptionsEnabled=${cfg1.redemptionsEnabled}`,
  );

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  console.log(
    "Proves a REAL dominion admin instruction (set_redemptions_enabled), " +
      "built the exact way admin-actions.ts builds it, executes on-chain " +
      "when wrapped in the Squads v4 create -> approve(threshold) -> execute " +
      "pipeline with the Squads vault PDA as dominion config.admin. " +
      "Isolated throwaway instance; the live devnet program is untouched.",
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
