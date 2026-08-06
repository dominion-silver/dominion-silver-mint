/**
 * Bumps max_staleness_seconds via the dev-only ix dev_set_max_staleness. Devnet testing only, the
 * mainnet path is propose + execute (24h timelock).
 * Run: cd /Users/thomasblanc/1_app/dominion && npx tsx scripts/bump-staleness.ts [secs]
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";
// Every sending script resolves its cluster from the environment and passes through the one guard,
// which does the consent check AND the genesis-hash cross-check. A hardcoded RPC here would ignore
// DOMINION_RPC and leave nothing confirming the chain matches.
const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;

const PID = SHARED_PROGRAM_ID;

function anchorIxDisc(snakeName: string): Buffer {
  return createHash("sha256")
    .update(`global:${snakeName}`)
    .digest()
    .subarray(0, 8);
}

async function main() {
  await requireSanctionedCluster(RPC, "bump-staleness.ts");
  console.log("  " + describeCluster(CLUSTER));
  const secs = parseInt(process.argv[2] ?? "90", 10);
  if (isNaN(secs) || secs < 1 || secs > 600) {
    console.error("Invalid secs (must be 1..600)"); process.exit(1);
  }

  const c = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-dev.json","utf8"))),
  );
  console.log("Admin:", admin.publicKey.toBase58());

  const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);

  // ix data: 8-byte disc + u32 LE
  const disc = anchorIxDisc("dev_set_max_staleness");
  const data = Buffer.alloc(12);
  disc.copy(data, 0);
  data.writeUInt32LE(secs, 8);

  const ix = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: cfgPda, isSigner: false, isWritable: true },
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  console.log(`Sending dev_set_max_staleness(${secs})...`);
  const sig = await sendAndConfirmTransaction(c, tx, [admin], { commitment: "confirmed" });
  console.log("Confirmed:", sig);

  // Existence check only. This does not walk the ConfigAccount layout to max_staleness_seconds:
  // read the value back with scripts/read-config.ts.
  const ai = await c.getAccountInfo(cfgPda);
  if (!ai) { console.error("Config PDA missing"); process.exit(1); }
  console.log(`OK: max_staleness_seconds set to ${secs}s.`);
}
main().catch(e => { console.error("FAIL:", e.message ?? e); process.exit(1); });
