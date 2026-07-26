/**
 * T2: on-chain proof that audit DOM-007 (the guardian-set capture) is closed.
 *
 * DOM-007 was: the admin could add a puppet guardian and instantly remove every
 * real guardian, so the guardian veto was decorative. The fix, after the review of
 * daac4ac corrected it twice:
 *   (a) neither the current NOR the pending admin can be added as a guardian,
 *   (b) removal is DEFERRED by admin_timelock_seconds: schedule -> wait -> finalize,
 *   (c) the floor counts only guardians NOT already under notice, so the whole set
 *       cannot be scheduled inside one window,
 *   (d) the targeted guardian may veto its own removal ONCE. Unlimited self-veto
 *       (the first version) made a ROGUE guardian permanently unremovable while it
 *       held an indefinite pause, which was a P0 in the other direction.
 *
 * Run (devnet, admin keypair):
 *   DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json npx tsx scripts/e2e-guardian-devnet.ts
 *
 * Non-destructive as to the guardian SET: every guardian this script adds is left in
 * place with pending_removal_at == 0, because finalizing a removal needs a 24h wait.
 *
 * NOT non-destructive as to G2's one-shot self-veto budget: section 8 deliberately
 * spends it and asserts that it stays spent. Only a full remove + cooldown + re-add
 * resets it, which needs 24h, so section 8 branches on the live flag and reports which
 * half of the rule it exercised. Do not "fix" that branch by re-deriving a fresh
 * guardian per run: max_guardian_count is 5 and the script would leak a slot each
 * time.
 */
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.DOMINION_PROGRAM_ID || "6bgSnXYg11BWnGRc3R7xenDPCqt2xu2YswkzQGr4AoYh",
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
  // This script INSTALLS guardians and leaves them installed. That is acceptable on
  // devnet and unacceptable anywhere else, so refuse to run against a non-devnet
  // endpoint rather than trusting the operator's environment.
  if (!/devnet/i.test(RPC)) {
    throw new Error(
      `refusing to run: ${RPC} is not a devnet endpoint. This script installs ` +
        `real guardians and does not remove them (removal needs a 24h wait).`,
    );
  }
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

  // --- 2. add G1 and G2.
  //
  // AUDIT review of daac4ac (P0, found independently by two reviewers): these used to
  // be Keypair.fromSeed(Buffer.alloc(32, 0xa1)) / 0xa2, i.e. DERIVABLE BY ANYONE WHO
  // READS THIS FILE. The script leaves them installed, so for as long as they were
  // live, any reader of the repo could `pause()` the program both apps point at,
  // `cancel_timelocked_action` on any queued proposal, and `cancel_admin_transfer`.
  // They also occupied real slots against max_guardian_count.
  //
  // Now derived from the ADMIN'S OWN SECRET KEY, which gives the same idempotence
  // (the same operator gets the same test guardians every run, so the script does not
  // leak slots) without the keys being recoverable from source. Only the holder of the
  // admin keypair can derive or use them.
  const testGuardian = (label: string) =>
    Keypair.fromSeed(
      createHash("sha256")
        .update(kp.secretKey)
        .update(`dominion-t2-guardian:${label}`)
        .digest(),
    );
  const G1kp = testGuardian("1");
  const G2kp = testGuardian("2");
  const G1 = G1kp.publicKey;
  const G2 = G2kp.publicKey;
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

  // --- 7. THE FLOOR. This is the anti-purge check, and in the previous version of
  // this script it was unreachable dead code: it was gated on `guardianCount === 1`
  // while the script itself had just added two guardians and never finalized either,
  // so the count was always >= 2 and the branch never ran. It printed SKIP, but the
  // headline "10/10" implied the floor was covered. It was not covered anywhere: no
  // Rust test referenced MIN_ACTIVE_GUARDIANS or GuardianFloorBreached either.
  //
  // The fix in this batch makes the check testable with the guardians we already
  // have. The floor is now evaluated against guardians NOT ALREADY UNDER NOTICE, so
  // with exactly 2 guardians the FIRST schedule is legal and the SECOND must be
  // refused: one guardian has to stay free to react.
  const cfgN: any = await cfgAcct.fetch(configPda);
  if (cfgN.guardianCount === 2) {
    // Clean slate: neither guardian under notice.
    for (const g of [G1, G2]) {
      const ga: any = await gAcct.fetch(gPda(g));
      if (ga.pendingRemovalAt.toString() !== "0") {
        await program.methods
          .cancelGuardianRemoval(g)
          .accounts({ config: configPda, signer: admin, guardianAccount: gPda(g) })
          .rpc();
      }
    }
    await program.methods
      .removeGuardian(G1)
      .accounts({ config: configPda, admin, guardianAccount: gPda(G1) })
      .rpc();
    const mid: any = await cfgAcct.fetch(configPda);
    ok(
      "the first of two removals is accepted and counted",
      mid.pendingRemovalCount === 1,
      `pending_removal_count=${mid.pendingRemovalCount}`,
    );
    // The parallel purge from the review: scheduling BOTH would have cost one single
    // 24h window for the whole guardian set.
    await expectRevert(
      "scheduling the LAST free guardian is refused (floor)",
      "GuardianFloorBreached",
      () =>
        program.methods
          .removeGuardian(G2)
          .accounts({ config: configPda, admin, guardianAccount: gPda(G2) })
          .rpc(),
    );
    // Restore: cancel as ADMIN so G1's one-shot self-veto is not consumed.
    await program.methods
      .cancelGuardianRemoval(G1)
      .accounts({ config: configPda, signer: admin, guardianAccount: gPda(G1) })
      .rpc();
    const after: any = await cfgAcct.fetch(configPda);
    ok(
      "cancelling decrements pending_removal_count",
      after.pendingRemovalCount === 0,
      `pending_removal_count=${after.pendingRemovalCount}`,
    );
    const g1After: any = await gAcct.fetch(gPda(G1));
    ok(
      "an admin cancel does NOT consume the guardian's self-veto",
      g1After.selfCancelUsed === false,
    );
  } else {
    console.log(
      `  SKIP: the floor case needs exactly 2 guardians, live count is ${cfgN.guardianCount}`,
    );
    fail++; // never let a skipped security assertion look like a pass
    console.log("  (counted as a FAILURE: this assertion must not be skipped silently)");
  }

  // --- 8. the one-shot self-veto (the P0 fix from the review of daac4ac).
  {
    await program.methods
      .removeGuardian(G2)
      .accounts({ config: configPda, admin, guardianAccount: gPda(G2) })
      .rpc();
    // G2 signs for itself. It needs lamports for the fee.
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin,
          toPubkey: G2,
          lamports: 10_000_000,
        }),
      ),
      [kp],
      { commitment: "confirmed" },
    );
    const asG2 = new Program(
      idl,
      new AnchorProvider(conn, new Wallet(G2kp), { commitment: "confirmed" }),
    );

    // Review-of-fixes: this section is what makes the script SINGLE-USE, and the
    // first version crashed on run 2 instead of failing cleanly. The self-veto is
    // one-shot BY DESIGN and only a full remove + 1h cooldown + re-add resets it,
    // which this script cannot do (finalizing needs 24h). So G2 keeps
    // self_cancel_used == true forever, and a bare `await` of the self-cancel throws
    // an unhandled GuardianSelfCancelExhausted on every later run, after ~14
    // assertions have already printed PASS. Since "T2 green" is a release gate, a
    // gate satisfiable exactly once per admin keypair is not a gate.
    //
    // Handled by branching on the live flag: whichever state the guardian is in, the
    // rule being tested is asserted, and the run is honest about which half it
    // exercised.
    const g2Pre: any = await gAcct.fetch(gPda(G2));
    if (!g2Pre.selfCancelUsed) {
      await asG2.methods
        .cancelGuardianRemoval(G2)
        .accounts({ config: configPda, signer: G2, guardianAccount: gPda(G2) })
        .rpc();
      const g2a: any = await gAcct.fetch(gPda(G2));
      ok(
        "the targeted guardian can veto its own removal",
        g2a.pendingRemovalAt.toString() === "0" && g2a.selfCancelUsed === true,
        `self_cancel_used=${g2a.selfCancelUsed}`,
      );
      // Re-schedule so the exhaustion check below has something to refuse.
      await program.methods
        .removeGuardian(G2)
        .accounts({ config: configPda, admin, guardianAccount: gPda(G2) })
        .rpc();
    } else {
      console.log(
        "  NOTE: G2 already spent its self-veto in an earlier run, so the " +
          "first-veto-succeeds half is skipped. The exhaustion check below is the " +
          "half that matters and still runs.",
      );
      ok("the spent self-veto persisted across runs", g2Pre.selfCancelUsed === true);
      if (g2Pre.pendingRemovalAt.toString() === "0") {
        await program.methods
          .removeGuardian(G2)
          .accounts({ config: configPda, admin, guardianAccount: gPda(G2) })
          .rpc();
      }
    }

    // The SECOND self-veto must be refused: this is what stops a rogue guardian
    // being permanently unremovable. (The re-schedule happened in whichever branch
    // ran above.)
    await expectRevert(
      "the SECOND self-veto is refused (rogue guardian is now evictable)",
      "GuardianSelfCancelExhausted",
      () =>
        asG2.methods
          .cancelGuardianRemoval(G2)
          .accounts({ config: configPda, signer: G2, guardianAccount: gPda(G2) })
          .rpc(),
    );
    // The admin can still cancel, so the guardian is not stuck under notice by
    // accident. Leaves the config clean for the next run.
    await program.methods
      .cancelGuardianRemoval(G2)
      .accounts({ config: configPda, signer: admin, guardianAccount: gPda(G2) })
      .rpc();
    const g2b: any = await gAcct.fetch(gPda(G2));
    ok(
      "the admin can still cancel after the self-veto is spent",
      g2b.pendingRemovalAt.toString() === "0",
    );
    ok(
      "the spent self-veto is NOT restored by an admin cancel",
      g2b.selfCancelUsed === true,
    );
  }

  // --- 9. add_guardian refuses the INCOMING admin, not just the current one.
  // Without this, the "admin may not be a guardian" barrier is sidestepped by
  // appointing K as guardian while A is admin and then completing a transfer of
  // admin-ship to K. The test CREATES the condition (a real pending transfer) rather
  // than skipping when none happens to exist, then cancels it to restore the config.
  {
    const incoming = testGuardian("incoming-admin").publicKey;
    await program.methods
      .proposeAdminTransfer(incoming)
      .accounts({ config: configPda, admin })
      .rpc();
    const withPending: any = await cfgAcct.fetch(configPda);
    ok(
      "a pending admin transfer is staged for the test",
      withPending.pendingAdmin?.toBase58() === incoming.toBase58(),
      incoming.toBase58(),
    );
    await expectRevert(
      "add_guardian refuses the PENDING admin",
      "Unauthorized",
      () =>
        program.methods
          .addGuardian(incoming)
          .accounts({
            config: configPda,
            admin,
            payer: admin,
            guardianAccount: gPda(incoming),
          })
          .rpc(),
    );
    await program.methods
      .cancelAdminTransfer()
      .accounts({ config: configPda, signer: admin, guardian: null })
      .rpc();
    const restored: any = await cfgAcct.fetch(configPda);
    ok(
      "the pending admin transfer is cancelled again",
      restored.pendingAdmin === null,
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
