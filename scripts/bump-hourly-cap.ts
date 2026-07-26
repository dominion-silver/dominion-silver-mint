/**
 * SUPERSEDED. Do not use.
 *
 * AUDIT review of daac4ac (P2): this script calls instructions that no longer exist
 * in the program ABI:
 *   set_hourly_redeem_cap (Option A caps, deleted in V2)
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
    "scripts/bump-hourly-cap.ts is SUPERSEDED: it calls instructions removed from the ABI.\n" +
      "See the header for current equivalents. Set DOMINION_RUN_SUPERSEDED=1 to " +
      "run it anyway (it will fail).",
  );
  process.exit(2);
}

/**
 * Bumps hourly_redeem_cap_bps_of_snapshot to 10000 bps (100% of treasury at
 * hour start, effectively disabling the cap for testing).
 *
 * Run: cd /Users/thomasblanc/1_app/dominion && npx tsx scripts/bump-hourly-cap.ts
 */
import { AnchorProvider, BN, Program, Idl, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";

const PID = SHARED_PROGRAM_ID;

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");

  const adminPath = os.homedir() + "/.config/solana/dominion-dev.json";
  if (!fs.existsSync(adminPath)) {
    console.error("Admin keypair not found at", adminPath);
    process.exit(1);
  }
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8"))),
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

  console.log("Sending set_hourly_redeem_cap(10000)...");
  const sig = await (program.methods as any)
    .setHourlyRedeemCap(10000)
    .accounts({ config: cfgPda, admin: admin.publicKey })
    .signers([admin])
    .rpc();
  console.log("Confirmed:", sig);

  // Verify.
  const cfg: any = await (program.account as any).configAccount.fetch(cfgPda);
  console.log("Post-update hourly_redeem_cap_bps_of_snapshot:", cfg.hourlyRedeemCapBpsOfSnapshot);
  if (cfg.hourlyRedeemCapBpsOfSnapshot !== 10000) {
    console.error("FAIL: cap not updated"); process.exit(1);
  }
  console.log("OK: hourly cap is now 100% (effectively disabled).");
}
main().catch(e => { console.error("FAIL:", e.message ?? e); process.exit(1); });
