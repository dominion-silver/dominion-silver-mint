/**
 * ROUND 5 P0-03, decision D3 (owner, 2026-08-08): the ceremony scripts become Squads TRANSACTION
 * BUILDERS instead of senders, and the admin panel moves ahead of the steps that need it.
 *
 * WHY. `config.admin` on mainnet is the Ops Squads vault `65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS`,
 * which is OFF-CURVE. No private key exists for it, so `has_one = admin` can never be satisfied by a
 * `Keypair`. Both ceremony scripts loaded one and sent directly. They were validated on devnet, where
 * the admin IS the dev key: the only configuration in which the defect is invisible. Round 4 added a
 * guard so they refuse instead of failing mid-ceremony, and round 5 found the runbook still ordering
 * an operator to run a script guaranteed to refuse.
 *
 * WHAT THIS MODULE IS. The shared emit/verify plumbing for both steps. A ceremony step now:
 *   1. EMITS the exact instructions, decoded, to stdout and to a JSON file the operator keeps;
 *   2. is EXECUTED through the admin panel, which wraps each instruction in a Squads vault
 *      transaction, collects approvals and executes (apps/admin/src/lib/squads.ts);
 *   3. is VERIFIED by re-reading every field off the chain and comparing it to the ceremony target.
 *
 * Step 3 is the part that was missing everywhere, and it is the only one that proves anything. A
 * proposal that was approved is not a state that was reached.
 *
 * SENDING is still possible, and only where it is honest: when `config.admin` IS the loaded keypair,
 * which is the devnet rehearsal. On any other configuration `--send` refuses, loudly, naming why.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import { requireSanctionedCluster } from "./_guard";
import path from "path";

/** One ceremony action: the instruction plus what a human needs to recognise it. */
export interface CeremonyAction {
  /** Short label, e.g. "propose_set_public_mint(true)". Printed and stored. */
  label: string;
  /** What this action changes and why it is in this step. Goes into the emitted JSON. */
  intent: string;
  ix: TransactionInstruction;
  /** True when the chain already holds the target value, so the action is a no-op. */
  alreadyDone: boolean;
  /** Filled when alreadyDone: what was read, so "skipped" is never a bare claim. */
  observed?: string;
}

export type Mode = "emit" | "send" | "verify";

/**
 * `--emit` (the default and the mainnet path), `--send` (devnet rehearsal only), `--verify`.
 * The default is deliberately the one that cannot touch the chain: a script whose default action is
 * a transaction is a script somebody runs by accident.
 */
export function modeFromArgv(argv: string[]): Mode {
  if (argv.includes("--send")) return "send";
  if (argv.includes("--verify")) return "verify";
  return "emit";
}

/**
 * Refuse `--send` on any configuration where it cannot work, and say which one this is.
 *
 * The check is `config.admin == signer`, not `isOnCurve`: an ON-curve admin that is simply a
 * different key is equally unsignable here, and the round 4 guard already made that distinction. What
 * changes in round 5 is that refusing is no longer the end of the road, because `--emit` is.
 */
export function assertSendable(configAdmin: PublicKey, signer: PublicKey, step: string): void {
  if (configAdmin.equals(signer)) return;
  const onCurve = PublicKey.isOnCurve(configAdmin.toBytes());
  throw new Error(
    `REFUS: --send is impossible for ${step}.\n` +
      `  config.admin : ${configAdmin.toBase58()}${onCurve ? "" : "  (OFF-CURVE, a PDA)"}\n` +
      `  key provided : ${signer.toBase58()}\n` +
      (onCurve
        ? "  config.admin is not the key you passed, so this script cannot sign for it.\n"
        : "  config.admin is a PDA (a Squads vault). No private key exists for it, so has_one = admin\n" +
          "  can never be satisfied by any keypair.\n") +
      `  Run without --send to EMIT the instructions, then execute them through the admin panel,\n` +
      `  which wraps each one in a Squads vault transaction. Then re-run with --verify.\n` +
      `  See round 5 P0-03 and decision D3.`,
  );
}

/** Serialize one instruction into the shape the admin panel and a human both need. */
function describe(a: CeremonyAction) {
  return {
    label: a.label,
    intent: a.intent,
    alreadyDone: a.alreadyDone,
    observed: a.observed ?? null,
    programId: a.ix.programId.toBase58(),
    accounts: a.ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    dataBase64: Buffer.from(a.ix.data).toString("base64"),
    /** The 8-byte Anchor discriminator, so an operator can eyeball that two dumps are the same call. */
    discriminatorHex: Buffer.from(a.ix.data.subarray(0, 8)).toString("hex"),
  };
}

/**
 * Write the step's instructions to `ceremony-out/<step>.json` and print them.
 *
 * The file is the artifact the operator carries into the Squads UI or the admin panel, and the thing
 * a second person can diff against what the panel is about to propose. Emitting to stdout ONLY would
 * put a launch-critical payload in a terminal scrollback.
 */
export function emit(step: string, cluster: string, actions: CeremonyAction[]): string {
  const outDir = path.join(__dirname, "..", "ceremony-out");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${step}.json`);
  const pending = actions.filter((a) => !a.alreadyDone);
  const doc = {
    step,
    cluster,
    // No timestamp: this file is diffed between runs and between people, and a clock would make two
    // identical ceremonies look different.
    note:
      "Instructions to execute through the Ops Squads. Each must be wrapped in a vault transaction " +
      "whose sender is config.admin. Execute via the admin panel (it does the wrapping), then re-run " +
      "this script with --verify to read every field back off the chain.",
    actions: actions.map(describe),
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");

  console.log(`\n  ${step}: ${pending.length} action(s) to execute, ${actions.length - pending.length} already done`);
  for (const a of actions) {
    if (a.alreadyDone) {
      console.log(`    [done]    ${a.label}${a.observed ? "  -> " + a.observed : ""}`);
    } else {
      console.log(`    [TO DO]   ${a.label}`);
      console.log(`              ${a.intent}`);
      console.log(`              discriminator ${Buffer.from(a.ix.data.subarray(0, 8)).toString("hex")}, ${a.ix.keys.length} accounts`);
    }
  }
  console.log(`\n  written: ${file}`);
  if (pending.length > 0) {
    console.log(`  NEXT: execute these through the admin panel (Squads), then re-run with --verify.`);
  }
  return file;
}

/**
 * Send the pending actions. Only reachable after `assertSendable`, i.e. the devnet rehearsal.
 *
 * It re-guards the cluster ITSELF rather than trusting that the caller did. `verify-cluster-resolution.ts`
 * requires every file containing a send primitive to call `requireSanctionedCluster` IN CODE, and it
 * went red on this file the moment the sends moved here from the two ceremony scripts. Satisfying
 * that by widening the rule would have been the wrong repair: the rule is right, and the invariant it
 * states is worth more at the place that actually signs than at the place that happens to call it
 * today. The endpoint comes from the Connection, so a caller cannot guard one cluster and send to
 * another. The second call costs one RPC round trip on a path that is about to send transactions.
 */
export async function sendAll(
  conn: Connection,
  signer: Keypair,
  actions: CeremonyAction[],
): Promise<void> {
  await requireSanctionedCluster(conn.rpcEndpoint, "ceremony send");
  for (const a of actions) {
    if (a.alreadyDone) {
      console.log(`    [done]    ${a.label}${a.observed ? "  -> " + a.observed : ""}`);
      continue;
    }
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(a.ix), [signer], {
      commitment: "confirmed",
    });
    console.log(`    [sent]    ${a.label}: ${sig}`);
  }
}

/**
 * ROUND 6 R6-10. Decode a `TimelockQueueAccount` and say whether it is the proposal we meant to make.
 *
 * THE DEFECT THIS REPLACES. `ceremony-step7.ts` decided a proposal was "already pending" from
 * `config.pendingXxxNonce != null` alone, and a comment in the same file claimed the resumption
 * "decoded each TimelockQueueAccount and compared discriminator, payload, rent payer, ETA and nonce".
 * The code never derived the PDA, let alone loaded it. For the public mint that was survivable because
 * the program only lets `true` be proposed, so presence implies content. For the treasury float ANY
 * valid u64 can occupy the slot, so a resumed ceremony could declare a step done while the queued
 * value was not the one asked for, and `--verify` printed the presence as a non-blocking note.
 *
 * Anchor layout, in order: 8 discriminator, nonce u64, action_disc u8, action_data Vec<u8> (4-byte
 * length prefix), scheduled_at i64, executable_at i64, executed_at Option<i64>, cancelled bool,
 * proposer Pubkey, rent_payer Pubkey.
 */
export interface QueuedAction {
  nonce: bigint;
  actionDisc: number;
  actionData: Buffer;
  scheduledAt: bigint;
  executableAt: bigint;
  executedAt: bigint | null;
  cancelled: boolean;
  proposer: PublicKey;
  rentPayer: PublicKey;
}

export function timelockPda(nonce: bigint, programId: PublicKey): PublicKey {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync([Buffer.from("timelock"), seed], programId)[0];
}

export function decodeQueuedAction(data: Buffer): QueuedAction {
  let o = 8; // discriminator
  const nonce = data.readBigUInt64LE(o); o += 8;
  const actionDisc = data.readUInt8(o); o += 1;
  const dataLen = data.readUInt32LE(o); o += 4;
  const actionData = data.subarray(o, o + dataLen); o += dataLen;
  const scheduledAt = data.readBigInt64LE(o); o += 8;
  const executableAt = data.readBigInt64LE(o); o += 8;
  const hasExecuted = data.readUInt8(o) === 1; o += 1;
  const executedAt = hasExecuted ? data.readBigInt64LE(o) : null;
  if (hasExecuted) o += 8;
  const cancelled = data.readUInt8(o) === 1; o += 1;
  const proposer = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const rentPayer = new PublicKey(data.subarray(o, o + 32));
  return { nonce, actionDisc, actionData, scheduledAt, executableAt, executedAt, cancelled, proposer, rentPayer };
}

/**
 * Is the queued action at `nonce` EXACTLY the one we are about to propose? Returns null when it is,
 * or a human-readable reason when it is not. A reason means the slot is occupied by something else,
 * which is a REFUSAL and not a skip: silently proposing nothing because a stranger's value sits in the
 * slot is how a ceremony reports success on a state nobody chose.
 */
export async function queuedActionMatches(
  conn: Connection,
  programId: PublicKey,
  nonce: bigint,
  expectDisc: number,
  expectData: Buffer,
): Promise<string | null> {
  const pda = timelockPda(nonce, programId);
  const info = await conn.getAccountInfo(pda);
  if (!info) return `the config names nonce ${nonce} as pending, but ${pda.toBase58()} does not exist`;
  let q: QueuedAction;
  try {
    q = decodeQueuedAction(Buffer.from(info.data));
  } catch (e) {
    return `could not decode the queued action at ${pda.toBase58()}: ${String(e).slice(0, 120)}`;
  }
  if (q.nonce !== nonce) return `queued nonce is ${q.nonce}, config says ${nonce}`;
  if (q.cancelled) return `the queued action at nonce ${nonce} is CANCELLED`;
  if (q.executedAt !== null) return `the queued action at nonce ${nonce} was already executed`;
  if (q.actionDisc !== expectDisc) {
    return `queued action_disc is ${q.actionDisc}, expected ${expectDisc}`;
  }
  if (!q.actionData.equals(expectData)) {
    return (
      `queued payload is 0x${q.actionData.toString("hex")}, expected 0x${expectData.toString("hex")}. ` +
      `Cancel it (cancel_timelocked_action ${nonce}) and re-propose, or accept the queued value ` +
      `deliberately by changing what this ceremony asks for.`
    );
  }
  return null;
}

/**
 * A field-by-field comparison of the chain against the ceremony target.
 *
 * ROUND 5 P2-04. The old scripts checked PRESENCE: "a proposal already exists at this slot" and
 * "guardian_count >= the number we meant to add". Both accept the wrong content. A pending proposal
 * carrying the wrong value read as "already queued", and an unexpected extra guardian read as fine.
 * So a check here states the EXPECTED value and prints the OBSERVED one, always, on pass and on fail.
 */
export class Checks {
  private bad = 0;
  private total = 0;

  eq(label: string, observed: unknown, expected: unknown): void {
    this.total += 1;
    const o = String(observed);
    const e = String(expected);
    const ok = o === e;
    if (!ok) this.bad += 1;
    console.log(`    ${ok ? "ok  " : "BAD "} ${label}: ${o}${ok ? "" : `   (expected ${e})`}`);
  }

  /** For sets that must match EXACTLY, not merely contain. Round 5 P2-04's guardian case. */
  sameSet(label: string, observed: string[], expected: string[]): void {
    this.total += 1;
    const o = [...observed].sort();
    const e = [...expected].sort();
    const ok = o.length === e.length && o.every((v, i) => v === e[i]);
    if (!ok) this.bad += 1;
    console.log(`    ${ok ? "ok  " : "BAD "} ${label}: [${o.join(", ")}]`);
    if (!ok) {
      const extra = o.filter((v) => !e.includes(v));
      const missing = e.filter((v) => !o.includes(v));
      if (extra.length) console.log(`         UNEXPECTED: ${extra.join(", ")}`);
      if (missing.length) console.log(`         MISSING:    ${missing.join(", ")}`);
    }
  }

  /** Advisory only: prints, never fails. For accepted risks that must stay visible (D5). */
  note(label: string, detail: string): void {
    console.log(`    note  ${label}: ${detail}`);
  }

  finish(step: string): void {
    if (this.bad > 0) {
      console.error(`\n  ${step}: ${this.bad} of ${this.total} check(s) FAILED. Do not continue.`);
      process.exit(1);
    }
    console.log(`\n  ${step}: ${this.total}/${this.total} on-chain checks pass.`);
  }
}
