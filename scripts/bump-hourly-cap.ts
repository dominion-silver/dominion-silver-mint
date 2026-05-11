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

const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");

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
