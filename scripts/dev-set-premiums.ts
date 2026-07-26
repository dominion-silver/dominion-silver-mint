/**
 * Dev-only: set premium_bps_mint + premium_bps_redeem without timelock.
 *
 * Run: npx tsx scripts/dev-set-premiums.ts <mint_bps> <redeem_bps>
 *   e.g.  npx tsx scripts/dev-set-premiums.ts 50 50    (0.5% each)
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs"; import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";

const PID = SHARED_PROGRAM_ID;
function disc(name: string) { return createHash("sha256").update(`global:${name}`).digest().subarray(0,8); }

async function main() {
  const mintBps = parseInt(process.argv[2] ?? "50", 10);
  const redeemBps = parseInt(process.argv[3] ?? "50", 10);
  if (mintBps < 0 || mintBps > 10_000 || redeemBps < 0 || redeemBps > 10_000) {
    console.error("bps must be in 0..10000"); process.exit(1);
  }
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-dev.json","utf8"))));
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);

  // 8-byte disc + u16 mint_bps + u16 redeem_bps
  const data = Buffer.alloc(12);
  disc("dev_set_premiums").copy(data, 0);
  data.writeUInt16LE(mintBps, 8);
  data.writeUInt16LE(redeemBps, 10);

  const ix = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: cfg, isSigner: false, isWritable: true },
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [admin], { commitment: "confirmed" });
  console.log(`OK: premiums set to ${mintBps}bps mint / ${redeemBps}bps redeem. Sig: ${sig}`);
}
main().catch(e => { console.error(e.message ?? e); process.exit(1); });
