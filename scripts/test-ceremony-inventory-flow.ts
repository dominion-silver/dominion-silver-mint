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
import { decideStateDisposition, classifyResume } from "./_run-state";
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
  const expected = ["add_guardian", "add_guardian", "unpause"];
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

  // ---- 3. the unpause carries the guardian the round-8 handler demands
  const unpause = actions[actions.length - 1];
  const unpauseAccounts = (idl as any).instructions.find(
    (i: any) => i.name === "unpause",
  ).accounts;
  const slot = unpauseAccounts.findIndex((a: any) => a.name === "guardian");
  check(
    slot >= 0 &&
      unpause.ix.keys.length === unpauseAccounts.length &&
      unpause.ix.keys[slot].pubkey.equals(guardianPda(GUARDIAN_A)),
    "unpause presents the PDA of a guardian this same step registers",
    "unpause does not present a registered guardian, so it will fail on chain mid-ceremony",
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
  const resumed = await buildStep8Actions(
    input({ paused: false, feeVaultExists: false }),
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
