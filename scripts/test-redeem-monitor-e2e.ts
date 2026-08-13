/**
 * The end-to-end proof D11 actually asks for: cause a REAL redemption on a live cluster, then show
 * that the monitor SEES it and that the alarm FIRES.
 *
 * WHY THIS AND NOT A UNIT TEST. D11's wording is "an automatic alert on RedeemEvent and on the rate the
 * budget is consumed, TESTED END TO END". A monitor whose decoder was never pointed at a real event is
 * the exact shape of the gates this repo keeps finding: green, and blind. Two things can silently fail
 * and no unit test would notice -- the Anchor event discriminator not matching what the deployed
 * program emits, and the rolling-window read disagreeing with the chain.
 *
 * IT DRIVES THE CLI, not an internal function, because the CLI is what a scheduler runs. A test of an
 * exported helper would pass while the entry point was broken.
 *
 * THREE ASSERTIONS, and the third is the one that matters:
 *   1. the monitor decodes the redemption, with the right user and the right amount
 *   2. the budget it reports moved by that redemption
 *   3. with a threshold the redemption exceeds, the verdict flips to ALERT and the process EXITS 1
 * Without 3 this would prove a reporting tool, not an alarm.
 *
 *   PYTH_LAZER_KEY=... npx tsx scripts/test-redeem-monitor-e2e.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { resolveCluster } from "./_cluster";
import { fetchSilvEnvelope } from "./_lazer-envelope";
import { lazerMessageData } from "../apps/public/src/lib/lazer-assembly";
import { assembleLazerOracleIxs, ED25519_IX_INDEX } from "../apps/public/src/lib/lazer-tx";

const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LAZER_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}

function key(file: string): Keypair {
  const p = path.join(os.homedir(), ".config", "solana", file);
  if (!fs.existsSync(p)) throw new Error(`missing keypair ${p}`);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/** Run the monitor CLI exactly as a scheduler would, and return its report plus its exit code. */
function runMonitor(env: Record<string, string>): { report: any; code: number } {
  try {
    const out = execFileSync("npx", ["tsx", path.join(__dirname, "redeem-monitor.ts"), "--json"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { report: JSON.parse(out), code: 0 };
  } catch (e: any) {
    // Exit 1 is the ALARM, so a non-zero status is a result here and not a failure to run. The JSON is
    // still on stdout; only a status of 2 means the monitor genuinely could not tell.
    const stdout = String(e.stdout ?? "");
    if (e.status === 2 || !stdout.trim().startsWith("{")) {
      throw new Error(`the monitor could not run (exit ${e.status}): ${String(e.stderr ?? "").slice(0, 300)}`);
    }
    return { report: JSON.parse(stdout), code: e.status };
  }
}

async function main() {
  await requireSanctionedCluster(RPC, "redeem monitor E2E");
  assertReversible("propose_any", intentFromEnv()); // nothing worse than a redeem happens here

  const admin = key("dominion-dev.json");
  const user = key("dominion-test-user.json");
  const conn = new Connection(RPC, "confirmed");
  const userProvider = new AnchorProvider(conn, new Wallet(user), { commitment: "confirmed" });
  const program = new Program(loadIdl() as Idl, new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" }));
  const userProgram = new Program(loadIdl() as Idl, userProvider);
  const pda = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], PROGRAM_ID)[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await (program.account as any).configAccount.fetch(pda("config"));
  if (cfg.paused) throw new Error("the protocol is paused; a redeem cannot be caused");

  const SILV_MINT = new PublicKey(cfg.silvMint);
  const USDC_MINT = new PublicKey(cfg.usdcMint);
  const treasuryAta = getAssociatedTokenAddressSync(USDC_MINT, pda("treasury"), true, TOKEN_PROGRAM_ID);
  const feeVaultAta = getAssociatedTokenAddressSync(USDC_MINT, pda("fee_vault"), true, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bal = async (a: PublicKey, p = TOKEN_PROGRAM_ID) =>
    await getAccount(conn, a, "confirmed", p).then((x) => Number(x.amount), () => 0);

  console.log("redeem monitor E2E");

  // 0. Baseline, from the monitor itself so the comparison is apples to apples.
  const before = runMonitor({ DOMINION_RPC: RPC, REDEEM_SCAN_LIMIT: "5" });
  console.log(`  baseline: ${before.report.effectiveUsedUsdc} USDC used, verdict ${before.report.verdict}`);

  // 1. Make the treasury able to pay one redemption, moving USDC that is already inside this test.
  const need = 10_600_000;
  if ((await bal(treasuryAta)) < need) {
    const short = need - (await bal(treasuryAta));
    await userProvider.sendAndConfirm(
      new Transaction().add(
        createTransferCheckedInstruction(userUsdcAta, USDC_MINT, treasuryAta, user.publicKey, short, 6, [], TOKEN_PROGRAM_ID),
      ),
      [],
    );
    console.log(`  topped the treasury up by ${short / 1e6} USDC so it can pay`);
  }

  // 2. Cause a REAL redemption.
  const { envelope, priceUsd } = await fetchSilvEnvelope();
  const silvIn = Math.ceil((10.4 / priceUsd) * 1e6);
  const usdcBefore = await bal(userUsdcAta);
  const ix = await (userProgram.methods as any)
    .redeemSilv(new anchor.BN(silvIn), new anchor.BN(1), Buffer.from(lazerMessageData(envelope)), ED25519_IX_INDEX, 0)
    .accounts({
      config: pda("config"),
      user: user.publicKey,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: treasuryAta,
      userUsdcAta,
      userSilvAta,
      feeVaultPda: pda("fee_vault"),
      feeVault: feeVaultAta,
      feeExempt: null,
      kyc: null,
      treasuryPda: pda("treasury"),
      lazerProgram: LAZER_PROGRAM,
      lazerStorage: LAZER_STORAGE,
      lazerTreasury: CLUSTER.lazerTreasury,
      lazerFeePayer: pda("lazer_fee_payer"),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const sig = await userProvider.sendAndConfirm(
    new Transaction().add(
      ...assembleLazerOracleIxs(ix, envelope, [
        createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userUsdcAta, user.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
      ]),
    ),
    [],
  );
  const received = (await bal(userUsdcAta)) - usdcBefore;
  console.log(`  caused a redemption: ${sig}`);
  console.log(`  the user received ${received / 1e6} USDC`);

  // 3. THE POINT: does the monitor see it, and does the alarm fire.
  const quiet = runMonitor({ DOMINION_RPC: RPC, REDEEM_SCAN_LIMIT: "5" });
  const seen = quiet.report.redeems.find((r: any) => r.sig === sig);
  ok("the monitor DECODED the RedeemEvent from the live program", !!seen, seen ? `${seen.oz} oz` : "not found");
  if (seen) {
    ok("and attributed it to the right wallet", seen.user === user.publicKey.toBase58(), seen.user);
    ok(
      "and the USDC it reports matches what the user actually received",
      Math.abs(seen.usdcToUser * 1e6 - received) < 2,
      `reported ${seen.usdcToUser}, observed ${received / 1e6}`,
    );
    ok("and it charged a premium, so the fee basis is exercised too", seen.premiumBps > 0, `${seen.premiumBps}bps`);
  }
  ok(
    "the rolling-window budget it reads moved",
    quiet.report.effectiveUsedUsdc > before.report.effectiveUsedUsdc,
    `${before.report.effectiveUsedUsdc} -> ${quiet.report.effectiveUsedUsdc}`,
  );

  // A threshold this redemption clears, so the verdict must flip and the PROCESS must exit 1. Without
  // this the whole thing is a reporting tool that nobody would ever be woken by.
  const alarmed = runMonitor({ DOMINION_RPC: RPC, REDEEM_SCAN_LIMIT: "5", REDEEM_ALERT_SINGLE_PCT: "0.001" });
  ok("with a threshold it exceeds, the verdict is ALERT", alarmed.report.verdict === "ALERT", alarmed.report.verdict);
  ok("and the process EXITS 1, so a scheduler pages", alarmed.code === 1, `exit ${alarmed.code}`);
  ok(
    "and the alert names the redemption",
    alarmed.report.findings.some((f: any) => f.level === "alert" && /single redemption/.test(f.what)),
    alarmed.report.findings.map((f: any) => f.level).join(","),
  );

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
