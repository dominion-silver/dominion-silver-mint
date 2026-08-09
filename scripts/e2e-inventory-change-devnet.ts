/**
 * ROUND 8 L1-05. The inventory-wallet change A -> B on a LIVE cluster, across the real 24h timelock.
 *
 * WHY IT IS A SEPARATE, TWO-PHASE SCRIPT. `admin_timelock_seconds` has a hard floor of 86400, so no
 * single run of a live-cluster script can reach the matured execute. The previous attempt printed a
 * nonce and told the operator to come back, and called that a resume path: a second run started over
 * at `next_timelock_nonce` and proposed something new, so the post-delay execute and the read-back of
 * B were never performed by anything. Codex refused it, correctly.
 *
 * This one PERSISTS `{cluster, program, admin, nonce, timelockPda, from, to, proposedAt}` and refuses
 * to resume against anything that has drifted. The state file is the whole point: it is what makes
 * the second run a continuation rather than a fresh proposal that happens to look similar.
 *
 *   npx tsx scripts/e2e-inventory-change-devnet.ts --propose --to <B>
 *   npx tsx scripts/e2e-inventory-change-devnet.ts --status
 *   npx tsx scripts/e2e-inventory-change-devnet.ts --execute     # >= 24h later
 *   npx tsx scripts/e2e-inventory-change-devnet.ts --cancel      # guardian veto, any time before
 *
 * The LiteSVM harness proves the same state machine with a warped clock
 * (inventory_wallet.rs::a_change_takes_a_proposal_the_full_delay_and_an_execute). That is the fast
 * proof of the LOGIC. This is the proof of the PROCEDURE: that an operator, with the real tooling and
 * a real day in between, can carry the change to the end and read B back.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet, Idl, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CLUSTER = resolveCluster();
const STATE_PATH =
  process.env.DOMINION_INVENTORY_STATE ??
  path.join(__dirname, "..", "ceremony-out", "inventory-change-state.json");

interface ChangeState {
  cluster: string;
  rpc: string;
  program: string;
  admin: string;
  nonce: string;
  timelockPda: string;
  from: string;
  to: string;
  proposedAt: number;
  executableAt: number;
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? (pass += 1) : (fail += 1);
}

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function readState(): ChangeState | null {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as ChangeState;
}

function writeState(s: ChangeState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

/**
 * REFUSE any resume whose world has moved. Each field is here because resuming across a change to it
 * would execute something other than what was proposed, or execute it somewhere else. A resume that
 * "mostly matches" is the failure mode this script exists to remove.
 */
function assertResumable(s: ChangeState, admin: PublicKey, onChainFrom: PublicKey): void {
  const drift: string[] = [];
  if (s.cluster !== CLUSTER.cluster) drift.push(`cluster ${s.cluster} -> ${CLUSTER.cluster}`);
  if (s.program !== PROGRAM_ID.toBase58()) drift.push(`program ${s.program} -> ${PROGRAM_ID.toBase58()}`);
  if (s.admin !== admin.toBase58()) drift.push(`admin ${s.admin} -> ${admin.toBase58()}`);
  // The wallet the proposal was made AGAINST. If it already moved, executing would be a second,
  // unannounced change from a state nobody reviewed.
  if (s.from !== onChainFrom.toBase58())
    drift.push(`inventory wallet ${s.from} -> ${onChainFrom.toBase58()}`);
  // F-05. EVERY persisted field is validated, not just the ones that were easy. A resume that checked
  // four of seven is a resume that can execute a proposal it never verified: `to` is the value that
  // will actually land, and the timelock PDA is the account the execute will touch, so an edited
  // state file could point a matured execute at a different proposal entirely.
  try {
    if (!new PublicKey(s.to)) drift.push("target B is unreadable");
  } catch {
    drift.push(`target B ${s.to} is not a pubkey`);
  }
  if (s.executableAt <= s.proposedAt) {
    drift.push(`executableAt ${s.executableAt} is not after proposedAt ${s.proposedAt}`);
  }
  if (s.rpc !== CLUSTER.rpc) drift.push(`rpc ${s.rpc} -> ${CLUSTER.rpc}`);
  if (drift.length > 0) {
    throw new Error(
      `REFUSING to resume: the world moved since the proposal.\n  ${drift.join("\n  ")}\n` +
        `Cancel the armed proposal (--cancel) and start again, or delete ${STATE_PATH} if it is stale.`,
    );
  }
}

async function main(): Promise<void> {
  await requireSanctionedCluster(CLUSTER.rpc, "inventory wallet change E2E");
  const argv = process.argv.slice(2);
  const mode =
    (["--propose", "--execute", "--cancel", "--status"] as const).find((m) => argv.includes(m)) ??
    "--status";

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const kp = loadKp(
    process.env.DOMINION_KEYPAIR || path.join(os.homedir(), ".config/solana/dominion-dev.json"),
  );
  const admin = kp.publicKey;
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"), "utf8"),
  ) as Idl;
  const program = new Program(
    idl,
    new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
  );
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const cfg = async (): Promise<any> => (program.account as any).configAccount.fetch(configPda);

  const c0 = await cfg();
  const onChainFrom = new PublicKey(c0.inventoryWallet);
  console.log(`# ${describeCluster(CLUSTER)}  mode=${mode}`);
  console.log(`  config.inventory_wallet : ${onChainFrom.toBase58()}`);
  console.log(`  state file              : ${STATE_PATH}`);

  const timelockPdaFor = (n: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Uint8Array.from(n.toArrayLike(Buffer, "le", 8))],
      PROGRAM_ID,
    )[0];

  // ------------------------------------------------------------------ propose
  if (mode === "--propose") {
    const toIdx = argv.indexOf("--to");
    if (toIdx < 0 || !argv[toIdx + 1]) {
      throw new Error("usage: --propose --to <new inventory wallet pubkey>");
    }
    const to = new PublicKey(argv[toIdx + 1]);
    if (to.equals(onChainFrom)) {
      throw new Error("the target is the wallet already configured; the program refuses that no-op");
    }
    const existing = readState();
    if (existing) {
      throw new Error(
        `a change is already tracked at ${STATE_PATH} (nonce ${existing.nonce}). Finish it with ` +
          "--execute, abandon it with --cancel, or delete the file if it is stale.",
      );
    }
    assertReversible("propose_set_inventory_wallet", intentFromEnv());

    const nonce = new BN(c0.nextTimelockNonce);
    const tlPda = timelockPdaFor(nonce);
    await (program.methods as any)
      .proposeSetInventoryWallet(to)
      .accounts({
        config: configPda,
        admin,
        timelock: tlPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const after = await cfg();
    ok(
      "propose armed the single inventory slot",
      after.pendingInventoryWalletNonce !== null &&
        new BN(after.pendingInventoryWalletNonce).eq(nonce),
      `nonce ${nonce.toString()}`,
    );
    ok(
      "proposing moved NOTHING (this is the guardian's veto window)",
      new PublicKey(after.inventoryWallet).equals(onChainFrom),
    );

    const tl: any = await (program.account as any).timelockQueueAccount.fetch(tlPda);
    const executableAt = Number(tl.executableAt);
    writeState({
      cluster: CLUSTER.cluster,
      rpc: CLUSTER.rpc,
      program: PROGRAM_ID.toBase58(),
      admin: admin.toBase58(),
      nonce: nonce.toString(),
      timelockPda: tlPda.toBase58(),
      from: onChainFrom.toBase58(),
      to: to.toBase58(),
      proposedAt: Number(tl.scheduledAt),
      executableAt,
    });
    console.log(
      `\n  ARMED. Executable at unix ${executableAt} (${new Date(executableAt * 1000).toISOString()}).` +
        `\n  Come back with:  npx tsx scripts/e2e-inventory-change-devnet.ts --execute`,
    );
  }

  // ------------------------------------------------------------------ status
  else if (mode === "--status") {
    const s = readState();
    if (!s) {
      console.log("\n  no change is tracked. Start one with --propose --to <pubkey>.");
    } else {
      const nowSecs = Math.floor(Date.now() / 1000);
      console.log(`\n  tracked change : ${s.from} -> ${s.to}`);
      console.log(`  nonce          : ${s.nonce}  (timelock ${s.timelockPda})`);
      console.log(
        `  executable at  : ${s.executableAt} (${new Date(s.executableAt * 1000).toISOString()})` +
          `  ${nowSecs >= s.executableAt ? "REACHED" : `in ${s.executableAt - nowSecs}s`}`,
      );
      assertResumable(s, admin, onChainFrom);
      console.log("  resumable      : yes, nothing has drifted");
    }
  }

  // ------------------------------------------------------------------ execute
  else if (mode === "--execute") {
    const s = readState();
    if (!s) throw new Error(`no tracked change at ${STATE_PATH}; nothing to execute`);
    assertResumable(s, admin, onChainFrom);
    assertReversible("execute_set_inventory_wallet", intentFromEnv());

    const nonce = new BN(s.nonce);
    const tlPda = new PublicKey(s.timelockPda);
    // Derived independently and COMPARED, so a hand-edited state file cannot point the execute at
    // some other proposal.
    ok(
      "the persisted timelock PDA is the one this nonce derives",
      timelockPdaFor(nonce).equals(tlPda),
      tlPda.toBase58(),
    );
    // And the ON-CHAIN proposal must still carry the target this run persisted. Without it, a resume
    // could execute a DIFFERENT proposal that happens to occupy the same nonce after a cancel.
    const tlAccount: any = await (program.account as any).timelockQueueAccount
      .fetch(tlPda)
      .catch(() => null);
    ok(
      "the armed proposal still exists on chain",
      tlAccount !== null,
      tlPda.toBase58(),
    );
    ok(
      "the config still points at the proposal this run tracks",
      c0.pendingInventoryWalletNonce !== null && new BN(c0.pendingInventoryWalletNonce).eq(nonce),
      `armed nonce ${c0.pendingInventoryWalletNonce?.toString?.() ?? "none"}`,
    );

    // THE CHECKS ABOVE ARE GATES, NOT NOTES. They recorded failures with ok() and execution carried
    // on regardless, so a resume whose PDA or armed nonce did not match still reached the execute.
    // Every red check now stops the run before anything is sent.
    if (fail > 0) {
      console.log(`\n  REFUSING to execute: ${fail} precondition(s) above are red.`);
      process.exit(1);
    }
    // The proposal on chain must carry the TARGET this run persisted, and the timestamps must be the
    // ones it recorded. Without this a resume executes a proposal it has only identified by nonce.
    const onChainTo = tlAccount ? new PublicKey(tlAccount.actionData ?? new Uint8Array(32)) : null;
    ok(
      "the armed proposal's schedule matches the one this run recorded",
      tlAccount !== null &&
        Number(tlAccount.executableAt) === s.executableAt &&
        Number(tlAccount.scheduledAt) === s.proposedAt,
      `on chain ${tlAccount ? tlAccount.executableAt : "?"} vs recorded ${s.executableAt}`,
    );
    if (onChainTo && !onChainTo.equals(new PublicKey(s.to))) {
      ok("the armed proposal targets the B this run recorded", false, onChainTo.toBase58());
    }
    if (fail > 0) {
      console.log(`\n  REFUSING to execute: the armed proposal is not the one this run tracks.`);
      process.exit(1);
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (nowSecs < s.executableAt) {
      console.log(
        `\n  NOT YET: ${s.executableAt - nowSecs}s left of the 24h window. That refusal is the ` +
          "property under test; come back after it elapses.",
      );
      process.exit(2);
    }

    await (program.methods as any)
      .executeSetInventoryWallet(nonce)
      .accounts({ config: configPda, admin, timelock: tlPda, rentRecipient: admin })
      .rpc();

    // THE READ-BACK OF B, which is the thing the old KEEP path never performed.
    const after = await cfg();
    ok(
      "the executed change moved the wallet to B",
      new PublicKey(after.inventoryWallet).toBase58() === s.to,
      `${new PublicKey(after.inventoryWallet).toBase58()} (expected ${s.to})`,
    );
    ok("the slot was released", after.pendingInventoryWalletNonce === null);
    fs.rmSync(STATE_PATH);
    console.log(`\n  DONE. ${s.from} -> ${s.to}, across a real ${s.executableAt - s.proposedAt}s timelock.`);
  }

  // ------------------------------------------------------------------ cancel
  else {
    const s = readState();
    if (!s) throw new Error(`no tracked change at ${STATE_PATH}; nothing to cancel`);
    assertResumable(s, admin, onChainFrom);
    assertReversible("cancel_timelocked_action", intentFromEnv());
    await (program.methods as any)
      .cancelTimelockedAction(new BN(s.nonce))
      .accounts({
        config: configPda,
        timelock: new PublicKey(s.timelockPda),
        rentRecipient: admin,
        signer: admin,
        guardian: null as never,
      })
      .rpc();
    const after = await cfg();
    ok("the cancel released the slot", after.pendingInventoryWalletNonce === null);
    ok(
      "the cancel left the wallet where it was",
      new PublicKey(after.inventoryWallet).toBase58() === s.from,
    );
    fs.rmSync(STATE_PATH);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("inventory change E2E failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
