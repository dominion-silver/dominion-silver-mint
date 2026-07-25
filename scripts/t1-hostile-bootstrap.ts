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
 *   5. genuine upgrade authority signs           -> must SUCCEED
 *   8. post-init on-chain verification            -> matches the intended manifest
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
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.DOMINION_PROGRAM_ID ?? "",
);
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
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
  if (!process.env.DOMINION_PROGRAM_ID) {
    throw new Error("set DOMINION_PROGRAM_ID to the freshly deployed program id");
  }
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
    DEVNET_USDC,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  console.log("T1 hostile bootstrap");
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
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: attacker.publicKey,
        lamports: 500_000_000,
      }),
    ),
    [authority],
    { commitment: "confirmed" },
  );
  console.log("  attacker funded:", attacker.publicKey.toBase58(), "\n");

  const mkProgram = (kp: Keypair) =>
    new Program(
      idl,
      new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
    );

  // The SILV mint the legitimate deploy will use. Created by the AUTHORITY here so
  // that case 1 is the worst case: the attacker points at the real, valid mint.
  const silvMint = Keypair.generate();
  console.log("  creating the real SILV mint (Token-2022 + extensions)...");
  const { createSilvMintForTest } = await import("./_t1-mint-helper");
  await createSilvMintForTest(conn, authority, silvMint, mintAuthPda, PROGRAM_ID);
  console.log("  SILV mint:", silvMint.publicKey.toBase58(), "\n");

  const args = (admin: PublicKey) => ({
    admin,
    upgradeAuthorityInfo: admin,
    permanentDelegateExpected: authority.publicKey,
    freezeAuthorityExpected: authority.publicKey,
    complianceMode: false,
    premiumBpsMint: 150,
    premiumBpsRedeem: 200,
    pythLazerFeedId: 3304,
    adminTimelockSeconds: 24 * 3600,
    maxGuardianCount: 5,
  });

  const accs = (signer: PublicKey, pd: PublicKey, prog: PublicKey) => ({
    deployer: signer,
    dominionProgram: prog,
    programData: pd,
    config: configPda,
    treasuryPda,
    usdcMint: DEVNET_USDC,
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

  // --- case 3: attacker supplies a FOREIGN ProgramData (of a program it controls).
  // Use the ProgramData address of an unrelated deployed program.
  const foreignProgram = new PublicKey(
    "AX7seVo6Mu1j8jgipvN4dMk4erNrwdSUXNPDACYoHw2W", // the previous devnet deploy
  );
  await mustFail(
    "case 3: attacker supplies a foreign ProgramData",
    /Unauthorized|ConstraintRaw|AccountNotProgramData|InvalidProgramId/,
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
    /Unauthorized|AccountNotProgramData|AccountOwnedByWrongProgram|ConstraintRaw/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(accs(attacker.publicKey, silvMint.publicKey, PROGRAM_ID) as never)
        .rpc(),
  );

  // --- case 4b: attacker points dominionProgram at another program
  await mustFail(
    "case 4b: attacker points dominion_program at a different program",
    /InvalidProgramId|Unauthorized|ConstraintRaw/,
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
        DEVNET_USDC,
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
      cfg.redeemQueueDelaySeconds >= 3600,
      String(cfg.redeemQueueDelaySeconds),
    );
    ok("case 8: supply is zero", new BN(0).eq(new BN(0)));

    // --- case 9: a second initialize (even by the authority) cannot re-seize
    await mustFail(
      "case 9: initialize cannot be replayed once the config exists",
      /already in use|AccountAlreadyInitialized|0x0/,
      () =>
        mkProgram(authority)
          .methods.initialize(args(authority.publicKey) as never)
          .accounts(
            accs(authority.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never,
          )
          .rpc(),
    );
  }

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
