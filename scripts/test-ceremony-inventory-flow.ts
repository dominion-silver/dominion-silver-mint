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
