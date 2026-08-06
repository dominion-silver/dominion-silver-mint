// Live devnet E2E: unpause the Lazer dominion program, then mint and redeem SILV with a REAL Pyth
// Lazer signed envelope (the real verify_message + signature + fee on chain).
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
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";

// RPC, program id, USDC mint and Lazer treasury are RESOLVED, never hardcoded: this script sends, so
// a devnet literal would sign devnet transactions with a mainnet key while looking like a mainnet test.
const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;
const PROGRAM_ID = SHARED_PROGRAM_ID;
const USDC_MINT = CLUSTER.usdcMint;
// Read from the live config in main(): only the chain knows which mint a given
// program is bound to.
let SILV_MINT: PublicKey;
const LAZER_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
const LAZER_TREASURY = CLUSTER.lazerTreasury;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
/** A PDA with a second seed, e.g. the per-wallet fee-exempt account. */
const pda2 = (seed: string, extra: Uint8Array) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), Buffer.from(extra)], PROGRAM_ID)[0];

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

// The four fee/KYC accounts, resolved the SAME way the app resolves them. Optional accounts MUST be
// explicit null when absent: `.accounts()` is not strict in Anchor 0.31.1 (it delegates to
// accountsPartial), so omitting one makes the resolver DERIVE the PDA from the IDL seeds and pass a
// real address for an uninitialised account, which reverts AccountNotInitialized. Omission is also
// invisible to verify-client-idl-parity.ts, which can only validate the keys that ARE present.
const feeVaultPda = pda("fee_vault");
const feeVaultAta = getAssociatedTokenAddressSync(USDC_MINT, feeVaultPda, true, TOKEN_PROGRAM);
async function walletFlagAccounts(conn: anchor.web3.Connection, wallet: PublicKey) {
  const fe = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_exempt"), wallet.toBuffer()], PROGRAM_ID)[0];
  const ky = PublicKey.findProgramAddressSync(
    [Buffer.from("kyc"), wallet.toBuffer()], PROGRAM_ID)[0];
  const infos = await conn.getMultipleAccountsInfo([fe, ky]);
  // OWNER + DISCRIMINATOR, not mere existence. Creating an account at a PDA address is
  // permissionless (a one-lamport transfer to feeExemptPda(wallet) leaves a System-owned account
  // there), and passing that address makes the program revert on the owner check.
  const disc = (name: string) =>
    Uint8Array.from(
      ((idl as any).accounts.find((a: any) => a.name === name)).discriminator as number[],
    );
  const ok = (info: any, d: Uint8Array) =>
    !!info &&
    info.owner.equals(PROGRAM_ID) &&
    info.data.length >= 8 &&
    d.every((b, i) => info.data[i] === b);
  return {
    feeExempt: ok(infos[0], disc("FeeExemptAccount")) ? fe : null,
    kyc: ok(infos[1], disc("KycAccount")) ? ky : null,
  };
}

async function main() {
  // RULE 1 (_guard.ts): refuse any cluster but devnet unless DOMINION_ALLOW_MAINNET is set.
  await requireSanctionedCluster(RPC, "priced mint E2E");
  console.log("  " + describeCluster(CLUSTER));
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
  // min_out from the envelope's OWN price, 0.5% slippage, and the premium READ FROM THE LIVE CONFIG,
  // so the floor tracks a timelocked premium change instead of widening past what it measures. The
  // wallet's own exemption is read the way the transaction passes it: an exempted wallet is charged
  // 0 bps on chain, so comparing against the global rate would abort a CORRECT run.
  // FeeExemptAccount layout: 8 disc | 32 wallet | 1 flags | 8 added_at | 32 added_by | 1 version |
  // 8 expires_at (i64 LE) | 24 reserved. flags bit 0 = mint side, bit 1 = redeem side.
  const feeExemptInfo = await conn.getAccountInfo(pda2("fee_exempt", user.toBytes()));
  const mintSideExempt = (() => {
    if (!feeExemptInfo || feeExemptInfo.data.length < 90) return false;
    const flags = feeExemptInfo.data[8 + 32];
    let exp = 0n;
    for (let i = 7; i >= 0; i--) exp = (exp << 8n) | BigInt(feeExemptInfo.data[8 + 32 + 1 + 8 + 32 + 1 + i]);
    const live = exp !== 0n && BigInt(Math.floor(Date.now() / 1000)) < exp;
    return live && (flags & 1) !== 0;
  })();
  const premiumBpsMint = mintSideExempt ? 0 : Number(cfg.premiumBpsMint);
  if (mintSideExempt) {
    console.log("  NOTE: this wallet holds a LIVE mint-side exemption, so 0 bps is the CORRECT expectation");
  }
  const effectiveMintPrice = (priceUsd * 10_000) / (10_000 - premiumBpsMint);
  const minSilvOut = Math.floor((10 / effectiveMintPrice) * (1 - 50 / 10_000) * 1e6);
  console.log(
    `  min_silv_out (0.5% slip @ envelope price, ${premiumBpsMint}bps premium):`,
    minSilvOut / 1e6,
  );

  // 5. Build the mint tx (mirrors buildLazerMintTx in lazer-tx.ts).
  const usdcTreasuryAta = getAssociatedTokenAddressSync(USDC_MINT, pda("treasury"), true, TOKEN_PROGRAM);
  const messageData = Buffer.from(lazerMessageData(envelope));
  const flags = await walletFlagAccounts(provider.connection, user);
  const dominionIx = await (program.methods as any)
    .mintSilv(new anchor.BN(10_000_000), new anchor.BN(minSilvOut), messageData, ED25519_IX_INDEX, 0) // 10 USDC
    .accounts({
      config: configPda, user, usdcMint: USDC_MINT, silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta, userUsdcAta, userSilvAta,
      feeVaultPda, feeVault: feeVaultAta,
      feeExempt: flags.feeExempt, kyc: flags.kyc,
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
  // Simulate first. A priced mint clears the ed25519 pre-instruction, the Lazer verify CPI, the
  // payload parse, the feed-id match and six policy guards before it moves a token, and a send-only
  // failure is an opaque revert. The simulation logs name the guard that rejected it.
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

  // Assert the ACTUAL premium the chain charged. "SILV increased" is satisfied by any premium from
  // 0% to 99%, so on its own it is a liveness check, not an economic one.
  const usdcSpent = (usdcBefore - usdcAfter) / 1e6;
  const silvMinted = (silvAfter - silvBefore) / 1e6;
  const impliedPricePerOz = usdcSpent / silvMinted;
  const impliedPremiumBps = Math.round((1 - priceUsd / impliedPricePerOz) * 10_000);
  console.log(
    `  implied price: $${impliedPricePerOz.toFixed(4)}/oz vs spot $${priceUsd.toFixed(4)} ` +
      `=> premium ${impliedPremiumBps} bps (configured ${premiumBpsMint})`,
  );
  // 2 bps, not more. The two integer floors are far smaller (at a 10 USDC size and ~$58/oz one SILV
  // atomic unit is ~0.06 bps, one USDC atomic unit ~0.001 bps), and a wider tolerance accepts a real
  // pricing regression: 25 bps would pass a 125 bps charge against a configured 100.
  if (Math.abs(impliedPremiumBps - premiumBpsMint) > 2) {
    throw new Error(
      `MINT ECONOMICS WRONG: the chain charged ${impliedPremiumBps} bps, config says ${premiumBpsMint}. ` +
        `This is the check that a pricing regression has to fail.`,
    );
  }
  if (silvAfter <= silvBefore) throw new Error("SILV did not increase");
  console.log("  ✅ MINT OK");

  // === REDEEM (instant) - validates the redeem account set on-chain too ===
  console.log("\n== Redeem 0.05 SILV (instant, fresh envelope) ==");
  const { envelope: redeemEnv, priceUsd: redeemPrice } = await fetchSilvEnvelope();
  // Live config premium and live exemption on this side too, for the same reason as the mint half.
  const redeemSideExempt = (() => {
    if (!feeExemptInfo || feeExemptInfo.data.length < 90) return false;
    const flags = feeExemptInfo.data[8 + 32];
    let exp = 0n;
    for (let i = 7; i >= 0; i--) exp = (exp << 8n) | BigInt(feeExemptInfo.data[8 + 32 + 1 + 8 + 32 + 1 + i]);
    const live = exp !== 0n && BigInt(Math.floor(Date.now() / 1000)) < exp;
    return live && (flags & 2) !== 0;
  })();
  const premiumBpsRedeem = redeemSideExempt ? 0 : Number(cfg.premiumBpsRedeem);
  const redeemSilvAmount = 0.05;
  const minUsdcOut = Math.floor(
    redeemSilvAmount * redeemPrice * (1 - premiumBpsRedeem / 10_000) * (1 - 50 / 10_000) * 1e6,
  );
  console.log(
    `  min_usdc_out (0.5% slip @ envelope price, ${premiumBpsRedeem}bps premium):`,
    minUsdcOut / 1e6,
  );
  // Redemptions are CLOSED at launch, so the redeem half is unreachable until an admin opens them
  // (an ordinary admin call). Exit 2, never 0: half a proof must not read as a pass. This script is
  // the functional gate for a devnet upgrade, so a run that never executed `redeem_silv` would ship
  // the budget accounting, the fee routing and the premium check unexercised behind a green line.
  // E2E_ALLOW_MINT_ONLY=1 is the operator saying a mint-only smoke test is what they wanted.
  if (!cfg.redemptionsEnabled) {
    console.log("\n  SKIP redeem half: redemptions_enabled = false on this program.");
    console.log("  The MINT half passed, with a real signed Lazer envelope.");
    if (process.env.E2E_ALLOW_MINT_ONLY === "1") {
      console.log("  E2E_ALLOW_MINT_ONLY=1, so this counts as a pass. The redeem path was NOT exercised.");
      return;
    }
    console.error(
      "\nE2E INCOMPLETE: redeem_silv was never executed, so the budget accounting, the fee routing and\n" +
        "the redeem premium check are unproven by this run. Open redemptions and re-run:\n" +
        "  npx tsx scripts/dev-set-premiums.ts   # or set_redemptions_enabled(true) from the admin panel\n" +
        "Or, if a mint-only smoke test is genuinely what you want, say so explicitly:\n" +
        "  E2E_ALLOW_MINT_ONLY=1 npx tsx scripts/e2e-lazer-mint.ts",
    );
    process.exit(2);
  }

  const redeemMsg = Buffer.from(lazerMessageData(redeemEnv));
  const redeemFlags = await walletFlagAccounts(provider.connection, user);
  const redeemIx = await (program.methods as any)
    .redeemSilv(new anchor.BN(50_000), new anchor.BN(minUsdcOut), redeemMsg, ED25519_IX_INDEX, 0) // 0.05 SILV
    .accounts({
      config: configPda, user, usdcMint: USDC_MINT, silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta, userUsdcAta, userSilvAta,
      feeVaultPda, feeVault: feeVaultAta,
      feeExempt: redeemFlags.feeExempt, kyc: redeemFlags.kyc,
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
  const silvBurned = (silvAfter - silvFinal) / 1e6;
  const usdcReceived = (usdcFinal - usdcAfter) / 1e6;
  console.log("  SILV burned:", silvBurned, "| USDC received:", usdcReceived);
  if (usdcFinal <= usdcAfter) throw new Error("USDC did not increase on redeem");

  // Economic postcondition on this side too: assert the premium the chain actually charged.
  const impliedRedeemPricePerOz = usdcReceived / silvBurned;
  const impliedRedeemBps = Math.round((1 - impliedRedeemPricePerOz / redeemPrice) * 10_000);
  console.log(
    `  implied redeem: $${impliedRedeemPricePerOz.toFixed(4)}/oz vs spot $${redeemPrice.toFixed(4)} ` +
      `=> premium ${impliedRedeemBps} bps (expected ${premiumBpsRedeem})`,
  );
  // Same 2 bps as the mint side, and for the same reason.
  if (Math.abs(impliedRedeemBps - premiumBpsRedeem) > 2) {
    throw new Error(
      `REDEEM ECONOMICS WRONG: the chain charged ${impliedRedeemBps} bps, expected ${premiumBpsRedeem}. ` +
        `This is the check a pricing regression has to fail.`,
    );
  }

  console.log("\n🎉 LAZER FULL-CYCLE E2E PASSED - mint + instant redeem with real signed SILV prices through the on-chain verify_message.");
}
main().catch((e) => { console.error("FAILED:", e.message || e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
