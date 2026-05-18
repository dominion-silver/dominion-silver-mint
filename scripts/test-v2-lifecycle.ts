/**
 * V2 FULL USER LIFECYCLE - live devnet, real money flow.
 *
 * Exercises the paths that the admin/security test (test-v2-devnet.ts) could
 * NOT: mint -> instant redeem -> forced-queue redeem -> claim -> admin OTC
 * settle, with real USDC + SILV moving on-chain. Uses:
 *   - test user keypair  ~/.config/solana/dominion-test-user.json  (the "user")
 *   - deployer keypair    ~/.config/solana/dominion-dev.json        (admin tuning)
 *
 * The automated Pyth post+consume flow fits well inside max_staleness=15s
 * (~3s measured) since there is no human popup latency, so mint/instant-
 * redeem/claim ARE testable now (probe-mint-pyth.ts proved this).
 *
 * Admin instant-setters (NO timelock) are used to make the queue/claim path
 * testable in one session, then RESTORED to §6 defaults at the end.
 *
 * Run from the dominion root:
 *   PATH="<solana-bin>:$PATH" node_modules/.bin/tsx scripts/test-v2-lifecycle.ts
 *
 * All deps resolve from apps/public/node_modules (single web3.js instance,
 * shared with the Pyth SDK).
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";

const APUB = "/Users/thomasblanc/1_app/dominion/apps/public/";
const r = createRequire(APUB);
/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} = r("@solana/web3.js");
const anchor = r("@coral-xyz/anchor");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = r("@solana/spl-token");
const { HermesClient } = r("@pythnetwork/hermes-client");
const { PythSolanaReceiver } = r("@pythnetwork/pyth-solana-receiver");
const { BN } = anchor;

const RPC = "https://api.devnet.solana.com";
const PID = new PublicKey("GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV = new PublicKey("4bNYnE1d8XV1W4iJuWVqmxVi5qqvAopvxekifDVvB4Ew");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATAP = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const XAG = "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

const seed = (s: string) =>
  PublicKey.findProgramAddressSync([Buffer.from(s)], PID)[0];
const CFG = seed("config");
const TRE = seed("treasury");
const SMA = seed("silv_mint_authority");

function reqPda(owner: any, nonce: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(nonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redeem_request"), owner.toBuffer(), b],
    PID,
  )[0];
}

let pass = 0,
  fail = 0;
const fails: string[] = [];
function ok(label: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${extra ? " :: " + extra : ""}`);
  } else {
    fail++;
    fails.push(label);
    console.log(`  FAIL  ${label}${extra ? " :: " + extra : ""}`);
  }
}

async function send(conn: any, tx: any, signers: any[]) {
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

/** Post a fresh Pyth XAG price update; returns the priceUpdate pubkey. */
async function postPyth(conn: any, payer: any) {
  const hermes = new HermesClient("https://hermes.pyth.network");
  const upd = await hermes.getLatestPriceUpdates([XAG], { encoding: "base64" });
  const vaa = upd.binary.data[0];
  const px = upd.parsed?.[0]?.price;
  const wallet = new anchor.Wallet(payer);
  const recv = new PythSolanaReceiver({ connection: conn, wallet });
  const b = recv.newTransactionBuilder({ closeUpdateAccounts: false });
  await b.addPostPriceUpdates([vaa]);
  const priceUpdate = (b as any).getPriceUpdateAccount("0x" + XAG);
  const bundles = await b.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: true,
  });
  for (const bd of bundles) {
    bd.tx.sign([payer, ...(bd.signers as any[])]);
    const sig = await conn.sendRawTransaction(bd.tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    const bh = bd.tx.message.recentBlockhash;
    const { lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction(
      { signature: sig, blockhash: bh, lastValidBlockHeight },
      "confirmed",
    );
  }
  // oracle price scaled to 1e9 (PRICE_SCALE); Hermes gives price*10^expo
  const oracle = Number(px.price) * Math.pow(10, px.expo);
  return { priceUpdate, oraclePriceUsd: oracle };
}

async function tokBal(conn: any, ata: any): Promise<bigint> {
  try {
    const b = await conn.getTokenAccountBalance(ata);
    return BigInt(b.value.amount);
  } catch {
    return 0n;
  }
}

async function main() {
  const user = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          os.homedir() + "/.config/solana/dominion-test-user.json",
          "utf8",
        ),
      ),
    ),
  );
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          os.homedir() + "/.config/solana/dominion-dev.json",
          "utf8",
        ),
      ),
    ),
  );
  const conn = new Connection(RPC, "confirmed");
  const program = new anchor.Program(
    JSON.parse(
      fs.readFileSync(APUB + "src/lib/idl/dominion_silver_mint.json", "utf8"),
    ),
    new anchor.AnchorProvider(conn, new anchor.Wallet(user), {
      commitment: "confirmed",
    }),
  );
  const m = program.methods as any;
  const cfg = () => (program.account as any).configAccount.fetch(CFG);

  const userUsdc = getAssociatedTokenAddressSync(USDC, user.publicKey, false, TOKEN);
  const userSilv = getAssociatedTokenAddressSync(SILV, user.publicKey, false, T22);
  const treUsdc = getAssociatedTokenAddressSync(USDC, TRE, true, TOKEN);

  console.log("V2 FULL LIFECYCLE - live devnet");
  console.log("user :", user.publicKey.toBase58());
  console.log("admin:", admin.publicKey.toBase58());

  // ---- A. snapshot ----
  console.log("\n[A] baseline snapshot");
  const c0 = await cfg();
  const uUsdc0 = await tokBal(conn, userUsdc);
  const uSilv0 = await tokBal(conn, userSilv);
  const tre0 = await tokBal(conn, treUsdc);
  const sup0 = BigInt((await conn.getTokenSupply(SILV)).value.amount);
  console.log(
    `  user USDC=${uUsdc0} SILV=${uSilv0} | treasury USDC=${tre0} | supply=${sup0} | nonce=${c0.nextRedeemRequestNonce} | threshold=${c0.largeRedeemThresholdUsdc} delay=${c0.redeemQueueDelaySeconds} redemptions=${c0.redemptionsEnabled}`,
  );
  ok("redemptions enabled at start", c0.redemptionsEnabled === true);
  ok("not paused", c0.paused === false);

  const adminA = { config: CFG, admin: admin.publicKey };

  // ---- B. MINT (Pyth) ----
  console.log("\n[B] mint 15 USDC -> SILV (Pyth flow)");
  const mintUsdc = 15_000_000n;
  const { priceUpdate: puB, oraclePriceUsd } = await postPyth(conn, user);
  console.log(`  oracle XAG ~ $${oraclePriceUsd.toFixed(4)}/oz`);
  {
    const ix = await m
      .mintSilv(new BN(mintUsdc.toString()), new BN(0))
      .accounts({
        config: CFG,
        user: user.publicKey,
        usdcMint: USDC,
        silvMint: SILV,
        usdcTreasury: treUsdc,
        userUsdcAta: userUsdc,
        userSilvAta: userSilv,
        silvMintAuthority: SMA,
        priceUpdate: puB,
        classicTokenProgram: TOKEN,
        token2022Program: T22,
        associatedTokenProgram: ATAP,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey, userSilv, user.publicKey, SILV, T22),
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey, userUsdc, user.publicKey, USDC, TOKEN),
      ix,
    );
    await send(conn, tx, [user]);
  }
  const uUsdc1 = await tokBal(conn, userUsdc);
  const uSilv1 = await tokBal(conn, userSilv);
  const tre1 = await tokBal(conn, treUsdc);
  const sup1 = BigInt((await conn.getTokenSupply(SILV)).value.amount);
  const silvOut = uSilv1 - uSilv0;
  ok("user USDC decreased by exactly 15", uUsdc0 - uUsdc1 === mintUsdc, `${uUsdc0 - uUsdc1}`);
  ok("user SILV increased", silvOut > 0n, `+${silvOut}`);
  ok("treasury USDC increased by exactly 15", tre1 - tre0 === mintUsdc, `${tre1 - tre0}`);
  ok("global SILV supply increased by silv_out", sup1 - sup0 === silvOut, `${sup1 - sup0}`);
  // effective mint price = oracle*1.10 (premium 1000 bps); silv_out = floor(usdc/price)
  const effMint = oraclePriceUsd * 1.1;
  const expSilv = Math.floor((15 / effMint) * 1e6);
  ok("silv_out within rounding of oracle*1.10 model", Math.abs(Number(silvOut) - expSilv) <= 2, `got ${silvOut} exp ~${expSilv}`);

  // ---- C. INSTANT redeem (Pyth) - small, under default $5000 threshold ----
  console.log("\n[C] instant redeem 0.01 SILV (Pyth, under threshold+budget, treasury covers)");
  const cC = await cfg();
  ok("large_redeem_threshold is high ($5000 default) so small redeem = instant", BigInt(cC.largeRedeemThresholdUsdc) >= 1_000_000_000n);
  const redInstant = 10_000n; // 0.01 SILV
  const { priceUpdate: puC } = await postPyth(conn, user);
  {
    const ix = await m
      .redeemSilv(new BN(redInstant.toString()), new BN(0))
      .accounts({
        config: CFG,
        user: user.publicKey,
        usdcMint: USDC,
        silvMint: SILV,
        usdcTreasury: treUsdc,
        userUsdcAta: userUsdc,
        userSilvAta: userSilv,
        treasuryPda: TRE,
        priceUpdate: puC,
        classicTokenProgram: TOKEN,
        token2022Program: T22,
        associatedTokenProgram: ATAP,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey, userUsdc, user.publicKey, USDC, TOKEN),
      ix,
    );
    await send(conn, tx, [user]);
  }
  const uUsdc2 = await tokBal(conn, userUsdc);
  const uSilv2 = await tokBal(conn, userSilv);
  const tre2 = await tokBal(conn, treUsdc);
  const sup2 = BigInt((await conn.getTokenSupply(SILV)).value.amount);
  const usdcOutC = uUsdc2 - uUsdc1;
  ok("user SILV decreased by exactly 0.01", uSilv1 - uSilv2 === redInstant, `${uSilv1 - uSilv2}`);
  ok("user USDC increased (instant payout)", usdcOutC > 0n, `+${usdcOutC}`);
  ok("treasury USDC decreased by the payout", tre1 - tre2 === usdcOutC, `${tre1 - tre2}`);
  ok("global supply decreased by the burned 0.01", sup1 - sup2 === redInstant, `${sup1 - sup2}`);
  const cC2 = await cfg();
  ok("instant_used_usdc reflects the instant payout", BigInt(cC2.instantUsedUsdc) >= usdcOutC, `${cC2.instantUsedUsdc}`);
  ok("instant_window_start set (non-zero after first instant)", BigInt(cC2.instantWindowStart) > 0n);

  // ---- D. FORCED-QUEUE redeem (no Pyth) ----
  console.log("\n[D] forced-queue redeem (admin lowers threshold to $0.10 + queue delay 0)");
  await send(conn,
    new Transaction().add(
      await m.setLargeRedeemThreshold(new BN(100_000)).accounts(adminA).instruction()),
    [admin]);
  await send(conn,
    new Transaction().add(
      await m.setRedeemQueueDelay(0).accounts(adminA).instruction()),
    [admin]);
  const cD0 = await cfg();
  ok("threshold lowered to $0.10", BigInt(cD0.largeRedeemThresholdUsdc) === 100_000n, `${cD0.largeRedeemThresholdUsdc}`);
  ok("queue delay set to 0", cD0.redeemQueueDelaySeconds === 0, `${cD0.redeemQueueDelaySeconds}`);
  const nonceD = BigInt(cD0.nextRedeemRequestNonce.toString());
  const reqD = reqPda(user.publicKey, nonceD);
  const redQ = 20_000n; // 0.02 SILV, worth > $0.10 -> forced queue
  {
    const ix = await m
      .redeemSilvQueued(new BN(redQ.toString()), new BN(nonceD.toString()))
      .accounts({
        config: CFG,
        user: user.publicKey,
        silvMint: SILV,
        userSilvAta: userSilv,
        redemptionRequest: reqD,
        token2022Program: T22,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await send(conn, new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix), [user]);
  }
  const uSilv3 = await tokBal(conn, userSilv);
  const sup3 = BigInt((await conn.getTokenSupply(SILV)).value.amount);
  const reqAccD = await (program.account as any).redemptionRequest.fetch(reqD);
  ok("user SILV burned now (down 0.02)", uSilv2 - uSilv3 === redQ, `${uSilv2 - uSilv3}`);
  ok("global supply down by the burned 0.02 (burn at request)", sup2 - sup3 === redQ, `${sup2 - sup3}`);
  ok("RedemptionRequest created Pending", Object.keys(reqAccD.status)[0] === "pending");
  ok("request.amount_silv correct", BigInt(reqAccD.amountSilv) === redQ, `${reqAccD.amountSilv}`);
  ok("request.owner = user", reqAccD.owner.toBase58() === user.publicKey.toBase58());
  ok("request.nonce matches", BigInt(reqAccD.nonce) === nonceD, `${reqAccD.nonce}`);
  const cD1 = await cfg();
  ok("config.next_redeem_request_nonce incremented", BigInt(cD1.nextRedeemRequestNonce) === nonceD + 1n);

  // ---- E. CLAIM (Pyth, delay 0 so claimable now) ----
  console.log("\n[E] claim the queued request (Pyth priced at claim, treasury covers)");
  const uUsdc3 = await tokBal(conn, userUsdc);
  const tre3 = await tokBal(conn, treUsdc);
  const sup3b = BigInt((await conn.getTokenSupply(SILV)).value.amount);
  const { priceUpdate: puE } = await postPyth(conn, user);
  {
    const ix = await m
      .claimRedemption()
      .accounts({
        config: CFG,
        owner: user.publicKey,
        redemptionRequest: reqD,
        usdcMint: USDC,
        usdcTreasury: treUsdc,
        ownerUsdcAta: userUsdc,
        treasuryPda: TRE,
        priceUpdate: puE,
        classicTokenProgram: TOKEN,
        associatedTokenProgram: ATAP,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey, userUsdc, user.publicKey, USDC, TOKEN),
      ix,
    );
    await send(conn, tx, [user]);
  }
  const uUsdc4 = await tokBal(conn, userUsdc);
  const tre4 = await tokBal(conn, treUsdc);
  const sup4 = BigInt((await conn.getTokenSupply(SILV)).value.amount);
  const claimOut = uUsdc4 - uUsdc3;
  ok("user USDC increased (claim payout)", claimOut > 0n, `+${claimOut}`);
  ok("treasury decreased by the claim payout", tre3 - tre4 === claimOut, `${tre3 - tre4}`);
  ok("supply UNCHANGED at claim (SILV was burned at request)", sup4 === sup3b, `${sup4} vs ${sup3b}`);
  const reqClosed = await (program.account as any).redemptionRequest.fetchNullable(reqD);
  ok("request account closed on successful claim (rent returned)", reqClosed === null);

  // ---- F. QUEUE + admin OTC settle ----
  console.log("\n[F] queue another request -> admin_settle_redemption_offchain");
  const cF0 = await cfg();
  const nonceF = BigInt(cF0.nextRedeemRequestNonce.toString());
  const reqF = reqPda(user.publicKey, nonceF);
  const redF = 15_000n; // 0.015 SILV
  {
    const ix = await m
      .redeemSilvQueued(new BN(redF.toString()), new BN(nonceF.toString()))
      .accounts({
        config: CFG,
        user: user.publicKey,
        silvMint: SILV,
        userSilvAta: userSilv,
        redemptionRequest: reqF,
        token2022Program: T22,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await send(conn, new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix), [user]);
  }
  const reqAccF0 = await (program.account as any).redemptionRequest.fetch(reqF);
  ok("F request Pending before settle", Object.keys(reqAccF0.status)[0] === "pending");
  {
    const ix = await m
      .adminSettleRedemptionOffchain()
      .accounts({ config: CFG, admin: admin.publicKey, redemptionRequest: reqF })
      .instruction();
    await send(conn, new Transaction().add(ix), [admin]);
  }
  const reqAccF1 = await (program.account as any).redemptionRequest.fetch(reqF);
  ok("admin_settle flipped status Pending -> SettledOffchain",
    Object.keys(reqAccF1.status)[0] === "settledOffchain",
    Object.keys(reqAccF1.status)[0]);
  ok("settled request NOT closed (durable record, no USDC paid)", reqAccF1 !== null);
  // negative: claiming a settled request must now revert RequestNotPending
  try {
    const { priceUpdate: puNeg } = await postPyth(conn, user);
    const ix = await m.claimRedemption().accounts({
      config: CFG, owner: user.publicKey, redemptionRequest: reqF,
      usdcMint: USDC, usdcTreasury: treUsdc, ownerUsdcAta: userUsdc,
      treasuryPda: TRE, priceUpdate: puNeg, classicTokenProgram: TOKEN,
      associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
    }).instruction();
    await send(conn, new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix), [user]);
    ok("claiming a SettledOffchain request reverts", false, "did NOT revert");
  } catch (e: any) {
    const t = (e?.message ?? "") + (e?.logs ?? []).join("");
    ok("claiming a SettledOffchain request reverts RequestNotPending",
      /RequestNotPending|custom program error/i.test(t));
  }

  // ---- G. restore §6 defaults ----
  console.log("\n[G] restore params to §6 defaults");
  await send(conn, new Transaction().add(
    await m.setLargeRedeemThreshold(new BN(5_000_000_000)).accounts(adminA).instruction()), [admin]);
  await send(conn, new Transaction().add(
    await m.setRedeemQueueDelay(259_200).accounts(adminA).instruction()), [admin]);
  const cG = await cfg();
  ok("large_redeem_threshold restored to $5000", BigInt(cG.largeRedeemThresholdUsdc) === 5_000_000_000n, `${cG.largeRedeemThresholdUsdc}`);
  ok("redeem_queue_delay restored to 259200 (T+3)", cG.redeemQueueDelaySeconds === 259_200, `${cG.redeemQueueDelaySeconds}`);
  ok("redemptions still enabled", cG.redemptionsEnabled === true);
  ok("not paused", cG.paused === false);

  console.log(`\n==== LIFECYCLE RESULT: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) {
    console.log("FAILURES:\n - " + fails.join("\n - "));
    process.exit(1);
  }
  console.log(
    "Money-flow verified live: mint, instant redeem, forced-queue (burn-at-request), claim (price-at-claim, supply unchanged, account closed), admin OTC settle (+ settled-claim revert). Params restored to §6.",
  );
  console.log(
    "NOTE: InsufficientTreasury/OTC-routing not independently triggered: a single self-funded wallet can't drain the treasury below its own redeem value (mint premium 10% > redeem fee 2% => USDC paid in always exceeds USDC redeemable out; the only drains are the 24h-timelocked admin withdraw or OTHER users). The guard is the SAME `require!(usdc_treasury.amount >= usdc_out)` exercised structurally in the (passing) instant + claim paths; the admin OTC-settle instruction that resolves such IOUs IS fully tested live above.",
  );
}

main().catch((e) => {
  console.error("FATAL", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
