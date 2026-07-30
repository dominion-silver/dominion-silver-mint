// Live devnet E2E: unpause the Lazer dominion program, then mint SILV with a
// REAL Pyth Lazer signed envelope (the real verify_message + signature + fee on
// chain). The definitive proof the migration works end-to-end.
//
// Run: PYTH_LAZER_KEY=... npx tsx scripts/e2e-lazer-mint.ts
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
  SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  getAccount, getMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import idl from "../target/idl/dominion_silver_mint.json";
import { lazerMessageData } from "../apps/public/src/lib/lazer-assembly";
import { assembleLazerOracleIxs, ED25519_IX_INDEX } from "../apps/public/src/lib/lazer-tx";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireDevnet, assertReversible, intentFromEnv } from "./_guard";

const RPC = "https://api.devnet.solana.com";
// Resolved, never hardcoded: this line held 2ujQg, the ORIGINAL retired program, and
// no gate caught it because 2ujQg was missing from the retired list too.
const PROGRAM_ID = SHARED_PROGRAM_ID;
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
// Read from the live config in main(): only the chain knows which mint a given
// program is bound to.
let SILV_MINT: PublicKey;
const LAZER_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
const LAZER_TREASURY = new PublicKey("opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7"); // devnet (mainnet: Gx4MBPb1...)
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];

async function fetchSilvEnvelope(): Promise<{ envelope: Uint8Array; priceUsd: number }> {
  const resp = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PYTH_LAZER_KEY}` },
    body: JSON.stringify({
      priceFeedIds: [3154], // Metal.Index.SILVER/USD (confirmed 2026-07-26)
      properties: ["price", "exponent", "publisherCount", "confidence", "feedUpdateTimestamp"],
      chains: ["solana"], channel: "fixed_rate@1000ms",
    }),
  });
  const j: any = await resp.json();
  if (!j?.solana?.data) throw new Error("no envelope: " + JSON.stringify(j).slice(0, 300));
  const f = j.parsed.priceFeeds[0];
  const priceUsd = Number(f.price) * Math.pow(10, Number(f.exponent));
  console.log("  SILV price: $" + priceUsd.toFixed(5),
    "| publishers:", f.publisherCount,
    "| feed_ts==ts:", f.feedUpdateTimestamp === Number(j.parsed.timestampUs));
  return { envelope: new Uint8Array(Buffer.from(j.solana.data, "base64")), priceUsd };
}

async function main() {
  // RULE 1 (scripts/_guard.ts): refuse any cluster but devnet unless
  // DOMINION_ALLOW_MAINNET is explicitly set.
  requireDevnet(RPC, "priced mint E2E");
  const INTENT = intentFromEnv();
  const conn = new Connection(RPC, "confirmed");
  const kpPath = process.env.DOMINION_KEYPAIR
    ?? [path.join(os.homedir(), ".config/solana/dominion-test-user.json"),
        path.join(os.homedir(), ".config/solana/dominion-dev.json")].find((p) => fs.existsSync(p));
  if (!kpPath) throw new Error("no keypair: set DOMINION_KEYPAIR");
  console.log("signer keypair:", kpPath);
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(idl as any, provider);
  const user = kp.publicKey;
  const configPda = pda("config");

  // 1. Config state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg: any = await (program.account as any).configAccount.fetch(configPda);
  SILV_MINT = cfg.silvMint as PublicKey;
  console.log("config: paused =", cfg.paused, "| feed =", cfg.pythLazerFeedId,
    "| minPublishers =", cfg.minPublishers, "| silvMint =", SILV_MINT.toBase58());

  // 2. Unpause if needed.
  if (cfg.paused) {
    const sig = await (program.methods as any).unpause().accounts({ config: configPda, admin: user }).rpc();
    console.log("unpaused:", sig);
  }

  // 3. Balances before.
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user, false, TOKEN_PROGRAM);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user, false, TOKEN_2022);
  const silvBefore = await getAccount(conn, userSilvAta, "confirmed", TOKEN_2022).then(a => Number(a.amount)).catch(() => 0);
  const usdcBefore = await getAccount(conn, userUsdcAta, "confirmed", TOKEN_PROGRAM).then(a => Number(a.amount));
  console.log("before: USDC", usdcBefore / 1e6, "| SILV", silvBefore / 1e6);

  // 4. Real SILV envelope.
  const { envelope, priceUsd } = await fetchSilvEnvelope();
  console.log("  envelope len:", envelope.length);
  // min_out from the envelope's OWN price + 0.5% slippage (proves the frontend fix:
  // a tight slippage no longer reverts because min_out matches the contract's price).
  const minSilvOut = Math.floor((10 / (priceUsd * 1.1)) * (1 - 50 / 10_000) * 1e6);
  console.log("  min_silv_out (0.5% slip @ envelope price):", minSilvOut / 1e6);

  // 5. Build the mint tx (mirrors buildLazerMintTx in lazer-tx.ts).
  const usdcTreasuryAta = getAssociatedTokenAddressSync(USDC_MINT, pda("treasury"), true, TOKEN_PROGRAM);
  const messageData = Buffer.from(lazerMessageData(envelope));
  const dominionIx = await (program.methods as any)
    .mintSilv(new anchor.BN(10_000_000), new anchor.BN(minSilvOut), messageData, ED25519_IX_INDEX, 0) // 10 USDC
    .accounts({
      config: configPda, user, usdcMint: USDC_MINT, silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta, userUsdcAta, userSilvAta,
      silvMintAuthority: pda("silv_mint_authority"),
      lazerProgram: LAZER_PROGRAM, lazerStorage: LAZER_STORAGE, lazerTreasury: LAZER_TREASURY,
      lazerFeePayer: pda("lazer_fee_payer"), instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      classicTokenProgram: TOKEN_PROGRAM, token2022Program: TOKEN_2022,
      associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId,
    })
    .instruction();

  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(user, userSilvAta, user, SILV_MINT, TOKEN_2022),
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM),
  ];
  // Same assembly as the frontend: [cb_limit, cb_price, ed25519, ...ataIxs, dominion].
  const tx = new Transaction().add(...assembleLazerOracleIxs(dominionIx, envelope, ataIxs));
  // Simulate first. A priced mint touches the ed25519 pre-instruction, the Lazer verify
  // CPI, the payload parse, the feed-id match and six policy guards before it moves a
  // single token, and a send-only failure surfaces as an opaque revert. Simulating first
  // prints the program logs, which name the guard that rejected it.
  tx.feePayer = user;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const presim = await conn.simulateTransaction(tx, [kp]);
  if (presim.value.err !== null) {
    console.log("\n  SIMULATION FAILED:", JSON.stringify(presim.value.err));
    for (const l of presim.value.logs ?? []) {
      if (/Program log:|invoke \[|[Ee]rror/.test(l)) console.log("   ", l.slice(0, 160));
    }
    throw new Error("mint would revert; see the logs above");
  }
  console.log("  simulation clean, CU:", presim.value.unitsConsumed);
  const sig = await provider.sendAndConfirm(tx, []);
  console.log("\n  ✅ MINT TX:", sig);

  // 6. Balances after.
  const silvAfter = Number((await getAccount(conn, userSilvAta, "confirmed", TOKEN_2022)).amount);
  const usdcAfter = Number((await getAccount(conn, userUsdcAta, "confirmed", TOKEN_PROGRAM)).amount);
  const supply = Number((await getMint(conn, SILV_MINT, "confirmed", TOKEN_2022)).supply);
  console.log("after:  USDC", usdcAfter / 1e6, "| SILV", silvAfter / 1e6, "| total supply", supply / 1e6);
  console.log("\n  USDC spent:", (usdcBefore - usdcAfter) / 1e6, "| SILV minted:", (silvAfter - silvBefore) / 1e6);
  if (silvAfter <= silvBefore) throw new Error("SILV did not increase");
  console.log("  ✅ MINT OK");

  // === REDEEM (instant) - validates the redeem account set on-chain too ===
  console.log("\n== Redeem 0.05 SILV (instant, fresh envelope) ==");
  const { envelope: redeemEnv, priceUsd: redeemPrice } = await fetchSilvEnvelope();
  const minUsdcOut = Math.floor(0.05 * redeemPrice * (1 - 200 / 10_000) * (1 - 50 / 10_000) * 1e6);
  console.log("  min_usdc_out (0.5% slip @ envelope price):", minUsdcOut / 1e6);
  // Redemptions are CLOSED at launch and `set_redemptions_enabled` refuses to enable
  // them in the deployed bytecode, so the redeem half of this script is unreachable
  // until the Phase 1 upgrade. Skip it rather than fail: the mint half is the part that
  // proves the oracle, and reporting a red run for a deliberately closed path trains
  // people to ignore the script.
  if (!cfg.redemptionsEnabled) {
    console.log("\n  SKIP redeem half: redemptions_enabled = false (closed at launch,");
    console.log("  and enabling is blocked on-chain until the Phase 1 upgrade).");
    console.log("\n  MINT PROVEN END TO END with a real signed Lazer envelope.");
    return;
  }

  const redeemMsg = Buffer.from(lazerMessageData(redeemEnv));
  const redeemIx = await (program.methods as any)
    .redeemSilv(new anchor.BN(50_000), new anchor.BN(minUsdcOut), redeemMsg, ED25519_IX_INDEX, 0) // 0.05 SILV
    .accounts({
      config: configPda, user, usdcMint: USDC_MINT, silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta, userUsdcAta, userSilvAta,
      treasuryPda: pda("treasury"),
      lazerProgram: LAZER_PROGRAM, lazerStorage: LAZER_STORAGE, lazerTreasury: LAZER_TREASURY,
      lazerFeePayer: pda("lazer_fee_payer"), instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      classicTokenProgram: TOKEN_PROGRAM, token2022Program: TOKEN_2022,
      associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId,
    })
    .instruction();
  const redeemAtas = [
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, USDC_MINT, TOKEN_PROGRAM),
  ];
  const redeemSig = await provider.sendAndConfirm(new Transaction().add(...assembleLazerOracleIxs(redeemIx, redeemEnv, redeemAtas)), []);
  console.log("  ✅ REDEEM TX:", redeemSig);
  const silvFinal = Number((await getAccount(conn, userSilvAta, "confirmed", TOKEN_2022)).amount);
  const usdcFinal = Number((await getAccount(conn, userUsdcAta, "confirmed", TOKEN_PROGRAM)).amount);
  console.log("  SILV burned:", (silvAfter - silvFinal) / 1e6, "| USDC received:", (usdcFinal - usdcAfter) / 1e6);
  if (usdcFinal <= usdcAfter) throw new Error("USDC did not increase on redeem");

  console.log("\n🎉 LAZER FULL-CYCLE E2E PASSED - mint + instant redeem with real signed SILV prices through the on-chain verify_message.");
}
main().catch((e) => { console.error("FAILED:", e.message || e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
