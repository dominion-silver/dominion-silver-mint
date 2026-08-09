/**
 * Runbook step 7: the timelocked launch openings, proposed together so their 24h clocks mature
 * together. The program allows one active proposal per TYPE, not one in total, so these do not queue
 * behind each other. Verified on devnet 2026-08-07 with four coexisting proposals. Getting this wrong
 * costs a whole extra day per proposal, which is why they are in one script rather than runbook lines.
 *
 *   propose_set_public_mint(true)              opens the public mint
 *   propose_set_treasury_min_float(<float>)    the withdrawal floor, OPTIONAL: see D5 below
 *
 * ROUND 4 P0-04: this used to ALSO propose redemptions_enabled = true, which contradicts the launch
 * posture. Opening redeem is a post-launch decision, made deliberately, not a line in a launch script.
 * The assertion at the end fails if that ever drifts back.
 *
 * ROUND 5 P0-03 / D3: this is now a BUILDER, not a sender. `config.admin` on mainnet is an off-curve
 * Squads vault, so no keypair can sign for it. Default mode EMITS the instructions for the admin panel
 * to wrap into Squads vault transactions; `--verify` reads the result back off the chain; `--send`
 * works only where the admin IS the loaded key, i.e. the devnet rehearsal.
 *
 * ROUND 5 P1-06 / D5: the treasury float is NO LONGER MANDATORY here. D5 set
 * `treasury_min_float_usdc = 0` deliberately, risk accepted, and this script refused to run without a
 * non-zero value. Two sources of truth gave incompatible orders: following the decision made the tool
 * fail, following the tool annulled the decision. The float is now proposed only when
 * DOMINION_TREASURY_MIN_FLOAT_USDC is set, and its absence prints the accepted risk rather than
 * blocking.
 *
 *   npx tsx scripts/ceremony-step7.ts             # EMIT the instructions (mainnet path)
 *   npx tsx scripts/ceremony-step7.ts --verify    # read the chain back and compare
 *   npx tsx scripts/ceremony-step7.ts --send      # devnet rehearsal only
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";
import {
  modeFromArgv,
  assertSendable,
  emit,
  sendAll,
  Checks,
  queuedActionMatches,
  type CeremonyAction,
} from "./_ceremony-emit";
import idl from "../target/idl/dominion_silver_mint.json";

/** The admin the ceremony targets, read from the single source of truth rather than from a flag. */
function ceremonyAdmin(): PublicKey {
  const a = JSON.parse(fs.readFileSync(`${__dirname}/../config/mainnet-authorities.json`, "utf8"));
  const pk = a?.authorities?.ops_admin?.pubkey;
  if (!pk) throw new Error("config/mainnet-authorities.json is missing authorities.ops_admin.pubkey");
  return new PublicKey(pk);
}

async function main() {
  const MODE = modeFromArgv(process.argv);
  const CLUSTER = await resolveCluster();
  await requireSanctionedCluster(CLUSTER.rpc, "ceremony step 7: the timelocked launch openings");
  // Only --send can move anything, so only --send needs the reversibility sanction. Requiring it to
  // EMIT would train the operator to set DOMINION_INTENT for a read, which is how the variable stops
  // meaning anything on the run that does write.
  if (MODE === "send") assertReversible("propose_any", intentFromEnv());
  console.error(`# ${describeCluster(CLUSTER)}  mode=${MODE}`);

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

  // The signer is only needed to SEND. In emit/verify the admin comes from the manifest, so the
  // script runs on a machine that holds no key at all, which is where a ceremony artifact should be
  // produced from.
  const signer =
    MODE === "send"
      ? Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DOMINION_KEYPAIR!, "utf8"))),
        )
      : null;
  const provider = new anchor.AnchorProvider(
    conn,
    // A read-only provider needs a wallet shape but never signs. `Keypair.generate()` here would be a
    // key that briefly exists for no reason; the ceremony admin is the right placeholder because it is
    // also the account every one of these instructions names.
    new anchor.Wallet(signer ?? Keypair.generate()),
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const M = program.methods as any;
  const cfg = async (): Promise<any> => (program.account as any).configAccount.fetch(configPda);

  const c0 = await cfg();
  const admin: PublicKey = MODE === "send" ? signer!.publicKey : c0.admin;
  console.log(`  config.admin  : ${c0.admin.toBase58()}${PublicKey.isOnCurve(c0.admin.toBytes()) ? "" : "  (off-curve)"}`);
  console.log(`  manifest admin: ${ceremonyAdmin().toBase58()}`);

  // ROUND 6 R6-10. The two were PRINTED side by side and never compared, so an authority drift was
  // visible in a log nobody diffs and blocked nothing. If the chain's admin is not the vault this
  // ceremony was written for, every instruction below names the wrong signer and the emitted artifact
  // is a set of transactions the Ops Squads cannot execute.
  if (!c0.admin.equals(ceremonyAdmin())) {
    throw new Error(
      `config.admin does not match the ceremony manifest.\n` +
        `  on chain : ${c0.admin.toBase58()}\n` +
        `  manifest : ${ceremonyAdmin().toBase58()}  (authorities.ops_admin.pubkey)\n` +
        `Either the program was initialised with a different admin, or this manifest is not the one\n` +
        `that ceremony used. Do not proceed on either reading.`,
    );
  }
  console.log(`  nonce         : ${c0.nextTimelockNonce}, active proposals: ${c0.activeProposalCount}`);

  if (MODE === "verify") return await verify(c0, conn);

  if (MODE === "send") assertSendable(c0.admin, signer!.publicKey, "step 7");

  const actions: CeremonyAction[] = [];

  // ROUND 6 R6-10. `alreadyDone` is now decided by DECODING the queued account, not by observing that
  // the config names a nonce. TimelockAction::SetPublicMint is 11, and its payload is one borsh bool.
  const pmPending = c0.pendingPublicMintNonce;
  let pmDone = false;
  let pmObserved: string | undefined;
  if (pmPending != null) {
    const mismatch = await queuedActionMatches(
      conn,
      PROGRAM_ID,
      BigInt(pmPending.toString()),
      11,
      Buffer.from([1]),
    );
    if (mismatch) {
      throw new Error(
        `the public-mint slot is occupied by something else.\n  ${mismatch}\n` +
          `Refusing rather than skipping: reporting this step done would hand over a launch posture ` +
          `nobody chose.`,
      );
    }
    pmDone = true;
    pmObserved = `already queued at nonce ${pmPending}, payload decoded and matches`;
  }
  actions.push({
    label: "propose_set_public_mint(true)",
    intent:
      "Opens the public mint after the 24h timelock. Opening is the LOOSENING direction, so it is " +
      "announced and guardian-cancellable; closing stays instant.",
    alreadyDone: pmDone,
    observed: pmObserved,
    ix: await M.proposeSetPublicMint(true).accounts({ config: configPda, admin }).instruction(),
  });

  // D5, and the whole of round 5 P1-06. Zero is the DECIDED value and the risk is accepted, so its
  // absence is a note, not a refusal. Setting a float is still supported for whoever revisits D5.
  const rawFloat = process.env.DOMINION_TREASURY_MIN_FLOAT_USDC;
  if (rawFloat != null && rawFloat !== "") {
    const floatUsdc = Number(rawFloat);
    if (!Number.isFinite(floatUsdc) || floatUsdc < 0 || !Number.isInteger(floatUsdc)) {
      throw new Error(
        `DOMINION_TREASURY_MIN_FLOAT_USDC must be a non-negative INTEGER of micro-USDC, got "${rawFloat}".`,
      );
    }
    console.log(`  float requested: ${floatUsdc} micro-USDC (${(floatUsdc / 1e6).toFixed(2)} USDC)`);
    // ROUND 6 R6-10, AND THIS IS THE CASE THAT MATTERED. The public mint can only ever be proposed as
    // `true`, so presence implied content there. The float takes ANY u64, so a slot occupied by a
    // different amount used to read as "already pending" and the step reported success on a value
    // nobody asked for. TimelockAction::SetTreasuryFloat is 4, payload one borsh u64 little-endian.
    const floatPending = c0.pendingTreasuryFloatNonce;
    let floatDone = false;
    let floatObserved: string | undefined;
    if (floatPending != null) {
      const want = Buffer.alloc(8);
      want.writeBigUInt64LE(BigInt(floatUsdc));
      const mismatch = await queuedActionMatches(
        conn,
        PROGRAM_ID,
        BigInt(floatPending.toString()),
        4,
        want,
      );
      if (mismatch) {
        throw new Error(
          `the treasury-float slot is occupied by a DIFFERENT proposal.\n  ${mismatch}\n` +
            `This is the exact case round 6 R6-10 found: any u64 fits this slot, so "already pending" ` +
            `is not the same claim as "already correct".`,
        );
      }
      floatDone = true;
      floatObserved = `already queued at nonce ${floatPending}, payload decoded and equals ${floatUsdc}`;
    }
    actions.push({
      label: `propose_set_treasury_min_float(${floatUsdc})`,
      intent:
        "The floor that stops withdraw_usdc from emptying the redemption buffer. 24h timelocked. " +
        "Proposed only because DOMINION_TREASURY_MIN_FLOAT_USDC was set; D5 ships it at 0.",
      alreadyDone: floatDone,
      observed: floatObserved,
      ix: await M.proposeSetTreasuryMinFloat(new anchor.BN(floatUsdc))
        .accounts({ config: configPda, admin })
        .instruction(),
    });
  } else {
    console.log(
      "\n  treasury_min_float_usdc: NOT proposed. D5 (owner, 2026-08-07) sets it to 0 in full knowledge:\n" +
        "    RISK ACCEPTED: no floor opposes an admin withdrawal, so one can drain the whole USDC\n" +
        "    treasury, the same balance that backs user redemptions. SolidProof LOW #4, open by choice.\n" +
        "    WHAT STILL DEFENDS IT: withdraw_usdc is 24h-timelocked and a guardian can cancel it inside\n" +
        "    that window, so a withdrawal is announced a day ahead and vetoable. The float was a second\n" +
        "    belt, not the first.\n" +
        "    Reversible at any time via propose_/execute_set_treasury_min_float.\n" +
        "    To propose one anyway: DOMINION_TREASURY_MIN_FLOAT_USDC=<micro-USDC>",
    );
  }

  if (MODE === "send") {
    await sendAll(conn, signer!, actions);
    return await verify(await cfg(), conn);
  }
  emit("step7", describeCluster(CLUSTER), actions);
  console.log(
    `\n  After the Squads executions land, run:  npx tsx scripts/ceremony-step7.ts --verify`,
  );
}

/**
 * Read the chain back and compare EVERY field to the ceremony target.
 *
 * ROUND 5 P2-04: the old script skipped a slot whose nonce was non-null without decoding the queued
 * account, so a proposal of the right TYPE carrying the WRONG VALUE was reported as "already pending".
 * Decoding the payload is what turns that from a presence check into a content check.
 */
async function verify(c: any, conn: Connection): Promise<void> {
  const ck = new Checks();
  console.log("\n  reading the chain back:");
  ck.eq("public mint still closed (opens on execute)", c.publicMintEnabled, false);
  ck.eq("a public-mint proposal is queued", c.pendingPublicMintNonce != null, true);

  // ROUND 7 R7-05. This branch used to stop at "a nonce is non-null", which is a PRESENCE check, and
  // it is recommended after execution as the ceremony's proof. The emit and resume paths already
  // decode the account with `queuedActionMatches`; verify bifurcated before them and inherited none of
  // it, so it asserted a property weaker than the one it reported. Same defect R6-10 fixed on the
  // emit path, left standing on the path an operator runs LAST.
  if (c.pendingPublicMintNonce != null) {
    const mismatch = await queuedActionMatches(
      conn,
      PROGRAM_ID,
      BigInt(c.pendingPublicMintNonce.toString()),
      11,
      Buffer.from([1]),
    );
    ck.eq(
      "and its payload is SetPublicMint(true), decoded from the account",
      mismatch ?? "matches",
      "matches",
    );
  }

  // P0-04: the launch posture is redemptions CLOSED. A stray proposal here would open the only path
  // that pays out principal USDC, so it is a hard failure and not a note.
  ck.eq("redemptions closed", c.redemptionsEnabled, false);
  ck.eq("no redeem-limits proposal queued", c.pendingRedeemLimitsNonce == null, true);

  // D5: reported, never enforced. The number is printed so a drift is visible without being a blocker.
  ck.note(
    "treasury_min_float_usdc",
    `${c.treasuryMinFloatUsdc} (D5 ships 0, risk accepted; a queued change would show below)`,
  );
  // R6-10: under D5 nothing should be queued here at all, so a queued nonce is a real difference
  // between the chain and the decision, not a note. It is still not a hard failure, because proposing
  // a float is a legitimate deliberate act; what it must not be is invisible.
  if (c.pendingTreasuryFloatNonce == null) {
    ck.note("treasury-float proposal", "none queued (expected under D5)");
  } else {
    // ROUND 7 R7-05. Under D5 no float proposal is expected, and the float payload is an arbitrary
    // u64, so a divergence here is real rather than theoretical. This was a note that told the
    // operator to go and decode the account themselves later; the script can decode it now, and a
    // proposal nobody chose is a verification FAILURE, not a remark.
    const want = process.env.DOMINION_TREASURY_MIN_FLOAT_USDC;
    const nonce = BigInt(c.pendingTreasuryFloatNonce.toString());
    if (want === undefined) {
      ck.eq(
        `no treasury-float proposal is queued (D5 ships 0), but nonce ${nonce} holds one`,
        false,
        true,
      );
    } else {
      const payload = Buffer.alloc(8);
      payload.writeBigUInt64LE(BigInt(want));
      const mismatch = await queuedActionMatches(conn, PROGRAM_ID, nonce, 4, payload);
      ck.eq(
        `the queued treasury float at nonce ${nonce} is the ${want} this ceremony asked for`,
        mismatch ?? "matches",
        "matches",
      );
    }
  }

  const eta = new Date(Date.now() + Number(c.adminTimelockSeconds) * 1000);
  console.log(`\n  Anything queued now becomes executable around: ${eta.toISOString()}`);
  console.log(`  Then: step 10 executes the queued proposal(s), and the full mint E2E follows.`);
  ck.finish("step 7");
}

main().catch((e) => {
  console.error("step 7 failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
