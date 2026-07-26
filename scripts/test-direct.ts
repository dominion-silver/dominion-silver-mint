/**
 * SUPERSEDED. Do not use.
 *
 * AUDIT review of daac4ac (P2): this script calls instructions that no longer exist
 * in the program ABI:
 *   propose_set_treasury_min_reserve (replaced by the treasury FLOAT model)
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
    "scripts/test-direct.ts is SUPERSEDED: it calls instructions removed from the ABI.\n" +
      "See the header for current equivalents. Set DOMINION_RUN_SUPERSEDED=1 to " +
      "run it anyway (it will fail).",
  );
  process.exit(2);
}

import {Connection,PublicKey,Keypair,Transaction,sendAndConfirmTransaction} from "@solana/web3.js";
import {AnchorProvider,Program,BN,Idl,Wallet} from "@coral-xyz/anchor";
import fs from "fs"; import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
const PROGRAM_ID = SHARED_PROGRAM_ID;
const c = new Connection("https://api.devnet.solana.com","confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-dev.json","utf8"))));
const wallet: Wallet = {publicKey: deployer.publicKey, signTransaction: async (tx: any) => { tx.partialSign(deployer); return tx; }, signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(deployer)); return txs; }, payer: deployer };
const provider = new AnchorProvider(c, wallet, {commitment: "confirmed"});
const idl = JSON.parse(fs.readFileSync("target/idl/dominion_silver_mint.json","utf8"));
const program = new Program(idl as Idl, provider);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

async function main() {
  const cfg = await (program.account as any).configAccount.fetch(configPda);
  const nonce = cfg.nextTimelockNonce;
  console.log("Current nonce:", nonce.toString(), "current bps:", cfg.treasuryMinReserveBps, "active:", cfg.activeProposalCount);
  const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()), 0);
  const [timelockPda] = PublicKey.findProgramAddressSync([Buffer.from("timelock"), nonceBuf], PROGRAM_ID);
  
  // Try with 15000 (should fail with AboveMaximum if fix is in)
  console.log("\nTrying new_bps=15000...");
  try {
    const ix = await (program.methods as any)
      .proposeSetTreasuryMinReserve(15000)
      .accounts({
        config: configPda,
        timelock: timelockPda,
        admin: deployer.publicKey,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sig = await sendAndConfirmTransaction(c, tx, [deployer], {commitment: "confirmed"});
    console.log("  ✗ ACCEPTED 15000 bps (BAD, fix not applied):", sig);
  } catch (e: any) {
    console.log("  ✓ Rejected:", e.error?.errorCode?.code || e.message?.slice(0,150));
  }
  
  // Now try with 5000 (valid, should propose)
  console.log("\nTrying new_bps=5000 (should accept if no other proposal active)...");
  const cfg2 = await (program.account as any).configAccount.fetch(configPda);
  const nonce2 = cfg2.nextTimelockNonce;
  console.log("New nonce:", nonce2.toString());
  // Don't actually send - just check if we'd succeed at simulation level
}
main().catch(e => console.error(e));
