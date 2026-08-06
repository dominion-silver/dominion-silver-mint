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
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";
// RE-AUDIT P0 (the CLASS, not the instance). This script sends transactions and had NO cluster guard:
// it hardcoded the devnet RPC, so `DOMINION_RPC` was ignored and nothing confirmed the chain matched.
// The re-audit named `create-fee-vault.ts` as "the missing fourth"; the structural assertion in
// scripts/verify-cluster-resolution.ts then found NINE more, of which this is one. Every sending script
// now resolves its cluster from the environment and passes through the one guard, which does the consent
// check AND the genesis-hash cross-check.
const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;

const PID = SHARED_PROGRAM_ID;
function disc(name: string) { return createHash("sha256").update(`global:${name}`).digest().subarray(0,8); }

async function main() {
  await requireSanctionedCluster(RPC, "dev-set-premiums.ts");
  console.log("  " + describeCluster(CLUSTER));
  const mintBps = parseInt(process.argv[2] ?? "50", 10);
  const redeemBps = parseInt(process.argv[3] ?? "50", 10);
  if (mintBps < 0 || mintBps > 10_000 || redeemBps < 0 || redeemBps > 10_000) {
    console.error("bps must be in 0..10000"); process.exit(1);
  }
  const c = new Connection(RPC, "confirmed");
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
