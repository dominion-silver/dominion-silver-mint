/**
 * Fund the redemption treasury by calling `deposit_usdc`.
 *
 * WHY A SCRIPT AND NOT A WALLET TRANSFER, which is the whole point of this file.
 *
 * `config.usdc_treasury` is a TOKEN ACCOUNT, not a wallet address. Paste it into a wallet's "send
 * USDC to" field, or into an exchange withdrawal form, and the tool treats it as the recipient
 * OWNER and derives an associated token account from it. The funds then land in a token account
 * owned by a token account, which can sign nothing and has no close authority. They are gone.
 *
 * So the safe shape is two steps: USDC arrives at a NORMAL wallet address (the deployer, which any
 * exchange accepts), and this script moves it into the treasury through the program's own
 * instruction. `deposit_usdc` pins `usdc_mint` and `usdc_treasury` with `address =` constraints, so
 * account confusion is rejected on chain rather than trusted here, and it emits `TreasuryDeposit`
 * with the actual pre/post delta so the deposit leaves an event trail. A raw SPL transfer would move
 * the same tokens and emit nothing.
 *
 * WHY THE TREASURY NEEDS FUNDING AT ALL. `redeem_silv` pays the user from this account
 * (`redeem_silv.rs:276` reads its balance, 311 and 325 transfer out of it). Minting is what normally
 * fills it, but pre-minted SILV sold OTC or seeded into a DEX pool reaches holders WITHOUT the
 * matching USDC ever entering the treasury. Those holders can still redeem. On 2026-08-13 the
 * treasury held 17.80 USDC against a configured `instant_redeem_budget_usdc` of 20,000 per 24h, so
 * the instant path would have died two orders of magnitude below its own ceiling.
 *
 * Getting it back out is `propose_withdraw_usdc` then `execute_withdraw_usdc`: a 24h timelock
 * (`admin_timelock_seconds`) plus a 3-of-5 on each leg. Not a one-way door, but not same-day cash.
 *
 * Run:
 *   DOMINION_RPC=... DOMINION_ALLOW_MAINNET=i-understand DOMINION_INTENT=deposit_usdc \
 *     npx tsx scripts/deposit-treasury-usdc.ts --amount 20000
 *
 * `--amount` is in WHOLE USDC, not atomic units, because the 1e6 mistake here is a 1,000,000x error
 * and the argument a human types should be the number a human means. `--dry-run` simulates and sends
 * nothing.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import os from "os";
import path from "path";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { resolveCluster } from "./_cluster";
import { redactRpc } from "./_redact";

const CLUSTER = resolveCluster();

/** The program's own floor, `MIN_DEPOSIT_USDC` in deposit_usdc.rs. Refused here so the revert is a message. */
const MIN_DEPOSIT_WHOLE_USDC = 1;

function payerKeypair(): Keypair {
  const p = (
    process.env.DOMINION_KEYPAIR || path.join(os.homedir(), ".config", "solana", "dominion-dev.json")
  ).replace(/^~/, os.homedir());
  if (!fs.existsSync(p)) throw new Error(`keypair not found at ${p}`);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function parseArgs(): { whole: number; dryRun: boolean } {
  const a = process.argv.slice(2);
  const i = a.indexOf("--amount");
  const raw = i >= 0 ? a[i + 1] : undefined;
  if (!raw) throw new Error("--amount is required, in WHOLE USDC (e.g. --amount 20000)");
  const whole = Number(raw);
  if (!Number.isFinite(whole) || whole <= 0) throw new Error(`--amount must be a positive number, got ${raw}`);
  // Reject more decimals than USDC has, rather than silently truncating someone's money.
  if (Math.round(whole * 1e6) !== whole * 1e6) {
    throw new Error(`--amount ${raw} has more than 6 decimal places, which USDC cannot represent`);
  }
  if (whole < MIN_DEPOSIT_WHOLE_USDC) {
    throw new Error(`deposit_usdc refuses below ${MIN_DEPOSIT_WHOLE_USDC} USDC (MIN_DEPOSIT_USDC)`);
  }
  return { whole, dryRun: a.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { whole, dryRun } = parseArgs();
  const atomic = BigInt(Math.round(whole * 1e6));

  await requireSanctionedCluster(CLUSTER.rpc, "deposit-treasury-usdc");
  // Classified in ACTION_COST. Undoing a deposit is `propose_withdraw_usdc` + `execute_withdraw_usdc`,
  // a 24h window and a 3-of-5 on each leg, so it is timelocked-undo and not reversible.
  if (!dryRun) assertReversible("deposit_usdc", intentFromEnv());

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const payer = payerKeypair();
  const program = new Program(
    loadIdl() as Idl,
    new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" }),
  );
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
  const cfg = (await (
    program.account as never as Record<string, { fetch: (k: PublicKey) => Promise<Record<string, unknown>> }>
  ).configAccount.fetch(configPda)) as Record<string, unknown>;

  const usdcMint = new PublicKey(String(cfg.usdcMint));
  const treasury = new PublicKey(String(cfg.usdcTreasury));
  const userAta = getAssociatedTokenAddressSync(usdcMint, payer.publicKey, false, TOKEN_PROGRAM_ID);

  console.log("deposit treasury USDC");
  console.log(`  cluster   : ${redactRpc(CLUSTER.rpc)} (${CLUSTER.cluster})`);
  console.log(`  depositor : ${payer.publicKey.toBase58()}`);
  console.log(`  USDC mint : ${usdcMint.toBase58()}`);
  console.log(`  treasury  : ${treasury.toBase58()}`);
  console.log(`  amount    : ${whole} USDC = ${atomic} atomic`);
  console.log("");

  // REFUSALS, all of them before a lamport moves.

  // The treasury must be what the CHAIN says it is, and must be the right mint. The program enforces
  // both with `address =` constraints; checking here turns a revert into a sentence.
  const treAcct = await getAccount(conn, treasury, "finalized", TOKEN_PROGRAM_ID);
  if (!treAcct.mint.equals(usdcMint)) {
    throw new Error(`treasury ${treasury.toBase58()} holds mint ${treAcct.mint.toBase58()}, not ${usdcMint.toBase58()}`);
  }
  const treasuryPda = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID)[0];
  if (!treAcct.owner.equals(treasuryPda)) {
    throw new Error(
      `treasury owner is ${treAcct.owner.toBase58()}, expected the treasury PDA ${treasuryPda.toBase58()}. ` +
        `Refusing: an account not owned by the program cannot pay redemptions.`,
    );
  }
  if (treAcct.isFrozen) throw new Error("the treasury token account is FROZEN; a deposit would be stuck");

  // The depositor must actually hold the USDC.
  let held = BigInt(0);
  try {
    held = (await getAccount(conn, userAta, "finalized", TOKEN_PROGRAM_ID)).amount;
  } catch {
    throw new Error(
      `${payer.publicKey.toBase58()} has no USDC account (${userAta.toBase58()}). ` +
        `Send USDC to the WALLET address first; it is created on receipt.`,
    );
  }
  if (held < atomic) {
    throw new Error(
      `depositor holds ${Number(held) / 1e6} USDC, needs ${whole}. Short by ${(Number(atomic - held) / 1e6).toFixed(6)}.`,
    );
  }

  const before = treAcct.amount;
  console.log(`  treasury before : ${(Number(before) / 1e6).toFixed(6)} USDC`);
  console.log(`  depositor holds : ${(Number(held) / 1e6).toFixed(6)} USDC`);

  const ix = await (program.methods as never as Record<string, (a: BN) => { accounts: (a: Record<string, PublicKey>) => { instruction: () => Promise<never> } }>)
    .depositUsdc(new BN(atomic.toString()))
    .accounts({
      config: configPda,
      user: payer.publicKey,
      usdcMint,
      usdcTreasury: treasury,
      userUsdcAta: userAta,
      classicTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // SIMULATE FIRST, always. The program pins two accounts and enforces a floor; a simulation names
  // which one rejected, where a send-only failure is an opaque custom error code.
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix as never],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.log(`\n  SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
    for (const l of sim.value.logs ?? []) if (/Error|error|failed/.test(l)) console.log(`    ${l}`);
    throw new Error("refusing to send: the simulation failed");
  }
  console.log(`  simulation OK, CU ${sim.value.unitsConsumed}`);

  if (dryRun) {
    console.log("\n  --dry-run: nothing sent.");
    return;
  }

  vtx.sign([payer]);
  const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
  console.log(`\n  sent: ${sig}`);

  // CONFIRM THE TRANSACTION AT FINALIZED BEFORE READING ANY BALANCE. Five false negatives in this
  // repo came from reading state at `confirmed` immediately after a send on a load-balanced endpoint,
  // and two of them looked like outright failures on writes that had succeeded. On timeout this says
  // DO NOT RE-SEND, because the wrong guess there is a double deposit.
  let landed = false;
  for (let i = 0; i < 40; i++) {
    const tx = await conn.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (tx) {
      if (tx.meta?.err) throw new Error(`deposit FAILED on chain: ${JSON.stringify(tx.meta.err)}`);
      console.log(`  finalized, slot ${tx.slot}`);
      landed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!landed) throw new Error(`not finalized after 120s. DO NOT RE-SEND. Inspect ${sig} by hand.`);

  const after = (await getAccount(conn, treasury, "finalized", TOKEN_PROGRAM_ID)).amount;
  const delta = after - before;
  console.log(`  treasury after  : ${(Number(after) / 1e6).toFixed(6)} USDC  (+${(Number(delta) / 1e6).toFixed(6)})`);
  if (delta !== atomic) {
    throw new Error(`the treasury moved by ${Number(delta) / 1e6} USDC, expected ${whole}. Investigate before depositing again.`);
  }
  console.log(`\n  https://solscan.io/tx/${sig}`);
}

main().catch((e) => {
  console.error(`\ndeposit-treasury-usdc FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
