/**
 * SUPERSEDED. Do not use.
 *
 * AUDIT review of daac4ac (P2): this script calls instructions that no longer exist
 * in the program ABI:
 *   set_mint_caps / set_redeem_caps / set_hourly_redeem_cap (Option A caps, deleted in V2)
 * It also held a program id retired one or two generations ago. It cannot work, and
 * it fails deep inside with an opaque error that reads like a protocol fault rather
 * than a stale script. Kept for its historical assertions only.
 *
 * Current equivalents:
  scripts/e2e-fixa-devnet.ts        launch posture + FIX A, on the live program
  scripts/e2e-guardian-devnet.ts    the guardian removal lifecycle (DOM-007)
  scripts/t1-hostile-bootstrap.ts   the initialize authentication (DOM-001, P0)
  scripts/read-config.ts            dump the live config
 */
if (!process.env.DOMINION_RUN_SUPERSEDED) {
  console.error(
    "scripts/bump-all-caps.ts is SUPERSEDED: it calls instructions removed from the ABI.\n" +
      "See the header for current equivalents. Set DOMINION_RUN_SUPERSEDED=1 to " +
      "run it anyway (it will fail).",
  );
  process.exit(2);
}

/**
 * Lifts every soft-cap to a high value for testing. Devnet only.
 * REVERSE BEFORE MAINNET (or simply re-init at mainnet with prod values).
 *
 * Run: npx tsx scripts/bump-all-caps.ts
 */
import { AnchorProvider, BN, Program, Idl, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";

const PID = SHARED_PROGRAM_ID;
const MAX_USDC = new BN("1000000000000"); // 1M USDC raw (6 decimals)

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-dev.json","utf8"))),
  );
  console.log("Admin:", admin.publicKey.toBase58());

  const wallet: Wallet = {
    publicKey: admin.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(admin); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(admin)); return txs; },
    payer: admin,
  };
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("target/idl/dominion_silver_mint.json", "utf8"));
  const program = new Program(idl as Idl, provider);
  const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);

  // Mint caps: min=1 USDC, max=1M USDC, daily=1M USDC.
  console.log("\n[1/3] set_mint_caps(1, 1M, 1M)...");
  const sigMint = await (program.methods as any)
    .setMintCaps(new BN(1_000_000), MAX_USDC, MAX_USDC)
    .accounts({ config: cfgPda, admin: admin.publicKey })
    .signers([admin]).rpc();
  console.log("  ", sigMint);

  // Redeem caps: min=1 USDC, max=1M USDC, daily=1M USDC.
  console.log("\n[2/3] set_redeem_caps(1, 1M, 1M)...");
  const sigRedeem = await (program.methods as any)
    .setRedeemCaps(new BN(1_000_000), MAX_USDC, MAX_USDC)
    .accounts({ config: cfgPda, admin: admin.publicKey })
    .signers([admin]).rpc();
  console.log("  ", sigRedeem);

  // Hourly redeem cap already at 10000 bps from earlier. Re-confirm.
  console.log("\n[3/3] set_hourly_redeem_cap(10000)...");
  const sigHourly = await (program.methods as any)
    .setHourlyRedeemCap(10000)
    .accounts({ config: cfgPda, admin: admin.publicKey })
    .signers([admin]).rpc();
  console.log("  ", sigHourly);

  // Verify.
  const cfg: any = await (program.account as any).configAccount.fetch(cfgPda);
  console.log("\nPost-bump config:");
  console.log("  min_mint_amount_usdc:           ", cfg.minMintAmountUsdc.toString());
  console.log("  max_mint_amount_per_tx_usdc:    ", cfg.maxMintAmountPerTxUsdc.toString());
  console.log("  daily_mint_cap_usdc:            ", cfg.dailyMintCapUsdc.toString());
  console.log("  min_redeem_amount_usdc:         ", cfg.minRedeemAmountUsdc.toString());
  console.log("  max_redeem_amount_per_tx_usdc:  ", cfg.maxRedeemAmountPerTxUsdc.toString());
  console.log("  daily_redeem_cap_usdc:          ", cfg.dailyRedeemCapUsdc.toString());
  console.log("  hourly_redeem_cap_bps_of_snapshot:", cfg.hourlyRedeemCapBpsOfSnapshot);
  console.log("\nOK. Caps lifted. Tests should run freely now.");
}
main().catch(e => { console.error("FAIL:", e.message ?? e); process.exit(1); });
