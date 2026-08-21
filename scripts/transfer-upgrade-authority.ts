/**
 * Hand the PROGRAM UPGRADE AUTHORITY from the deployer's hot key to the Squads multisig vault.
 *
 * WHY THIS IS THE MOST CONSEQUENTIAL REMAINING KEY. Everything else about this protocol is already
 * behind a 3-of-5: the admin is a Squads vault, the freeze authority and the permanent delegate are a
 * Squads vault, the mint authority is a PDA. The program's upgrade authority is not. It is
 * `2Lp91FyJUb8MQ1yteFLKh345Umb5f1RgCCwwDFNCYEcD`, one key on one laptop, and whoever holds it can
 * replace ALL of the logic above with no multisig, no timelock and no notice. Every guarantee the other
 * controls provide is downstream of it: a replaced program can mint without a cap, pay itself the
 * treasury, or make `pause` a no-op. So this single instruction is worth more than any other hardening
 * left on the list.
 *
 * WHAT MAKES IT DANGEROUS, and why this file exists instead of a one-line CLI invocation:
 *
 *   `solana program set-upgrade-authority` accepts ANY 32 bytes. It does not check that the destination
 *   exists, that it is a Squads vault, or that anybody can sign for it. Three ways to lose the program
 *   permanently, all one paste away:
 *
 *     1. THE MULTISIG ACCOUNT INSTEAD OF ITS VAULT. `BjbtdEcy...` is the multisig; `FqFNXCMe...` is the
 *        vault that can sign. The multisig account cannot sign anything. This exact confusion already
 *        cost this project time once, which is why MAINNET_ADDRESSES.md says so in bold.
 *     2. A TYPO. Base58 has no checksum a human can verify by eye. The program becomes the property of
 *        an address nobody holds the key to.
 *     3. `None`, making the program immutable forever. No upgrade, no fix, no migration, ever.
 *
 *   None of the three is recoverable, at all, by anyone. That is why the action is `irreversible` in
 *   ACTION_COST and why this script DERIVES the destination rather than accepting it.
 *
 * HOW IT REFUSES TO BE WRONG. `--to` is not trusted: it is CROSS-CHECKED against a vault PDA derived
 * from `--multisig` and `--vault-index`, and a disagreement is fatal. So a typo has to be made twice,
 * consistently, in two different notations, which is not a typo any more. On top of that it proves the
 * multisig is owned by the Squads program, reads its real threshold and membership off the chain, and
 * refuses a destination equal to the multisig account itself.
 *
 * IT ALSO REFUSES TO PAGE US AT 3AM FOR OUR OWN ACT. `health-monitor.ts` pins the upgrade authority as
 * a literal and alerts on drift, which is exactly right: an upgrade-authority change is the loudest
 * signal of a takeover. But it means THIS transfer sets off that alarm unless the literal is updated in
 * the same change. That is not hypothetical. On 2026-08-21 we moved the mint premium through the
 * timelock, left the pin at its old value, and the monitor paged every ten minutes for hours on our own
 * deliberate act. So the pin is a PRECONDITION here, checked in the source, not a follow-up task.
 *
 * DRY RUN BY DEFAULT. It verifies, simulates and prints; it sends only with `--confirm`.
 *
 *   npx tsx scripts/transfer-upgrade-authority.ts --multisig <ms> --vault-index 0 --to <vault>
 *   DOMINION_ALLOW_MAINNET=i-understand DOMINION_INTENT=set_upgrade_authority \
 *     npx tsx scripts/transfer-upgrade-authority.ts ... --confirm
 *
 * AFTER THIS LANDS, upgrading means: write the buffer (any funded key), then a Squads proposal carrying
 * the loader's `Upgrade` instruction, 3 approvals, execute. Slower on purpose. It does NOT slow the
 * emergency response, because `pause` already needs admin or a guardian and both are Squads vaults.
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { redactRpc } from "./_redact";
import { PROGRAM_ID } from "./_program-id";

const REPO = path.resolve(__dirname, "..");
/** The Squads SDK lives in the admin app's tree, the same resolution create-ops-proposal.ts uses. */
const r = createRequire(path.join(REPO, "apps/admin/"));
/* eslint-disable @typescript-eslint/no-explicit-any */
const multisig: any = r("@sqds/multisig");

const RPC = process.env.DOMINION_RPC;
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SQUADS_PROGRAM = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
/** The loader's instruction enum. SetAuthority is 4, a bare u32 LE with no operands. */
const IX_SET_AUTHORITY = 4;

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.slice(2).includes(name);

function loadDeployer(): Keypair {
  const p = (
    process.env.DOMINION_KEYPAIR || path.join(os.homedir(), ".config", "solana", "dominion-dev.json")
  ).replace(/^~/, os.homedir());
  if (!fs.existsSync(p)) throw new Error(`deployer keypair not found at ${p}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/**
 * Read the pinned upgrade authority out of health-monitor.ts's source.
 *
 * Parsing a sibling script's source is unusual and it is the point: the monitor's pin and the chain must
 * move together, so the check has to read the thing that will actually alert, not a copy of it.
 */
function pinnedUpgradeAuthority(): string | null {
  const src = fs.readFileSync(path.join(REPO, "scripts", "health-monitor.ts"), "utf8");
  const m = /upgradeAuthority:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(src);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("DOMINION_RPC must be set");
  const msArg = arg("--multisig");
  const toArg = arg("--to");
  const vaultIndex = Number(arg("--vault-index") ?? 0);
  if (!msArg || !toArg) {
    throw new Error(
      "--multisig <pubkey> and --to <pubkey> are both required. --to is cross-checked against the vault " +
        "PDA derived from --multisig and --vault-index; that redundancy IS the safety mechanism.",
    );
  }
  const CONFIRM = flag("--confirm");

  await requireSanctionedCluster(RPC, "transfer-upgrade-authority");
  const conn = new Connection(RPC, "finalized");
  const deployer = loadDeployer();

  console.log("transfer program upgrade authority");
  console.log(`  cluster  : ${redactRpc(RPC)}`);
  console.log(`  program  : ${PROGRAM_ID.toBase58()}`);
  console.log(`  signer   : ${deployer.publicKey.toBase58()}`);
  console.log(`  mode     : ${CONFIRM ? "SEND" : "DRY RUN (add --confirm to send)"}`);
  console.log("");

  let fail = 0;
  const check = (ok: boolean, what: string, detail = ""): boolean => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` -> ${detail}` : ""}`);
    if (!ok) fail++;
    return ok;
  };

  // ---- 1. the current authority, and whether we can even sign for it ---------------------
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER);
  const pdInfo = await conn.getAccountInfo(programData, "finalized");
  if (!pdInfo || pdInfo.data.length < 45) throw new Error(`ProgramData ${programData.toBase58()} unreadable`);
  const deploySlot = Number(pdInfo.data.readBigUInt64LE(4));
  const hasAuthority = pdInfo.data[12] === 1;
  const currentAuthority = hasAuthority ? new PublicKey(pdInfo.data.subarray(13, 45)) : null;

  console.log("== 1. what the chain says now ==");
  console.log(`  ProgramData : ${programData.toBase58()}`);
  console.log(`  deploy slot : ${deploySlot}`);
  console.log(`  authority   : ${currentAuthority?.toBase58() ?? "NONE, the program is already immutable"}`);
  check(pdInfo.owner.equals(LOADER), "ProgramData is owned by the upgradeable loader", pdInfo.owner.toBase58());
  check(currentAuthority !== null, "the program is still upgradeable");
  check(
    currentAuthority !== null && currentAuthority.equals(deployer.publicKey),
    "the loaded keypair IS the current upgrade authority, so it can sign this",
    currentAuthority ? `chain says ${currentAuthority.toBase58()}` : "",
  );

  // ---- 2. DERIVE the destination. --to is a claim; the derivation is the fact. ------------
  console.log("");
  console.log("== 2. the destination, derived rather than trusted ==");
  const msPda = new PublicKey(msArg);
  const to = new PublicKey(toArg);
  const [derivedVault] = multisig.getVaultPda({ multisigPda: msPda, index: vaultIndex });
  console.log(`  multisig            : ${msPda.toBase58()}`);
  console.log(`  vault index         : ${vaultIndex}`);
  console.log(`  derived vault PDA   : ${derivedVault.toBase58()}`);
  console.log(`  --to as given       : ${to.toBase58()}`);
  check(
    derivedVault.equals(to),
    "--to MATCHES the vault PDA derived from --multisig",
    derivedVault.equals(to) ? "" : "these disagree, so one of them is wrong. Refusing.",
  );
  check(!to.equals(msPda), "the destination is the VAULT, not the multisig account itself");

  const msInfo = await conn.getAccountInfo(msPda, "finalized");
  check(msInfo !== null, "the multisig account exists on this cluster");
  check(msInfo !== null && msInfo.owner.equals(SQUADS_PROGRAM), "the multisig is owned by the Squads program", msInfo?.owner.toBase58() ?? "");

  if (msInfo) {
    const ms: any = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
    const members: any[] = ms.members ?? [];
    console.log(`  threshold           : ${ms.threshold} of ${members.length} members`);
    console.log(`  Squads timeLock     : ${ms.timeLock}s`);
    check(Number(ms.threshold) >= 3, "the threshold is at least 3", `${ms.threshold}`);
    check(members.length >= 5, "there are at least 5 members", `${members.length}`);
    const isMember = members.some((m) => new PublicKey(m.key).equals(deployer.publicKey));
    // Not a failure, but it decides whether WE can still participate in an upgrade afterwards.
    console.log(
      `  ${isMember ? "note" : "WARN"}  the signing deployer is ${isMember ? "" : "NOT "}a member of this ` +
        `multisig${isMember ? "" : ", so after this transfer it can no longer take part in an upgrade at all"}`,
    );
  }

  // ---- 3. the monitor's pin, checked BEFORE the chain moves -------------------------------
  console.log("");
  console.log("== 3. the alarm that would otherwise fire on us ==");
  const pinned = pinnedUpgradeAuthority();
  console.log(`  health-monitor PINNED.upgradeAuthority : ${pinned ?? "COULD NOT PARSE"}`);
  check(
    pinned === to.toBase58(),
    "the monitor already pins the NEW authority, so this transfer will not page",
    pinned === to.toBase58()
      ? ""
      : `update PINNED.upgradeAuthority to ${to.toBase58()} in scripts/health-monitor.ts FIRST, and commit it. ` +
        `Leaving it stale is what made the premium change page every ten minutes on 2026-08-21.`,
  );

  // ---- 4. simulate ------------------------------------------------------------------------
  console.log("");
  console.log("== 4. simulation ==");
  const data = Buffer.alloc(4);
  data.writeUInt32LE(IX_SET_AUTHORITY, 0);
  const ix = new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: to, isSigner: false, isWritable: false },
    ],
    data,
  });
  void SystemProgram;
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  const msg = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    check(false, "the SetAuthority instruction simulates cleanly", JSON.stringify(sim.value.err));
    for (const l of sim.value.logs ?? []) console.log(`      ${l.slice(0, 160)}`);
  } else {
    check(true, "the SetAuthority instruction simulates cleanly");
  }

  console.log("");
  console.log(`==== ${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`} ====`);
  if (fail > 0) {
    console.log("Refusing to send. Every failure above is a way to lose the program permanently.");
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log("");
    console.log("DRY RUN, nothing was sent. To do it for real:");
    console.log("");
    console.log(`  DOMINION_ALLOW_MAINNET=i-understand DOMINION_INTENT=set_upgrade_authority \\`);
    console.log(`    DOMINION_RPC=<mainnet> npx tsx scripts/transfer-upgrade-authority.ts \\`);
    console.log(`    --multisig ${msPda.toBase58()} --vault-index ${vaultIndex} --to ${to.toBase58()} --confirm`);
    console.log("");
    console.log("AFTERWARDS, upgrading the program means a Squads proposal carrying the loader's Upgrade");
    console.log("instruction and 3 of 5 approvals. The deployer key alone will no longer be able to do it,");
    console.log("which is the entire purpose.");
    process.exit(0);
  }

  // ---- 5. send. Named intent required: losing this is unrecoverable. ---------------------
  assertReversible("set_upgrade_authority", intentFromEnv());
  console.log("");
  console.log("SENDING.");
  tx.sign([deployer]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  console.log(`  signature : ${sig}`);
  console.log(`  solscan   : https://solscan.io/tx/${sig}`);

  // FINALIZED, not confirmed. Reading back at `confirmed` right after a send produced five separate
  // false negatives on this project, including one that reported a correct mint as economically wrong.
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 120_000) {
    const got = await conn.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (got) {
      seen = true;
      break;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!seen) {
    console.error("  NOT finalized within 120s. DO NOT RE-SEND: check solscan first, it may well have landed.");
    process.exit(2);
  }

  const after = await conn.getAccountInfo(programData, "finalized");
  const newAuth = after && after.data[12] === 1 ? new PublicKey(after.data.subarray(13, 45)).toBase58() : "NONE";
  console.log("");
  console.log(`  authority now : ${newAuth}`);
  if (newAuth !== to.toBase58()) {
    console.error(`  MISMATCH: expected ${to.toBase58()}. Investigate before doing anything else.`);
    process.exit(1);
  }
  console.log("  VERIFIED at finalized: the program upgrade authority is now the multisig vault.");
  console.log("  The deployer key can no longer replace this program on its own.");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\ntransfer-upgrade-authority FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
