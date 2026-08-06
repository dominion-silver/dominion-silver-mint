/**
 * T1: hostile bootstrap. Proves audit finding DOM-001 (P0) is actually closed.
 *
 * The defect: `initialize` accepted ANY signer, so on a freshly deployed program
 * id an attacker could call it first, seize the single [CONFIG_SEED] PDA, set
 * itself as config.admin, then unpause, redirect the inventory and pre-mint the
 * entire supply cap.
 *
 * Run this against a FRESHLY DEPLOYED, NOT YET INITIALIZED program. It must be run
 * BEFORE scripts/initialize-devnet.ts, because once the config PDA exists every
 * initialize fails with AccountAlreadyInitialized and the test proves nothing.
 *
 *   DOMINION_PROGRAM_ID=<fresh id> \
 *   DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
 *   npx tsx scripts/t1-hostile-bootstrap.ts
 *
 * Cases (from the master audit doc, section 10, T1):
 *   1. attacker signs, real SILV mint            -> must FAIL (DeployerNotUpgradeAuthority)
 *   2. attacker signs, its own compliant mint    -> must FAIL
 *   3. attacker supplies a foreign ProgramData   -> must FAIL (constraint)
 *   4. attacker supplies a Buffer as ProgramData -> must FAIL (not ProgramData)
 *  4b. attacker points dominion_program elsewhere -> must FAIL (InvalidProgramId)
 *   5. genuine upgrade authority signs           -> must SUCCEED
 *   8. post-init on-chain verification            -> matches the intended manifest
 *   9. initialize cannot be replayed             -> must FAIL
 *
 * Every mustFail regex requires the SPECIFIC error for that case. They used to also
 * accept a generic Unauthorized, which meant cases 3, 4 and 4b could not tell their
 * own failure mode from any constraint failure (audit review of daac4ac, P2).
 *
 * Case 6 (a pre-created treasury ATA is tolerated, DOM-002) is exercised by
 * pre-creating that ATA before case 5.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet, Idl, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { createSilvMintForTest } from "./_t1-mint-helper";
import { requireDevnet, assertReversible, intentFromEnv } from "./_guard";
import {
  resolveCluster,
  describeCluster,
  mainnetConfig,
  type ClusterContext,
} from "./_cluster";

// EXTERNAL AUDIT 2026-08-06, FINDING S-01 (the P0). This block used to read:
//
//   const RPC = "https://api.devnet.solana.com";
//   const DEVNET_USDC = new PublicKey("4zMM...");
//
// and then `requireDevnet(RPC, ...)`. The guard was handed a constant containing "devnet", so it
// returned on its first line and the DOMINION_ALLOW_MAINNET branch could never run. The mainnet
// runbook tells the operator to invoke this script with a mainnet program id; it would have looked
// for that program's ProgramData ON DEVNET, funded a devnet attacker, and failed with nothing
// initialised, AFTER the mainnet deploy was paid for. `initialize` fires once per program id and
// case 5 below IS that initialisation, so there is no second attempt.
//
// The cluster now comes from the environment via scripts/_cluster.ts, which THROWS rather than
// falling back to a devnet address when a mainnet constant is unknown.
const CLUSTER: ClusterContext = resolveCluster();
const RPC = CLUSTER.rpc;
// Validated BEFORE constructing, so a missing id produces this sentence instead of web3.js's bare
// "Invalid public key input" thrown at module scope. The check inside main() was unreachable: this
// line ran first and crashed the import, so the helpful message could never print.
if (!process.env.DOMINION_PROGRAM_ID) {
  throw new Error(
    "set DOMINION_PROGRAM_ID to the freshly deployed program id.\n" +
      "T1 must run against a deployed but NOT YET INITIALIZED program.",
  );
}
const PROGRAM_ID = new PublicKey(process.env.DOMINION_PROGRAM_ID);
const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}
function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}
function programData(id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([id.toBytes()], BPF_LOADER)[0];
}

async function main() {
  // RULE 1 (scripts/_guard.ts): refuse any cluster but devnet unless
  // DOMINION_ALLOW_MAINNET is explicitly set.
  requireDevnet(RPC, "T1 hostile bootstrap");
  const INTENT = intentFromEnv();
  const conn = new Connection(RPC, "confirmed");
  const authority = loadKp(
    process.env.DOMINION_KEYPAIR ??
      path.join(os.homedir(), ".config/solana/dominion-dev.json"),
  );
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
      "utf8",
    ),
  ) as Idl;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    PROGRAM_ID,
  );
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    PROGRAM_ID,
  );
  const usdcTreasury = getAssociatedTokenAddressSync(
    CLUSTER.usdcMint,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  console.log("T1 hostile bootstrap");
  // Printed FIRST, and printed at all, because S-01 was invisible: nothing in the output said which
  // cluster the script was on, so a devnet run under a mainnet invocation looked identical to a
  // mainnet run right up to the failure.
  console.log("  " + describeCluster(CLUSTER));
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  config PDA:", configPda.toBase58());
  console.log("  upgrade authority:", authority.publicKey.toBase58());

  const cfgExists = await conn.getAccountInfo(configPda);
  if (cfgExists) {
    throw new Error(
      "config PDA already exists: this program is already initialized, so T1 " +
        "cannot prove anything. Deploy a fresh program id and run this FIRST.",
    );
  }
  console.log("  config PDA does not exist yet: the bootstrap window is open.\n");

  // ---- the attacker ----
  const attacker = Keypair.generate();
  // Funded by transfer, not requestAirdrop: the devnet faucet rate-limits and
  // returns -32603 "Internal error", which would make T1 flaky for a reason
  // that has nothing to do with what it is testing.
  //
  // AUDIT FINDING S-04: this was 500_000_000 lamports (0.5 SOL) sent to a `Keypair.generate()` that
  // exists only in this process's memory, never persisted and never refunded. On devnet that is
  // nobody's problem. Once S-01 made the mainnet path actually reachable it became 0.5 real SOL
  // burned per attempt, and a retry after a configuration error burns it again.
  //
  // Two changes: fund what the hostile cases actually need (a Token-2022 mint with extensions, an
  // ATA, and a handful of failing transactions), and sweep the remainder back at the end.
  const ATTACKER_FUNDING = 60_000_000; // 0.06 SOL
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: attacker.publicKey,
        lamports: ATTACKER_FUNDING,
      }),
    ),
    [authority],
    { commitment: "confirmed" },
  );
  console.log(
    `  attacker funded: ${attacker.publicKey.toBase58()} (${ATTACKER_FUNDING / 1e9} SOL, swept back at the end)\n`,
  );

  /** Return whatever the hostile key still holds. Best effort: a failure here must never turn a
   *  passing T1 into a failing one, so it reports and moves on. */
  async function sweepAttacker(): Promise<void> {
    try {
      const bal = await conn.getBalance(attacker.publicKey);
      const FEE = 5_000;
      if (bal <= FEE) {
        console.log(`  attacker sweep: nothing to return (${bal} lamports)`);
        return;
      }
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: attacker.publicKey,
            toPubkey: authority.publicKey,
            lamports: bal - FEE,
          }),
        ),
        [attacker],
        { commitment: "confirmed" },
      );
      console.log(`  attacker sweep: returned ${(bal - FEE) / 1e9} SOL to the authority`);
    } catch (e) {
      console.log(
        `  attacker sweep FAILED (${String(e).slice(0, 120)}). ` +
          `Abandoned key: ${attacker.publicKey.toBase58()}`,
      );
    }
  }

  const mkProgram = (kp: Keypair) =>
    new Program(
      idl,
      new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
    );

  // The SILV mint the legitimate deploy will use. Created by the AUTHORITY here so
  // that case 1 is the worst case: the attacker points at the real, valid mint.
  const silvMint = Keypair.generate();
  console.log("  creating the real SILV mint (Token-2022 + extensions)...");
  await createSilvMintForTest(conn, authority, silvMint, mintAuthPda, PROGRAM_ID);
  console.log("  SILV mint:", silvMint.publicKey.toBase58(), "\n");

  // AUDIT FINDING D-01. These were LITERALS, and they disagreed with everything else: the source of
  // truth says 100/150 bps, this script said 150/200, and the runbook told the operator to hand-edit
  // it to 150/500 on one page while stating 100/150 on another. Three values, one launch. Following
  // the runbook would have opened mainnet at 1.5%/5% instead of 1%/1.5%, and correcting either
  // premium afterwards costs a 24h timelocked proposal each.
  //
  // So they are READ from config/mainnet-authorities.json now. The runbook's "edit its args()"
  // instruction is deleted with them: a ceremony value that has to be retyped into TypeScript is a
  // ceremony value that will be retyped wrong.
  const posture = (mainnetConfig().launch_posture ?? {}) as Record<string, number>;
  function required(field: string): number {
    const v = posture[field];
    if (typeof v !== "number") {
      throw new Error(
        `launch_posture.${field} missing or not a number in config/mainnet-authorities.json`,
      );
    }
    return v;
  }
  const CEREMONY = {
    premiumBpsMint: required("premium_bps_mint"),
    premiumBpsRedeem: required("premium_bps_redeem"),
    adminTimelockSeconds: required("admin_timelock_seconds"),
    maxGuardianCount: required("max_guardian_count"),
    pythLazerFeedId: required("pyth_lazer_feed_id"),
  };
  console.log(
    `  ceremony args from config/mainnet-authorities.json: ` +
      `mint=${CEREMONY.premiumBpsMint}bps redeem=${CEREMONY.premiumBpsRedeem}bps ` +
      `timelock=${CEREMONY.adminTimelockSeconds}s guardians<=${CEREMONY.maxGuardianCount} ` +
      `feed=${CEREMONY.pythLazerFeedId}`,
  );

  // On a real cluster the authorities are the Squads vaults from the source of truth, not the local
  // dev keypair. On devnet the dev keypair IS the authority, which is what makes T1 runnable there.
  const auths = (mainnetConfig().authorities ?? {}) as Record<
    string,
    { pubkey?: string } | undefined
  >;
  function ceremonyAuthority(role: string, devnetFallback: PublicKey): PublicKey {
    if (CLUSTER.cluster === "devnet" || CLUSTER.cluster === "localnet") return devnetFallback;
    const pk = auths[role]?.pubkey;
    if (!pk) {
      throw new Error(
        `authorities.${role}.pubkey missing from config/mainnet-authorities.json, and this is ` +
          `${CLUSTER.cluster}. Refusing to initialise a real deployment with the dev keypair.`,
      );
    }
    return new PublicKey(pk);
  }
  const COMPLIANCE = ceremonyAuthority("compliance", authority.publicKey);

  const args = (admin: PublicKey) => ({
    admin,
    upgradeAuthorityInfo: admin,
    permanentDelegateExpected: COMPLIANCE,
    freezeAuthorityExpected: COMPLIANCE,
    complianceMode: false,
    ...CEREMONY,
  });

  const accs = (signer: PublicKey, pd: PublicKey, prog: PublicKey) => ({
    deployer: signer,
    dominionProgram: prog,
    programData: pd,
    config: configPda,
    treasuryPda,
    usdcMint: CLUSTER.usdcMint,
    silvMint: silvMint.publicKey,
    usdcTreasury,
    classicTokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  async function mustFail(name: string, expect: RegExp, fn: () => Promise<unknown>) {
    try {
      await fn();
      ok(name, false, "the transaction SUCCEEDED, the P0 is NOT closed");
    } catch (e: unknown) {
      const err = e as { error?: { errorCode?: { code?: string } }; message?: string };
      const txt = `${err?.error?.errorCode?.code ?? ""} ${err?.message ?? String(e)}`;
      ok(name, expect.test(txt), (err?.error?.errorCode?.code ?? txt.slice(0, 90)).trim());
    }
  }

  // --- case 1: attacker signs, pointing at the REAL mint and the REAL ProgramData
  await mustFail(
    "case 1: attacker signs with the real mint and real ProgramData",
    /DeployerNotUpgradeAuthority/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(accs(attacker.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never)
        .rpc(),
  );

  // --- case 2: attacker signs with a mint IT created, correctly shaped, whose
  // authorities it controls. Listed in this file's header since the first version
  // but never actually implemented (audit review of daac4ac, P2). It matters because
  // it is the realistic attack: the attacker does not need the real mint at all, it
  // needs the config PDA. The authentication check runs BEFORE any mint validation,
  // so the expected failure is still DeployerNotUpgradeAuthority, which also proves
  // the check is not accidentally dependent on mint shape.
  {
    const attackerMint = Keypair.generate();
    await createSilvMintForTest(
      conn,
      attacker,
      attackerMint,
      mintAuthPda,
      PROGRAM_ID,
    );
    const accsOwnMint = {
      ...accs(attacker.publicKey, programData(PROGRAM_ID), PROGRAM_ID),
      silvMint: attackerMint.publicKey,
    };
    await mustFail(
      "case 2: attacker signs with its own compliant mint",
      /DeployerNotUpgradeAuthority/,
      () =>
        mkProgram(attacker)
          .methods.initialize(args(attacker.publicKey) as never)
          .accounts(accsOwnMint as never)
          .rpc(),
    );
  }

  // --- case 3: attacker supplies a FOREIGN ProgramData (of a program it controls).
  // Use the ProgramData address of an unrelated deployed program.
  // AUDIT review of daac4ac (P2): this used to be the previous Dominion devnet
  // deploy. That program is ours, we retire ids routinely, and `solana program
  // close` would turn this case into a false FAIL (AccountNotInitialized matches
  // none of the expected codes). Pyth Lazer is a third-party, upgradeable, live
  // devnet program we will never close. Asserted below rather than assumed.
  const foreignProgram = CLUSTER.foreignUpgradeableProgram;
  {
    const pdInfo = await conn.getAccountInfo(programData(foreignProgram));
    if (!pdInfo || !pdInfo.owner.equals(BPF_LOADER)) {
      throw new Error(
        `case 3 precondition failed: ${foreignProgram.toBase58()} has no ` +
          `loader-owned ProgramData on this cluster. Pick another live ` +
          `upgradeable program; do NOT use a Dominion id.`,
      );
    }
  }
  await mustFail(
    "case 3: attacker supplies a foreign ProgramData",
    // Tightened after the review: this used to also accept ConstraintRaw,
    // AccountNotProgramData and InvalidProgramId, so it could not tell its own
    // failure mode from a generic constraint failure. The programdata_address()
    // constraint raises Unauthorized specifically.
    /Unauthorized/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(
          accs(attacker.publicKey, programData(foreignProgram), PROGRAM_ID) as never,
        )
        .rpc(),
  );

  // --- case 4: attacker supplies a non-ProgramData account (the config PDA seed
  // address is unallocated, so use the SILV mint: a real account, wrong type).
  await mustFail(
    "case 4: attacker supplies a non-ProgramData account",
    // Anchor's Owner impl for ProgramData rejects a non-loader-owned account.
    /AccountOwnedByWrongProgram/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(accs(attacker.publicKey, silvMint.publicKey, PROGRAM_ID) as never)
        .rpc(),
  );

  // --- case 4b: attacker points dominionProgram at another program
  await mustFail(
    "case 4b: attacker points dominion_program at a different program",
    // Program<'info, T> pins the account to crate::ID.
    /InvalidProgramId/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(
          accs(attacker.publicKey, programData(foreignProgram), foreignProgram) as never,
        )
        .rpc(),
  );

  // --- DOM-002: pre-create the treasury ATA, which used to brick initialize.
  console.log("\n  pre-creating the treasury USDC ATA (DOM-002 regression)...");
  // The instruction form, not the helper: the helper re-derives the address with
  // allowOwnerOffCurve=false and throws TokenOwnerOffCurveError on a PDA owner.
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        attacker.publicKey, // anyone may create it: that is the point
        usdcTreasury,
        treasuryPda,
        CLUSTER.usdcMint,
        TOKEN_PROGRAM_ID,
      ),
    ),
    [attacker],
    { commitment: "confirmed" },
  );
  const ataInfo = await conn.getAccountInfo(usdcTreasury);
  ok("DOM-002: the treasury ATA now exists before initialize", ataInfo !== null);

  // --- case 5: the genuine upgrade authority succeeds, DESPITE the pre-created ATA
  let initSig = "";
  try {
    initSig = await mkProgram(authority)
      .methods.initialize(args(authority.publicKey) as never)
      .accounts(
        accs(authority.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never,
      )
      .rpc();
    ok("case 5: the genuine upgrade authority initializes successfully", true, initSig.slice(0, 12) + "...");
  } catch (e) {
    ok("case 5: the genuine upgrade authority initializes successfully", false, String(e).slice(0, 200));
  }

  // --- case 8: verify the resulting on-chain state matches intent
  if (initSig) {
    const program = mkProgram(authority);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = await (program.account as any).configAccount.fetch(configPda);
    ok("case 8: config.admin is the intended admin", new PublicKey(cfg.admin).equals(authority.publicKey));
    ok("case 8: config.silvMint is the intended mint", new PublicKey(cfg.silvMint).equals(silvMint.publicKey));
    ok("case 8: starts paused", cfg.paused === true);
    ok("case 8: public mint closed", cfg.publicMintEnabled === false);
    ok("case 8: redemptions closed", cfg.redemptionsEnabled === false);
    ok("case 8: guardian floor field present", typeof cfg.guardianCount === "number");
    ok(
      "case 8: queue delay respects the new floor",
      // Was `redeemQueueDelaySeconds >= 3600`. That passed, which is exactly why it was worse
      // than useless: the field is DEAD on chain since 2026-08-05, so a green check here was a
      // false assurance about a throttle nothing reads. The live throttle is the rolling window.
      cfg.instantRedeemWindowSeconds >= 60,
      String(cfg.instantRedeemWindowSeconds),
    );
    // AUDIT review of daac4ac (P1): this line used to read
    //   ok("case 8: supply is zero", new BN(0).eq(new BN(0)))
    // which is a tautology. It asserted nothing, never touched the mint, and was
    // counted in the headline "15/15". The thing it claims to check is the CODEX
    // C-01 rug-by-init defence, so it now reads the real mint.
    const mintAfter = await getMint(
      conn,
      silvMint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    ok(
      "case 8: SILV supply is zero at init",
      mintAfter.supply === 0n,
      `supply=${mintAfter.supply}`,
    );
    ok(
      "case 8: mint authority is the program PDA",
      mintAfter.mintAuthority?.equals(mintAuthPda) ?? false,
      mintAfter.mintAuthority?.toBase58() ?? "null",
    );

    // --- case 9: a second initialize (even by the authority) cannot re-seize
    await mustFail(
      "case 9: initialize cannot be replayed once the config exists",
      // "0x0" was removed: it matches a broad class of unrelated messages.
      /already in use|AccountAlreadyInitialized/,
      () =>
        mkProgram(authority)
          .methods.initialize(args(authority.publicKey) as never)
          .accounts(
            accs(authority.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never,
          )
          .rpc(),
    );
  }

  await sweepAttacker();

  console.log(`\n=== T1 result: ${pass} passed, ${fail} failed ===`);
  if (initSig) {
    console.log("initialize tx:", initSig);
    console.log("SILV mint secret is NOT persisted by this script (audit A-30).");
    console.log("SILV mint pubkey:", silvMint.publicKey.toBase58());
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("T1 crashed:", e);
  process.exit(1);
});
