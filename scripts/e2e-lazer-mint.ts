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

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2ujQgKtxvaU9Ax3jL22374SypSyTR9J4yztqYkX23oMT");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV_MINT = new PublicKey("5xiznEZfDRYojUL1WD2amruBZHonHphViH1SdnefyFx");
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
      priceFeedIds: [3304],
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
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/dominion-test-user.json"), "utf8"))));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(idl as any, provider);
  const user = kp.publicKey;
  const configPda = pda("config");

  // 1. Config state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg: any = await (program.account as any).configAccount.fetch(configPda);
  console.log("config: paused =", cfg.paused, "| feed =", cfg.pythLazerFeedId, "| minPublishers =", cfg.minPublishers);

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
