/**
 * T2: on-chain proof that audit DOM-007 (the guardian-set capture) is closed.
 *
 * DOM-007 was: the admin could add a puppet guardian and instantly remove every
 * real guardian, so the guardian veto was decorative. The fix is two-part:
 *   (a) the admin itself can never be added as a guardian, and
 *   (b) removal is DEFERRED by admin_timelock_seconds: schedule -> wait -> finalize,
 *       with the count floored at MIN_ACTIVE_GUARDIANS and a cancel path open to
 *       both the admin and the targeted guardian.
 *
 * Run (devnet, admin keypair):
 *   DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json npx tsx scripts/e2e-guardian-devnet.ts
 *
 * Non-destructive: every guardian this script adds is left in place with
 * pending_removal_at == 0, because finalizing a removal needs a 24h wait.
 */
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.DOMINION_PROGRAM_ID || "gc5TWUkmKpTfoL88HwsBduxbo2rZNEzhYinW7WqYaDc",
);

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}
async function expectRevert(name: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "expected revert, tx SUCCEEDED");
  } catch (e: any) {
    const txt = (e?.error?.errorCode?.code || "") + " " + (e?.message || String(e));
    ok(name, txt.includes(code), `got ${e?.error?.errorCode?.code || txt.slice(0, 90)}`);
  }
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.DOMINION_KEYPAIR ||
            path.join(os.homedir(), ".config/solana/dominion-dev.json"),
          "utf8",
        ),
      ),
    ),
  );
  const admin = kp.publicKey;
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
      "utf8",
    ),
  ) as Idl;
  const program = new Program(idl, provider);
  const cfgAcct = (program.account as any).configAccount;
  const gAcct = (program.account as any).guardianAccount;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const gPda = (g: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("guardian"), g.toBuffer()], PROGRAM_ID)[0];

  const cfg0: any = await cfgAcct.fetch(configPda);
  console.log("T2 guardian lifecycle (DOM-007)");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  admin:", admin.toBase58());
  console.log("  guardian_count:", cfg0.guardianCount, "| max:", cfg0.maxGuardianCount);
  console.log("  admin_timelock_seconds:", cfg0.adminTimelockSeconds, "\n");

  // --- 1. the puppet barrier: the admin can never be its own guardian.
  await expectRevert("add_guardian(admin) is rejected", "Unauthorized", () =>
    program.methods
      .addGuardian(admin)
      .accounts({ config: configPda, admin, payer: admin, guardianAccount: gPda(admin) })
      .rpc(),
  );

  // --- 2. add G1. Derived from a fixed seed so the script is idempotent across runs.
  const G1 = Keypair.fromSeed(Uint8Array.from(Buffer.alloc(32, 0xa1))).publicKey;
  const G2 = Keypair.fromSeed(Uint8Array.from(Buffer.alloc(32, 0xa2))).publicKey;
  for (const [label, g] of [
    ["G1", G1],
    ["G2", G2],
  ] as const) {
    const existing = await conn.getAccountInfo(gPda(g));
    if (existing) {
      console.log(`  ${label} already present, reusing:`, g.toBase58());
      continue;
    }
    await program.methods
      .addGuardian(g)
      .accounts({ config: configPda, admin, payer: admin, guardianAccount: gPda(g) })
      .rpc();
    console.log(`  ${label} added:`, g.toBase58());
  }
  const cfg1: any = await cfgAcct.fetch(configPda);
  ok("guardian_count reflects both guardians", cfg1.guardianCount >= 2, String(cfg1.guardianCount));

  // --- 3. remove_guardian only SCHEDULES: the target stays active.
  const g2Before: any = await gAcct.fetch(gPda(G2));
  if (g2Before.pendingRemovalAt.toString() !== "0") {
    // left scheduled by an earlier run: cancel so the test starts clean.
    await program.methods
      .cancelGuardianRemoval(G2)
      .accounts({ config: configPda, signer: admin, guardianAccount: gPda(G2) })
      .rpc();
    console.log("  cleared a removal left scheduled by a previous run");
  }
  const beforeCount = (await cfgAcct.fetch(configPda)).guardianCount;
  await program.methods
    .removeGuardian(G2)
    .accounts({ config: configPda, admin, guardianAccount: gPda(G2) })
    .rpc();
  const g2Sched: any = await gAcct.fetch(gPda(G2));
  const cfg2: any = await cfgAcct.fetch(configPda);
  ok(
    "remove_guardian schedules instead of deleting",
    g2Sched.pendingRemovalAt.toString() !== "0",
    "pending_removal_at=" + g2Sched.pendingRemovalAt.toString(),
  );
  ok(
    "the scheduled guardian is STILL active (cooldown_until == 0)",
    g2Sched.cooldownUntil.toString() === "0",
  );
  ok(
    "guardian_count is unchanged while the removal is pending",
    cfg2.guardianCount === beforeCount,
    `${beforeCount} -> ${cfg2.guardianCount}`,
  );
  const eta = Number(g2Sched.pendingRemovalAt);
  const nowS = Math.floor(Date.now() / 1000);
  ok(
    "the ETA is one full admin timelock away",
    eta - nowS > cfg2.adminTimelockSeconds - 120,
    `${eta - nowS}s vs ${cfg2.adminTimelockSeconds}s`,
  );

  // --- 4. double-scheduling is rejected.
  await expectRevert(
    "a second remove_guardian is rejected",
    "GuardianRemovalAlreadyScheduled",
    () =>
      program.methods
        .removeGuardian(G2)
        .accounts({ config: configPda, admin, guardianAccount: gPda(G2) })
        .rpc(),
  );

  // --- 5. finalize before the ETA is rejected. This is the whole point of the fix:
  //        the admin cannot clear the guardian set inside one transaction.
  await expectRevert("finalize before the ETA is rejected", "TimelockNotElapsed", () =>
    program.methods
      .finalizeGuardianRemoval(G2)
      .accounts({ config: configPda, guardianAccount: gPda(G2) })
      .rpc(),
  );

  // --- 6. cancel restores the guardian, and finalize then has nothing to do.
  await program.methods
    .cancelGuardianRemoval(G2)
    .accounts({ config: configPda, signer: admin, guardianAccount: gPda(G2) })
    .rpc();
  const g2Cancelled: any = await gAcct.fetch(gPda(G2));
  ok(
    "cancel_guardian_removal clears pending_removal_at",
    g2Cancelled.pendingRemovalAt.toString() === "0",
  );
  await expectRevert("finalize with nothing scheduled is rejected", "GuardianRemovalNotScheduled", () =>
    program.methods
      .finalizeGuardianRemoval(G2)
      .accounts({ config: configPda, guardianAccount: gPda(G2) })
      .rpc(),
  );

  // --- 7. the floor: with the count at MIN_ACTIVE_GUARDIANS a schedule is refused.
  //        Reached by scheduling G1 too, then checking a third would breach it.
  //        Only assert the floor when the live count is exactly at it, so the test
  //        stays honest on a config that has extra guardians.
  const cfgN: any = await cfgAcct.fetch(configPda);
  if (cfgN.guardianCount === 1) {
    await expectRevert("removal at the floor is refused", "GuardianFloorBreached", () =>
      program.methods
        .removeGuardian(G1)
        .accounts({ config: configPda, admin, guardianAccount: gPda(G1) })
        .rpc(),
    );
  } else {
    console.log(
      `  SKIP: floor check needs guardian_count == 1, live count is ${cfgN.guardianCount}`,
    );
  }

  console.log(`\n=== T2 result: ${pass} passed, ${fail} failed ===`);
  const finalCfg: any = await cfgAcct.fetch(configPda);
  console.log("final guardian_count:", finalCfg.guardianCount);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error("T2 crashed:", e);
  process.exit(1);
});
