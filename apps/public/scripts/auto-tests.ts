/**
 * Automated integration tests against the deployed devnet program.
 *
 * Replicates the UI flow (postPythUpdate + buildMintTx/buildRedeemTx +
 * sign + send) using a Node-side Keypair instead of Phantom. Catches:
 *   - Contract logic bugs (every revert path)
 *   - anchor-client.ts encoding bugs (account derivation, args)
 *   - pyth-posting.ts bugs (close logic, signing)
 *   - simulate/send race conditions
 *
 * Doesn't catch (do these manually in the browser):
 *   - UI rendering, hover/click handlers
 *   - Wallet-adapter-specific Phantom quirks
 *   - localStorage cache behavior
 *
 * Run: cd /Users/thomasblanc/1_app/dominion && npx tsx scripts/auto-tests.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
  SystemProgram, type Signer,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Idl, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import fs from "fs";
import os from "os";

const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV = new PublicKey("AJxNZeX82pfDbiUXvbe442tX9Vz5XUnfsASvdvG3hNjn");
const FEED = "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

// Anchor error codes. Note: errors.rs declares Paused = 6000 explicitly,
// AND Anchor's #[error_code] macro adds another +6000 offset, so the actual
// on-chain codes are 12000+index_in_enum (NOT 6000+).
// Verified via earlier manual tests (BelowMinimum = 12002, etc).
const ERR = {
  Paused: 12000,
  MintPaused: 12001,
  BelowMinimum: 12002,
  AboveMaximum: 12003,
  StaleOracle: 12004,
  // ...
  InsufficientTreasury: 12014,
  TreasuryBelowReserve: 12015,
  DailyCapExceeded: 12016,
  HourlyRedeemCapExceeded: 12017,
  ArithmeticOverflow: 12018,
  ZeroAmount: 12019,
  // ...
  SlippageExceeded: 12024,
  // ...
  DayEpochMismatch: 12034,
  HourEpochMismatch: 12035,
} as const;

type TestResult = {
  name: string;
  expected: "success" | string; // error code or "success"
  actual: "success" | string;
  pass: boolean;
  notes?: string;
};

const results: TestResult[] = [];

// ---- helpers ----

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))),
  );
}

function makeAnchorWallet(kp: Keypair): Wallet {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: any) => { if (tx instanceof Transaction) tx.partialSign(kp); else tx.sign([kp]); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => { if (t instanceof Transaction) t.partialSign(kp); else t.sign([kp]); }); return txs; },
    payer: kp,
  };
}

function deriveAccounts(user: PublicKey) {
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PID);
  const [silvAuth] = PublicKey.findProgramAddressSync([Buffer.from("silv_mint_authority")], PID);
  const treasuryAta = getAssociatedTokenAddressSync(USDC, treasury, true, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC, user, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV, user, false, TOKEN_2022_PROGRAM_ID);
  const day = Math.floor(Date.now() / 1000 / 86400);
  const hour = Math.floor(Date.now() / 1000 / 3600);
  const dayBuf = Buffer.alloc(4); dayBuf.writeUInt32LE(day, 0);
  const hourBuf = Buffer.alloc(4); hourBuf.writeUInt32LE(hour, 0);
  const [daily] = PublicKey.findProgramAddressSync([Buffer.from("daily"), dayBuf], PID);
  const [hourly] = PublicKey.findProgramAddressSync([Buffer.from("hourly"), hourBuf], PID);
  return { config, treasury, silvAuth, treasuryAta, userUsdcAta, userSilvAta, daily, hourly, day, hour };
}

async function postPyth(c: Connection, user: Keypair, retries = 3): Promise<PublicKey> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const wallet = makeAnchorWallet(user);
      const hermes = new HermesClient("https://hermes.pyth.network");
      const updates = await hermes.getLatestPriceUpdates([FEED], { encoding: "base64" });
      const vaa = updates.binary.data[0];
      const receiver = new PythSolanaReceiver({ connection: c, wallet: wallet as any });
      const builder: any = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
      await builder.addPostPriceUpdates([vaa]);
      const priceUpdate = builder.getPriceUpdateAccount("0x" + FEED);
      const versioned: Array<{tx: any; signers: Signer[]}> = await builder.buildVersionedTransactions({computeUnitPriceMicroLamports:50000, tightComputeBudget:true});
      for (const v of versioned) {
        v.tx.sign([user, ...v.signers]);
        // skipPreflight: true to avoid devnet RPC flakes during preflight.
        const sig = await c.sendRawTransaction(v.tx.serialize(), { skipPreflight: true });
        await c.confirmTransaction(sig, "confirmed");
      }
      return priceUpdate;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

function parseAnchorErrorCode(errStr: string): number | null {
  // Looks for "custom program error: 0x...." OR "Error Number: NNNN".
  const hex = errStr.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const num = errStr.match(/Error Number:\s*(\d+)/);
  if (num) return parseInt(num[1], 10);
  return null;
}

// ---- test runner ----

async function run(name: string, expected: number | "success" | "skip", fn: () => Promise<void>) {
  process.stdout.write(`  ${name.padEnd(60, ".")}`);
  if (expected === "skip") {
    results.push({ name, expected: "skip", actual: "skip", pass: true, notes: "skipped (preconditions not met)" });
    console.log(" SKIP");
    return;
  }
  // Small delay between tests to avoid RPC rate limits on devnet public node.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    await fn();
    if (expected === "success") {
      results.push({ name, expected: "success", actual: "success", pass: true });
      console.log(" PASS (success as expected)");
    } else {
      results.push({ name, expected: String(expected), actual: "success", pass: false, notes: "expected revert, got success" });
      console.log(` FAIL (expected error ${expected}, got success)`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = parseAnchorErrorCode(msg);
    if (expected === "success") {
      results.push({ name, expected: "success", actual: code ? String(code) : msg.slice(0, 100), pass: false, notes: msg.slice(0, 200) });
      console.log(` FAIL (expected success, got ${code ?? msg.slice(0, 60)})`);
    } else if (code === expected) {
      results.push({ name, expected: String(expected), actual: String(code), pass: true });
      console.log(` PASS (revert ${code})`);
    } else {
      results.push({ name, expected: String(expected), actual: code ? String(code) : msg.slice(0, 100), pass: false, notes: msg.slice(0, 200) });
      console.log(` FAIL (expected ${expected}, got ${code ?? msg.slice(0, 60)})`);
    }
  }
}

// ---- tests ----

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const user = loadKeypair(os.homedir() + "/.config/solana/dominion-test-user.json");
  console.log("Test user:", user.publicKey.toBase58());

  const wallet = makeAnchorWallet(user);
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("../../target/idl/dominion_silver_mint.json", "utf8"));
  const program = new Program(idl as Idl, provider);
  const accs = deriveAccounts(user.publicKey);

  // Pre-flight checks: happy-path tests need balance, reverts work regardless.
  let userUsdcBal = await c.getTokenAccountBalance(accs.userUsdcAta).catch(() => null);
  let userSilvBal = await c.getTokenAccountBalance(accs.userSilvAta).catch(() => null);
  let usdcAmount = parseFloat(userUsdcBal?.value.uiAmountString ?? "0");
  let silvAmount = parseFloat(userSilvBal?.value.uiAmountString ?? "0");

  // Auto-top-up: if we don't have enough USDC for the mint tests but we DO
  // have enough SILV, redeem some SILV first. Saves the user from manually
  // sending USDC to the test wallet between runs.
  // Trigger threshold: USDC < 30 (we need ~25 USDC over the suite + buffer).
  if (usdcAmount < 30 && silvAmount >= 0.5) {
    console.log("Pre-test top-up: USDC low, redeeming 0.4 SILV to refill...");
    try {
      const priceUpdate = await postPyth(c, user);
      const ix = await (program.methods as any)
        .redeemSilv(new BN(400_000), new BN(0), accs.day, accs.hour) // 0.4 SILV
        .accounts({
          config: accs.config, daily: accs.daily, hourly: accs.hourly,
          user: user.publicKey, usdcMint: USDC, silvMint: SILV,
          usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
          treasuryPda: accs.treasury, priceUpdate,
          classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).instruction();
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
        createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
        ix,
      );
      tx.feePayer = user.publicKey;
      tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      tx.sign(user);
      const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await c.confirmTransaction(sig, "confirmed");
      console.log("  redeem confirmed:", sig);
      // Refresh balances.
      userUsdcBal = await c.getTokenAccountBalance(accs.userUsdcAta).catch(() => null);
      userSilvBal = await c.getTokenAccountBalance(accs.userSilvAta).catch(() => null);
      usdcAmount = parseFloat(userUsdcBal?.value.uiAmountString ?? "0");
      silvAmount = parseFloat(userSilvBal?.value.uiAmountString ?? "0");
    } catch (e) {
      console.log("  top-up failed (non-blocking):", e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80));
    }
  }

  // Also check hourly redeem cap: each redeem decrements treasury_at_hour_start
  // - redeemed_this_hour. If too much was redeemed this hour, the next redeem
  // will revert with HourlyRedeemCapExceeded regardless of the user's balance.
  const hourAi = await c.getAccountInfo(accs.hourly);
  let hourlyRemainingUsdc = Infinity;
  if (hourAi) {
    // Layout (after 8-byte disc): u32 hour_epoch | u64 redeemed | u64 treasury_at_start | Pubkey rent_payer
    const redeemed = Number(hourAi.data.readBigUInt64LE(12));
    const atStart = Number(hourAi.data.readBigUInt64LE(20));
    hourlyRemainingUsdc = (atStart - redeemed) / 1_000_000;
  }
  console.log("Pre-flight: user USDC =", usdcAmount, "| user SILV =", silvAmount, "| hourly redeem remaining =", hourlyRemainingUsdc === Infinity ? "no limit" : `~${hourlyRemainingUsdc.toFixed(2)} USDC`);
  const canHappyMint = usdcAmount >= 10;
  // Happy redeem needs >= 0.15 SILV AND > ~11 USDC of hourly cap remaining.
  const canHappyRedeem = silvAmount >= 0.15 && hourlyRemainingUsdc >= 12;
  if (!canHappyMint) console.log("  (happy mint will be SKIPPED: need USDC >= 10)");
  if (!canHappyRedeem) console.log("  (happy redeem will be SKIPPED: need SILV >= 0.15 AND hourly remaining >= 12 USDC)");
  console.log();

  console.log("=== Tier 1: bug-catcher tests ===\n");

  // T1.2 below minimum on mint (5 USDC < 10 USDC min).
  await run("T1.2 mint 5 USDC -> BelowMinimum", ERR.BelowMinimum, async () => {
    const priceUpdate = await postPyth(c, user);
    const ix = await (program.methods as any)
      .mintSilv(new BN(5_000_000), new BN(0), accs.day)
      .accounts({
        config: accs.config, daily: accs.daily,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        silvMintAuthority: accs.silvAuth, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sim = await c.simulateTransaction(tx);
    if (sim.value.err) throw new Error(JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).join(" "));
  });

  // T1.3 above max on mint.
  await run("T1.3 mint 10M USDC -> AboveMaximum", ERR.AboveMaximum, async () => {
    const priceUpdate = await postPyth(c, user);
    const ix = await (program.methods as any)
      .mintSilv(new BN("10000000000000"), new BN(0), accs.day) // 10M USDC raw
      .accounts({
        config: accs.config, daily: accs.daily,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        silvMintAuthority: accs.silvAuth, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sim = await c.simulateTransaction(tx);
    if (sim.value.err) throw new Error(JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).join(" "));
  });

  // T1.1a slippage on mint (min_silv_out impossibly high).
  await run("T1.1a mint with min_silv_out 100x -> SlippageExceeded", ERR.SlippageExceeded, async () => {
    const priceUpdate = await postPyth(c, user);
    const ix = await (program.methods as any)
      .mintSilv(new BN(10_000_000), new BN(100_000_000_000), accs.day) // 100k SILV expected (impossible)
      .accounts({
        config: accs.config, daily: accs.daily,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        silvMintAuthority: accs.silvAuth, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sim = await c.simulateTransaction(tx);
    if (sim.value.err) throw new Error(JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).join(" "));
  });

  // T1.1b slippage on redeem. Use 0.15 SILV (>= ~10 USDC equiv, above redeem
  // min) so the contract reaches the slippage check; then min_usdc_out = 100k
  // forces the SlippageExceeded revert.
  await run("T1.1b redeem 0.15 SILV with min_usdc_out 100x -> SlippageExceeded", ERR.SlippageExceeded, async () => {
    const priceUpdate = await postPyth(c, user);
    const ix = await (program.methods as any)
      .redeemSilv(new BN(150_000), new BN(100_000_000_000), accs.day, accs.hour) // 0.15 SILV burn, 100k USDC out (impossible)
      .accounts({
        config: accs.config, daily: accs.daily, hourly: accs.hourly,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        treasuryPda: accs.treasury, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sim = await c.simulateTransaction(tx);
    if (sim.value.err) throw new Error(JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).join(" "));
  });

  // T1.6 (renamed wrong day epoch) wrong day_epoch on mint.
  await run("T1.6 mint with day_epoch=0 -> DayEpochMismatch", ERR.DayEpochMismatch, async () => {
    const priceUpdate = await postPyth(c, user);
    const wrongDayBuf = Buffer.alloc(4); wrongDayBuf.writeUInt32LE(0, 0);
    const [wrongDailyPda] = PublicKey.findProgramAddressSync([Buffer.from("daily"), wrongDayBuf], PID);
    const ix = await (program.methods as any)
      .mintSilv(new BN(10_000_000), new BN(0), 0)
      .accounts({
        config: accs.config, daily: wrongDailyPda,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        silvMintAuthority: accs.silvAuth, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sim = await c.simulateTransaction(tx);
    if (sim.value.err) throw new Error(JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).join(" "));
  });

  // T1.0 happy path mint. Skipped if USDC balance < 10 (would drain wallet).
  await run("T1.0a mint 10 USDC -> success", canHappyMint ? "success" : "skip", async () => {
    const priceUpdate = await postPyth(c, user);
    const ix = await (program.methods as any)
      .mintSilv(new BN(10_000_000), new BN(100_000), accs.day) // min 0.1 SILV
      .accounts({
        config: accs.config, daily: accs.daily,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        silvMintAuthority: accs.silvAuth, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await c.confirmTransaction(sig, "confirmed");
  });

  // T1.0b happy path redeem. Skipped if SILV balance < 0.15.
  await run("T1.0b redeem 0.15 SILV -> success", canHappyRedeem ? "success" : "skip", async () => {
    const priceUpdate = await postPyth(c, user);
    const ix = await (program.methods as any)
      .redeemSilv(new BN(150_000), new BN(0), accs.day, accs.hour) // 0.15 SILV burn
      .accounts({
        config: accs.config, daily: accs.daily, hourly: accs.hourly,
        user: user.publicKey, usdcMint: USDC, silvMint: SILV,
        usdcTreasury: accs.treasuryAta, userUsdcAta: accs.userUsdcAta, userSilvAta: accs.userSilvAta,
        treasuryPda: accs.treasury, priceUpdate,
        classicTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, accs.userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
      ix,
    );
    tx.feePayer = user.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(user);
    const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await c.confirmTransaction(sig, "confirmed");
  });

  // ---- summary ----
  console.log();
  console.log("=== Summary ===");
  const passed = results.filter((r) => r.pass && r.expected !== "skip").length;
  const skipped = results.filter((r) => r.expected === "skip").length;
  const failed = results.filter((r) => !r.pass);
  console.log(`${passed} passed | ${failed.length} failed | ${skipped} skipped (out of ${results.length})`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) {
      console.log(`  - ${f.name}`);
      console.log(`    expected: ${f.expected} | actual: ${f.actual}`);
      if (f.notes) console.log(`    notes: ${f.notes}`);
    }
    process.exit(1);
  }
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
