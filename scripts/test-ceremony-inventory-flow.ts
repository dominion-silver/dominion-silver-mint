/**
 * ROUND 8 T8-06, the ceremony half. Offline test of `scripts/ceremony-step8.ts`.
 *
 * WHAT IT PROVES, and why each part is not optional:
 *
 *  1. Step 8 no longer BINDS the inventory wallet. `initialize` does, atomically, and
 *     `set_inventory_wallet` is deleted from the program. So the ceremony must emit no instruction
 *     carrying that discriminator, and this checks the emitted BYTES rather than the source text:
 *     an `rg` for the name would pass against a builder that computed it.
 *  2. Step 8 REFUSES when the chain's bound destination is not the one the manifest names. That is
 *     the case option A creates and did not previously exist: with an instant setter the ceremony
 *     could simply overwrite a wrong value, and now it cannot, so the ceremony has to stop instead
 *     of unpausing over it.
 *  3. The unpause it emits carries the guardian account the round-8 handler demands, and that
 *     guardian is one of the ones the same step registers. An unpause built without it fails on
 *     chain with AccountNotEnoughKeys, mid-ceremony, after the guardians are already appointed.
 *
 * It drives `buildStep8Actions`, the real builder the script itself calls. Importing the module runs
 * no ceremony: the entrypoint there is behind a `require.main` guard for exactly this reason.
 *
 *   npx tsx scripts/test-ceremony-inventory-flow.ts
 */
import { createHash } from "crypto";
import { decideStateDisposition, classifyResume, planExecuteResume } from "./_run-state";
import { readinessDigest as readinessDigestForTest } from "./_readiness-digest";
import { assertContext as assertContextForTest } from "./e2e-inventory-change-devnet";
import { collectLaunchState } from "./ceremony-step8";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import idl from "../target/idl/dominion_silver_mint.json";
import { PROGRAM_ID } from "./_program-id";
import type { LaunchState } from "./_launch-readiness";
import * as step8 from "./ceremony-step8";
import {
  buildStep8Actions,
  guardianPda,
  InventoryWalletMismatch,
  type Step8Input,
} from "./ceremony-step8";

/* eslint-disable @typescript-eslint/no-explicit-any */

let failures = 0;
function ok(label: string): void {
  console.log(`ok: ${label}`);
}
function fail(label: string): void {
  console.log(`FAIL: ${label}`);
  failures += 1;
}
function check(condition: boolean, okLabel: string, failLabel: string): void {
  if (condition) ok(okLabel);
  else fail(failLabel);
}

/** Anchor's global instruction discriminator, computed the same way the program does. */
function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function program(): anchor.Program {
  // No RPC call is made: every builder below stops at `.instruction()`.
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  const kp = Keypair.generate();
  const provider = new anchor.AnchorProvider(
    conn,
    {
      publicKey: kp.publicKey,
      signTransaction: async (t: unknown) => t,
      signAllTransactions: async (t: unknown) => t,
    } as any,
    { commitment: "confirmed" },
  );
  return new anchor.Program(idl as anchor.Idl, provider);
}

const CONFIG_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PROGRAM_ID,
)[0];

const ADMIN = PublicKey.unique();
const GUARDIAN_A = PublicKey.unique();
const GUARDIAN_B = PublicKey.unique();
const INVENTORY = PublicKey.unique();

function input(over: Partial<Step8Input> = {}): Step8Input {
  return {
    program: program(),
    configPda: CONFIG_PDA,
    admin: ADMIN,
    guardians: [GUARDIAN_A.toBase58(), GUARDIAN_B.toBase58()],
    guardianExists: () => false,
    paused: true,
    readinessDigest: new Array(32).fill(7),
    boundInventoryWallet: INVENTORY,
    expectedInventoryWallet: INVENTORY,
    feeVaultExists: true,
    // ROUND 8 F-01. This fixture omitted `readiness` and expected the builder to SUCCEED, which made
    // it a green sentinel of the very bypass Codex found: the field was optional, the real `main()`
    // never filled it, and this test agreed. It is mandatory now, and the cases below drive the
    // builder through each missing precondition.
    readiness: readyState(),
    ...over,
  };
}

/** A go-live state in which every precondition holds. Cases break exactly one thing in it. */
function readyState(): LaunchState {
  return {
    paused: true,
    publicMintEnabled: true,
    redemptionsEnabled: true,
    boundInventoryWallet: INVENTORY,
    expectedInventoryWallet: INVENTORY,
    feeVaultExists: true,
    circulatingSilv: 0n,
    activeIndependentGuardians: 1,
    minPublishers: 2,
    requiredMinPublishers: 2,
    feedId: 3154,
    expectedFeedId: 3154,
  };
}

async function main(): Promise<void> {
  // THE RED PHASE HAS TO BE LEGIBLE. Against a tree where step 8 still binds the wallet there is no
  // pure builder to import, and a bare module-resolution crash names no requirement. Checking the
  // capability first turns that into the one line Codex's criterion asks for, and it costs nothing
  // once the capability exists.
  if (typeof (step8 as Record<string, unknown>).buildStep8Actions !== "function") {
    fail("ceremony-step8 still builds setInventoryWallet");
    console.log(
      "  scripts/ceremony-step8.ts exports no pure buildStep8Actions, so the step is still the " +
        "inline sequence that includes the instant inventory setter.",
    );
    console.log("\nCEREMONY INVENTORY FLOW FAILED: 1 check(s)");
    process.exit(1);
  }

  const actions = await buildStep8Actions(input());

  // ---- 1. no instant setter is emitted, decided on the bytes
  const removed = disc("set_inventory_wallet");
  const emitsRemoved = actions.some((a) =>
    Buffer.from(a.ix.data.subarray(0, 8)).equals(removed),
  );
  check(
    !emitsRemoved,
    "ceremony-step8 emits no set_inventory_wallet discriminator",
    "ceremony-step8 still builds setInventoryWallet",
  );
  // Same statement from the other side: no action mentions binding the wallet at all.
  check(
    !actions.some((a) => /set_inventory_wallet|setInventoryWallet/.test(a.label)),
    "no step 8 action claims to set the inventory wallet",
    "a step 8 action is still labelled as an inventory-wallet setter",
  );

  // ---- 2. every emitted instruction is one the program still dispatches
  // ROUND 8 REVIEW P0. THE ORDER THIS ONCE ASSERTED WAS THE BUG.
  //
  // It required ["add_guardian", "add_guardian", "unpause"] in ONE batch. `add_guardian` increments
  // config.guardian_count, guardian_count is inside the readiness digest, and the digest is taken
  // BEFORE the batch. So the asserted sequence guarantees the unpause reverts with
  // StaleReadinessDigest, after the registrations have landed, on the one instruction that takes the
  // protocol live. A blocking CI gate was encoding the broken ordering as the spec.
  //
  // The batch now stops before the unpause whenever a registration is pending, and the operator
  // re-runs step 8 against a re-read config. Both shapes are asserted below, because "stops early"
  // and "still emits the unpause once nothing is pending" are two different properties.
  const expected = ["add_guardian", "add_guardian"];
  const names = actions.map((a) => {
    const d = Buffer.from(a.ix.data.subarray(0, 8));
    return (
      (idl as any).instructions.find((i: any) =>
        Buffer.from(i.discriminator).equals(d),
      )?.name ?? "UNKNOWN"
    );
  });
  check(
    names.join(",") === expected.join(","),
    `step 8 emits exactly ${expected.join(" -> ")}`,
    `step 8 emits ${names.join(" -> ")}, expected ${expected.join(" -> ")}`,
  );

  // ---- 3. ROUND 8 REVIEW P0. TWO shapes, because "stops early" and "still emits the unpause once
  // nothing is pending" are different properties and asserting only one hides the other.
  //
  // When a registration is pending, the unpause MUST NOT be in the batch: add_guardian moves
  // config.guardian_count, guardian_count is inside the readiness digest, and the digest was taken
  // before the batch. Emitting both guarantees StaleReadinessDigest after the registrations landed.
  check(
    !names.includes("unpause"),
    "a batch with pending guardian registrations stops BEFORE the unpause",
    "the unpause is emitted in the same batch as an add_guardian, so it will revert StaleReadinessDigest",
  );

  // And once every guardian is registered, the unpause IS emitted and presents a registered PDA.
  const settled = await buildStep8Actions(input({ guardianExists: () => true }));
  const settledNames = settled.map((a) => {
    const d = Buffer.from(a.ix.data.subarray(0, 8));
    return (
      (idl as any).instructions.find((x: any) =>
        Buffer.from(x.discriminator).equals(d),
      )?.name ?? "UNKNOWN"
    );
  });
  check(
    settledNames[settledNames.length - 1] === "unpause",
    "with every guardian already registered, the batch does emit the unpause",
    "the builder never emits an unpause, so the ceremony can never go live",
  );
  const settledUnpause = settled[settled.length - 1];
  const gslot = settledUnpause.ix.keys.findIndex((k2: any) =>
    k2.pubkey.equals(guardianPda(GUARDIAN_A)),
  );
  check(
    gslot >= 0,
    "the emitted unpause presents the PDA of a registered guardian",
    "unpause does not present a registered guardian, so it will fail on chain",
  );

  // ---- 4. the refusal, which is what replaced the setter
  let refused: unknown = null;
  try {
    await buildStep8Actions(
      input({ boundInventoryWallet: PublicKey.unique() }),
    );
  } catch (e) {
    refused = e;
  }
  check(
    refused instanceof InventoryWalletMismatch,
    "step 8 REFUSES a chain whose inventory wallet is not the manifest's",
    "step 8 continued past an inventory wallet the ceremony did not choose",
  );
  // And it refuses BEFORE emitting anything, or an operator could sign the guardians and the unpause
  // from a run that also reported an error.
  check(
    refused instanceof Error &&
      /REFUSING step 8/.test((refused as Error).message),
    "the refusal names the step it aborted and the repair path",
    "the refusal message does not say what was aborted",
  );

  // ---- 5. the ordering hazard the posture change opened
  let vaultRefused: unknown = null;
  try {
    await buildStep8Actions(input({ feeVaultExists: false }));
  } catch (e) {
    vaultRefused = e;
  }
  check(
    vaultRefused instanceof Error && vaultRefused.name === "FeeVaultMissing",
    "step 8 REFUSES to unpause before the premium fee vault exists",
    "step 8 would unpause with no fee vault, so every mint and redeem would revert on go-live",
  );
  // A ceremony being RESUMED is already live, so the vault question is settled and re-asking it
  // would block a re-run that emits nothing new.
  // ROUND 8 REVIEW P0. `guardianExists: () => true` is now part of the fixture, because with a
  // registration pending the batch stops before the unpause and the last action is an add_guardian,
  // so this check would be reading the wrong action.
  const resumed = await buildStep8Actions(
    input({ paused: false, feeVaultExists: false, guardianExists: () => true }),
  );
  check(
    resumed[resumed.length - 1].alreadyDone === true,
    "an already-unpaused protocol is not blocked by the fee-vault precondition",
    "a resumed ceremony is blocked by a precondition that no longer applies",
  );

  // ---- 6. F-01. THE BUILDER ITSELF refuses every missing precondition.
  //
  // Not decideLaunchReadiness in isolation: that function was already tested and green while the real
  // ceremony never called it. These drive buildStep8Actions, the thing main() calls, so a future
  // change that makes readiness optional again fails here.
  for (const [label, mutate] of [
    ["SILV already in circulation", (r: LaunchState) => { r.circulatingSilv = 1n; }],
    ["no active independent guardian", (r: LaunchState) => { r.activeIndependentGuardians = 0; }],
    ["a publisher floor below the requirement", (r: LaunchState) => { r.minPublishers = 1; }],
    ["a feed the manifest does not name", (r: LaunchState) => { r.feedId = 3304; }],
  ] as [string, (r: LaunchState) => void][]) {
    const r = readyState();
    mutate(r);
    let threw = false;
    try {
      await buildStep8Actions(input({ readiness: r }));
    } catch {
      threw = true;
    }
    check(
      threw,
      `step 8 REFUSES to go live with ${label}`,
      `step 8 emitted the unpause with ${label}`,
    );
  }

  // ============================================================ ROUND 8 FINAL-04
  //
  // These fixtures CALL the production collector. The previous version read `ceremony-step8.ts` as
  // text and matched three regexes against it, while claiming to exercise the module. That is the
  // over-claiming label that reopened T8-02 and T8-04, and it hid a real defect: `requireField`
  // refused only null/undefined/"", so "not-a-number" became NaN and every comparison against NaN is
  // false, which made the publisher-floor blocker vanish.
  {
    const okConf = {
      getTokenSupply: async () => ({ value: { amount: "0" } }),
      getAccountInfo: async () => null,
    } as any;
    const c0 = {
      paused: true,
      publicMintEnabled: true,
      redemptionsEnabled: true,
      inventoryWallet: PublicKey.default,
      admin: PublicKey.default,
      silvMint: PublicKey.default,
      minPublishers: 2,
      pythLazerFeedId: 3154,
    };
    const GUARDS: string[] = [];
    const WALLET = PublicKey.default.toBase58();
    const good = { launch_posture: { min_publishers: 2, pyth_lazer_feed_id: 3154 } };

    const call = async (manifest: any, conn: any = okConf) =>
      collectLaunchState(conn, c0, GUARDS, WALLET, true, manifest);

    // The positive control FIRST, so every refusal below means something.
    let baseline = "";
    try {
      await call(good);
    } catch (e) {
      baseline = String(e);
    }
    check(
      baseline === "",
      "a well-formed manifest is accepted by the real collector",
      `the collector refused a valid manifest: ${baseline.slice(0, 140)}`,
    );

    // Every way min_publishers can be wrong. Each must REACH the collector and make it throw.
    const BAD: Array<[string, any]> = [
      ["absent", {}],
      ["empty string", { min_publishers: "" }],
      ["non-numeric string", { min_publishers: "not-a-number" }],
      ["NaN literal", { min_publishers: NaN }],
      ["fraction", { min_publishers: 1.5 }],
      ["negative", { min_publishers: -1 }],
      ["zero, below the floor", { min_publishers: 0 }],
      ["out of range", { min_publishers: 99999 }],
    ];
    for (const [label, patch] of BAD) {
      let threw = "";
      try {
        await call({ launch_posture: { pyth_lazer_feed_id: 3154, ...patch } });
      } catch (e) {
        threw = String(e);
      }
      check(
        threw.includes("min_publishers"),
        `the collector refuses min_publishers: ${label}`,
        `min_publishers ${label} reached the readiness decision (threw: ${threw.slice(0, 90) || "nothing"})`,
      );
    }

    // The same guarantee on the other field the decision reads.
    for (const [label, patch] of [
      ["absent", {}],
      ["non-numeric string", { pyth_lazer_feed_id: "feed" }],
      ["negative", { pyth_lazer_feed_id: -1 }],
    ] as Array<[string, any]>) {
      let threw = "";
      try {
        await call({ launch_posture: { min_publishers: 2, ...patch } });
      } catch (e) {
        threw = String(e);
      }
      check(
        threw.includes("pyth_lazer_feed_id"),
        `the collector refuses pyth_lazer_feed_id: ${label}`,
        `pyth_lazer_feed_id ${label} reached the readiness decision`,
      );
    }

    // An RPC error must ABORT, not become a zero supply. Driven through the real collector with a
    // rejecting connection, not by calling the fake and asserting the fake rejected.
    let supplyThrew = "";
    try {
      await call(good, {
        getTokenSupply: async () => {
          throw new Error("RPC unavailable");
        },
        getAccountInfo: async () => null,
      });
    } catch (e) {
      supplyThrew = String(e);
    }
    check(
      supplyThrew.includes("could not read the SILV supply"),
      "an unreadable SILV supply aborts the collector before any builder is reached",
      `an RPC failure did not abort the collector (threw: ${supplyThrew.slice(0, 90) || "nothing"})`,
    );
  }

  // ============================================================ ROUND 8 A-06
  //
  // The two fixtures Codex asked for: a wrong read-back of B, and a slot that was not released.
  // Both must exit non-zero WITH the run record still on disk. They drive the same pure decision the
  // devnet runner calls, so a regression in the runner's teardown is caught here without a cluster.
  {
    const STATE = "/tmp/dominion-inventory-change.json";
    const HINT = "resume with: npx tsx scripts/e2e-inventory-change-devnet.ts --execute";

    // Fixture 1: the executed change read back as A instead of B. One soft failure recorded.
    const wrongReadback = decideStateDisposition(1, STATE, HINT);
    check(
      !wrongReadback.remove,
      "a wrong read-back of B keeps the run record",
      "the run record was deleted after the read-back returned the wrong wallet",
    );
    check(
      !wrongReadback.lines.some((l) => l.includes("DONE.") && !l.includes("NOT DONE")),
      "a wrong read-back never prints DONE",
      `it printed: ${JSON.stringify(wrongReadback.lines)}`,
    );
    check(
      wrongReadback.lines.some((l) => l.includes(STATE)) &&
        wrongReadback.lines.some((l) => l.includes(HINT)),
      "the red path names the kept file and the exact resume command",
      "the operator is told it failed but not how to resume",
    );

    // Fixture 2: the slot was not released. Two soft failures, same rule.
    const slotHeld = decideStateDisposition(2, STATE, HINT);
    check(
      !slotHeld.remove,
      "a slot that was not released keeps the run record",
      "the run record was deleted while the timelock slot was still armed",
    );

    // The negative control. Without it, `remove: false` always would score four passes.
    const clean = decideStateDisposition(0, STATE, HINT);
    check(
      clean.remove && clean.lines.join(" ").includes("DONE."),
      "a fully green run still clears its record and reports DONE",
      "a green run kept a stale record, which would make the NEXT run compare against a finished one",
    );
  }

  // ============================================================ ROUND 8 FINAL-05
  //
  // The three states a resumed run can actually be in. The middle one is the finding: a landed
  // transaction with a stale first read-back left a record that `assertResumable` would refuse
  // forever, so the printed "resume with --execute" was a promise the runner could not keep.
  {
    const st = { from: "AAA", to: "BBB", nonce: 7 };
    check(
      classifyResume(st, { inventoryWallet: "AAA", pendingNonce: 7 }).kind === "execute",
      "A with the exact proposal armed resumes with --execute",
      "a still-queued change was not recognised as resumable",
    );
    check(
      classifyResume(st, { inventoryWallet: "BBB", pendingNonce: null }).kind === "already-landed",
      "B with the slot released is recognised as already landed, so the record can be closed",
      "a landed change still reports as resumable, which is the state that could never finalise",
    );
    for (const [label, oc] of [
      ["B but the slot is still armed", { inventoryWallet: "BBB", pendingNonce: 7 }],
      ["A but a different nonce is armed", { inventoryWallet: "AAA", pendingNonce: 9 }],
      ["a third wallet entirely", { inventoryWallet: "CCC", pendingNonce: null }],
    ] as Array<[string, any]>) {
      check(
        classifyResume(st, oc).kind === "investigate",
        `${label} keeps the record and asks for investigation`,
        `${label} was classified as safe to resume`,
      );
    }
  }

  // The branch that CONSUMES the verdict, which the previous version left untested because it lives
  // in a script needing a cluster. That is exactly why the original A-06 defect survived, so the
  // decision was pulled out instead of trusted.
  {
    const st = { from: "AAA", to: "BBB", nonce: 7 };
    const plans = {
      queued: planExecuteResume(st, { inventoryWallet: "AAA", pendingNonce: 7 }),
      landed: planExecuteResume(st, { inventoryWallet: "BBB", pendingNonce: null }),
      weird: planExecuteResume(st, { inventoryWallet: "CCC", pendingNonce: null }),
    };
    check(
      plans.queued.action === "execute" && plans.queued.clearState === false,
      "a still-queued change proceeds to the send and keeps its record",
      "the runner would have skipped or cleared a change that never executed",
    );
    check(
      plans.landed.action === "finish" &&
        plans.landed.clearState === true &&
        plans.landed.exitCode === 0,
      "an already-landed change closes clean and clears its record",
      "the runner would have re-sent an execute against a released slot",
    );
    check(
      plans.weird.action === "abort" &&
        plans.weird.clearState === false &&
        plans.weird.exitCode === 1,
      "an unrecognised state aborts before the send and KEEPS the record",
      "the runner would have sent, or destroyed the evidence, on a state nobody predicted",
    );
    // The invariant that matters more than the three rows: nothing but a completed run may delete
    // the record. Stated once, so a fourth outcome added later cannot quietly opt out of it.
    check(
      Object.values(plans).every((p) => !p.clearState || p.action === "finish"),
      "no outcome except a completed run is allowed to delete the run record",
      "an incomplete outcome clears the state file, which is the A-06 defect returning",
    );
  }

  // ROUND 8 PASSA-03. The context checks must run on EVERY branch, including already-landed. The
  // previous fixture called only the pure classifier, so it could not see that the landed branch
  // returned before cluster/program/admin were ever established: a record copied from another
  // cluster whose `to` happened to match would have been "recognised", deleted and exited 0.
  //
  // Read from the production source is NOT how this is checked. The source is executed: assertContext
  // is exported and driven with hostile records.
  {
    const good = {
      cluster: "devnet", rpc: "https://api.devnet.solana.com",
      program: "3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ",
      admin: "11111111111111111111111111111111",
      from: "11111111111111111111111111111111", to: "11111111111111111111111111111111",
      nonce: 3, proposedAt: 100, executableAt: 100 + 86400,
    };
    const BAD: Array<[string, any]> = [
      ["a record from another cluster", { cluster: "mainnet-beta" }],
      ["a record from another program", { program: "11111111111111111111111111111111" }],
      ["a record naming another admin", { admin: "So11111111111111111111111111111111111111112" }],
      ["a target B that is not a pubkey", { to: "not-a-pubkey" }],
      ["a chronology that runs backwards", { executableAt: 50 }],
    ];
    let ctxFails = 0;
    for (const [label, patch] of BAD) {
      let threw = "";
      try {
        assertContextForTest({ ...good, ...patch } as any, PublicKey.default);
      } catch (e) {
        threw = String(e);
      }
      if (threw.includes("does not describe this world")) ctxFails++;
      check(
        threw.includes("does not describe this world"),
        `the context check refuses ${label}, on every branch`,
        `${label} would have been accepted, then classified, then possibly deleted`,
      );
    }
    check(ctxFails === BAD.length, "all five hostile records were refused", "a hostile record passed");
  }

  // ROUND 8 REVIEW P0. THE FROZEN VECTOR OVER THE COPY THE CEREMONY USES.
  //
  // The vitest suite pins apps/admin/src/lib/readiness-digest.ts. The ceremony imports
  // scripts/_readiness-digest.ts. Editing the scripts copy alone turned zero tests red while the
  // mainnet ceremony would have built the wrong digest. Same constant, both copies, both asserted.
  {
    const d = readinessDigestForTest({
      admin: new PublicKey(new Uint8Array(32).fill(1)),
      silvMint: new PublicKey(new Uint8Array(32).fill(2)),
      inventoryWallet: new PublicKey(new Uint8Array(32).fill(3)),
      publicMintEnabled: true,
      redemptionsEnabled: true,
      guardianCount: 2,
      minPublishers: 3,
      pythLazerFeedId: 3154,
    });
    check(
      d.toString("hex") === "911edf183b2728a122607a9e70341dfc58a49c1f3391ef8f846429e6b945e33a",
      "the ceremony's digest encoder matches the frozen cross-language vector",
      `the ceremony's encoder produced ${d.toString("hex")}, so the unpause it builds would be rejected`,
    );
  }

  if (failures > 0) {
    console.log(`\nCEREMONY INVENTORY FLOW FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log(
    "\nCEREMONY INVENTORY FLOW OK: initialize owns the first binding; recovery uses propose/execute",
  );
}

main().catch((e) => {
  console.error("test-ceremony-inventory-flow crashed:", e);
  process.exit(1);
});
