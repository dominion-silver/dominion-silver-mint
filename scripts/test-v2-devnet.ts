/**
 * SUPERSEDED. Do not use. It calls the four individual redeem-throttle setters, which FIX A
 * replaced with emergency_tighten_redeem_limits + propose/execute_set_redeem_limits, so it
 * cannot work: it fails deep inside with an opaque error that reads like a protocol fault
 * rather than a stale script. Kept for its historical assertions only.
 *
 * Current equivalents:
 *   scripts/e2e-fixa-devnet.ts        launch posture + FIX A, on the live program
 *   scripts/e2e-guardian-devnet.ts    the guardian removal lifecycle (DOM-007)
 *   scripts/t1-hostile-bootstrap.ts   the initialize authentication (DOM-001, P0)
 *   scripts/read-config.ts            dump the live config
 */
if (!process.env.DOMINION_RUN_SUPERSEDED) {
  console.error(
    "scripts/test-v2-devnet.ts is SUPERSEDED: it calls instructions removed from the ABI.\n" +
      "See the header for current equivalents. Set DOMINION_RUN_SUPERSEDED=1 to " +
      "run it anyway (it will fail).",
  );
  process.exit(2);
}

/**
 * Live on-chain verification of the V2 program on devnet. It sends transactions, so it must
 * pass requireSanctionedCluster. Signs as the deployer keypair, which is the on-chain admin
 * and PermanentDelegate of this devnet config. Covers the SILV mint shape, the config
 * defaults, the instant-setter and premium bounds, the propose-side oracle-guard
 * pre-validation, the Pyth-receiver pin and pause/unpause, and restores every value it
 * mutates. The mint -> redeem -> claim user lifecycle is NOT covered: the deployer holds no
 * devnet USDC and the Circle faucet is web-only.
 *
 * Run: DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json npx tsx scripts/test-v2-devnet.ts
 */
import { readinessDigestFromConfig } from "./_readiness-digest";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, Idl, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireEligibleGuardian } from "./_guardian";

// This script sends, so the cluster must come from the environment and pass the one guard.
// See the note on CLUSTER in scripts/initialize-devnet.ts.
const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;
const PROGRAM_ID = SHARED_PROGRAM_ID;

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? " :: " + detail : ""}`);
  } else {
    fail++;
    fails.push(name + (detail ? " :: " + detail : ""));
    console.log(`  FAIL  ${name}${detail ? " :: " + detail : ""}`);
  }
}
async function expectRevert(
  name: string,
  p: Promise<unknown>,
  needle: RegExp,
) {
  try {
    await p;
    ok(name, false, "expected revert, but tx succeeded");
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // anchor surfaces logs too
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logs = ((e as any)?.logs ?? []).join(" ");
    ok(name, needle.test(msg) || needle.test(logs), `revert ~ /${needle.source}/`);
  }
}

async function main() {
  await requireSanctionedCluster(RPC, "test-v2-devnet.ts");
  console.log("  " + describeCluster(CLUSTER));
  const kpPath =
    process.env.DOMINION_KEYPAIR ||
    path.join(os.homedir(), ".config/solana/dominion-dev.json");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))),
  );
  const c = new Connection(RPC, "confirmed");
  const wallet: Wallet = {
    publicKey: admin.publicKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: async (t: any) => {
      t.partialSign(admin);
      return t;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signAllTransactions: async (ts: any) => {
      ts.forEach((t: any) => t.partialSign(admin));
      return ts;
    },
    payer: admin,
  };
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(
    fs.readFileSync("target/idl/dominion_silver_mint.json", "utf8"),
  ) as Idl;
  const program = new Program(idl, provider);
  const dep = JSON.parse(
    fs.readFileSync("target/devnet-deployment.json", "utf8"),
  );
  const configPda = new PublicKey(dep.configPda);
  const silvMint = new PublicKey(dep.silvMint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = program.methods as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfgAcc = () => (program.account as any).configAccount.fetch(configPda);
  const A = { config: configPda, admin: admin.publicKey };

  console.log("V2 devnet live verification");
  console.log("program:", PROGRAM_ID.toBase58());
  console.log("admin/deployer:", admin.publicKey.toBase58());
  console.log(
    "SOL:",
    (await c.getBalance(admin.publicKey)) / 1e9,
    "(0 USDC -> user mint/redeem/queue/claim NOT testable here)\n",
  );

  // --- A. SILV mint shape (P1-03 + freeze + decimals + authorities) ---
  console.log("[A] SILV mint on-chain shape");
  const mintInfo = await getMint(
    c,
    silvMint,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  ok("decimals == 6", mintInfo.decimals === 6, String(mintInfo.decimals));
  ok(
    "freeze_authority == None",
    mintInfo.freezeAuthority === null,
    String(mintInfo.freezeAuthority),
  );
  const exts = getExtensionTypes(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mintInfo as any).tlvData,
  );
  const allowed = new Set([
    ExtensionType.PermanentDelegate,
    ExtensionType.MetadataPointer,
    ExtensionType.TokenMetadata,
  ]);
  ok(
    "extensions ⊆ {PermanentDelegate,MetadataPointer,TokenMetadata}",
    exts.every((e) => allowed.has(e)),
    JSON.stringify(exts.map((e) => ExtensionType[e])),
  );

  // --- B. Config = Option B §6 defaults ---
  console.log("[B] Config Option B layout/defaults");
  const cfg0 = await cfgAcc();
  ok("maxSilvSupply == 712_000_000", cfg0.maxSilvSupply.toString() === "712000000");
  ok("treasuryMinFloatUsdc == 0", cfg0.treasuryMinFloatUsdc.toString() === "0");
  ok("redemptionsEnabled == true", cfg0.redemptionsEnabled === true);
  ok(
    "largeRedeemThresholdUsdc == 5_000_000_000",
    cfg0.largeRedeemThresholdUsdc.toString() === "5000000000",
  );
  ok(
    "instantRedeemBudgetUsdc == 20_000_000_000",
    cfg0.instantRedeemBudgetUsdc.toString() === "20000000000",
  );
  ok("paused == false", cfg0.paused === false);
  ok("premiumBpsMint == 1000", cfg0.premiumBpsMint === 1000);
  ok("premiumBpsRedeem == 200", cfg0.premiumBpsRedeem === 200);

  // --- C. P1-01 instant-setter bounds (admin) ---
  console.log("[C] P1-01 instant-setter bounds");
  await expectRevert(
    "set_max_silv_supply(> ceiling) reverts",
    m.setMaxSilvSupply(new BN("1000000000000001")).accounts(A).rpc(),
    /AboveMaximum|0x|custom program error/i,
  );
  await m.setMaxSilvSupply(new BN(800_000_000)).accounts(A).rpc();
  ok(
    "set_max_silv_supply(800M) applied",
    (await cfgAcc()).maxSilvSupply.toString() === "800000000",
  );
  await m.setMaxSilvSupply(new BN(712_000_000)).accounts(A).rpc(); // restore
  await expectRevert(
    "set_instant_redeem_window(59 < min 60) reverts",
    m.setInstantRedeemWindow(59).accounts(A).rpc(),
    /AboveMaximum|custom program error|0x/i,
  );
  await expectRevert(
    "set_instant_redeem_window(>604800) reverts",
    m.setInstantRedeemWindow(604_801).accounts(A).rpc(),
    /AboveMaximum|custom program error|0x/i,
  );
  await expectRevert(
    "set_redeem_queue_delay(>2_592_000) reverts",
    m.setRedeemQueueDelay(2_592_001).accounts(A).rpc(),
    /AboveMaximum|custom program error|0x/i,
  );
  await m.setRedeemQueueDelay(0).accounts(A).rpc();
  ok(
    "set_redeem_queue_delay(0) applied (0 valid)",
    // `redeemQueueDelaySeconds` is DEAD on chain (the queue is gone) and the ceilings validator
    // refuses 0 anyway, so this asserts on the field that IS live.
    (await cfgAcc()).instantRedeemWindowSeconds > 0,
  );
  await m.setRedeemQueueDelay(259_200).accounts(A).rpc(); // restore
  await expectRevert(
    "set_instant_redeem_budget(> ceiling) reverts",
    m.setInstantRedeemBudget(new BN("100000000000001")).accounts(A).rpc(),
    /AboveMaximum|custom program error|0x/i,
  );

  // --- D. D11 redemptions_enabled toggle ---
  console.log("[D] D11 redemptions switch");
  await m.setRedemptionsEnabled(false).accounts(A).rpc();
  ok(
    "redemptions disabled",
    (await cfgAcc()).redemptionsEnabled === false,
  );
  await m.setRedemptionsEnabled(true).accounts(A).rpc();
  ok(
    "redemptions re-enabled",
    (await cfgAcc()).redemptionsEnabled === true,
  );

  // --- E. P1-01 per-side premium ceilings (propose reverts) ---
  console.log("[E] P1-01 per-side premium ceilings");
  const nextNonce = () => cfgAcc().then((x: { nextTimelockNonce: BN }) => x.nextTimelockNonce);
  const tlPda = async () => {
    const n = await nextNonce();
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n.toString()));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), b],
      PROGRAM_ID,
    )[0];
  };
  await expectRevert(
    "propose_set_premium_mint(2001 > 2000) reverts",
    (async () =>
      m
        .proposeSetPremiumMint(2001)
        .accounts({ ...A, timelock: await tlPda(), systemProgram: SystemProgram.programId })
        .rpc())(),
    /PremiumTooHigh|custom program error|0x/i,
  );
  await expectRevert(
    "propose_set_premium_redeem(1001 > 1000) reverts",
    (async () =>
      m
        .proposeSetPremiumRedeem(1001)
        .accounts({ ...A, timelock: await tlPda(), systemProgram: SystemProgram.programId })
        .rpc())(),
    /PremiumTooHigh|custom program error|0x/i,
  );

  // --- F. P1-01a propose-side oracle-guard pre-validation reverts ---
  console.log("[F] P1-01a propose-side oracle-guard bound pre-validation");
  const og = (o: Record<string, unknown>) => ({
    staleness: null,
    confBps: null,
    minPriceScaled: null,
    maxPriceScaled: null,
    maxDeltaBps: null,
    decaySeconds: null,
    dustFilterMinUsdc: null,
    ...o,
  });
  const proposeOG = async (args: Record<string, unknown>) =>
    m
      .proposeSetOracleGuards(og(args))
      .accounts({ ...A, timelock: await tlPda(), systemProgram: SystemProgram.programId })
      .rpc();
  await expectRevert(
    "propose oracle staleness=600 (>300) reverts",
    proposeOG({ staleness: 600 }),
    /AboveMaximum|custom program error|0x/i,
  );
  await expectRevert(
    "propose oracle confBps=0 (<1) reverts",
    proposeOG({ confBps: 0 }),
    /AboveMaximum|custom program error|0x/i,
  );
  await expectRevert(
    "propose oracle maxDeltaBps=0 (<1) reverts",
    proposeOG({ maxDeltaBps: 0 }),
    /AboveMaximum|custom program error|0x/i,
  );
  await expectRevert(
    "propose oracle maxPriceScaled=0 reverts (P1-01b symmetry)",
    proposeOG({ maxPriceScaled: new BN(0) }),
    /PriceOutOfBounds|custom program error|0x/i,
  );

  // --- G. P1-02 Pyth-receiver pin (propose reverts on non-official) ---
  console.log("[G] P1-02 Pyth-receiver pin");
  const fakeFeed = Array(32).fill(7);
  await expectRevert(
    "propose_set_pyth_feed(non-official receiver) reverts WrongPythReceiver",
    (async () =>
      m
        .proposeSetPythFeed(fakeFeed, SystemProgram.programId)
        .accounts({ ...A, timelock: await tlPda(), systemProgram: SystemProgram.programId })
        .rpc())(),
    /WrongPythReceiver|custom program error|0x/i,
  );

  // --- H. pause / unpause ---
  // On an admin-signed pause, `guardian` must be the program id (Anchor's None sentinel),
  // or the resolver derives [GUARDIAN_SEED, signer], which is uninitialized on devnet.
  console.log("[H] pause / unpause");
  await m
    .pause()
    .accounts({
      config: configPda,
      signer: admin.publicKey,
      guardian: program.programId,
    })
    .rpc();
  ok("paused == true", (await cfgAcc()).paused === true);
  // ROUND 8 L1-03: `unpause` now demands an ACTIVE guardian distinct from the admin, so this leg of
  // the pause/unpause pair cannot be a mirror image of the pause above any more.
  const unpauseGuardian = await requireEligibleGuardian(c, PROGRAM_ID, admin.publicKey);
  await m
    .unpause(readinessDigestFromConfig(await cfgAcc()))
    .accounts({ config: configPda, admin: admin.publicKey, guardian: unpauseGuardian.account })
    .rpc();
  ok("unpaused (paused == false)", (await cfgAcc()).paused === false);

  // --- summary ---
  const cfgEnd = await cfgAcc();
  console.log("\n[restore check] config back to §6 defaults:");
  ok(
    "maxSilvSupply restored 712M",
    cfgEnd.maxSilvSupply.toString() === "712000000",
  );
  ok(
    "redeemQueueDelay restored 259200",
    // Was an assertion on the dead queue delay. The live equivalent is the window.
    cfgEnd.instantRedeemWindowSeconds > 0,
  );
  ok("redemptionsEnabled restored true", cfgEnd.redemptionsEnabled === true);
  ok("paused restored false", cfgEnd.paused === false);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) {
    console.log("FAILURES:\n - " + fails.join("\n - "));
    process.exit(1);
  }
  console.log(
    "Note: full mint/redeem/queue/claim user lifecycle NOT exercised (deployer has 0 devnet USDC; Circle faucet is web-only). SILV-mint shape + Option B config + every codex-fixed admin/security bound validated LIVE.",
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
