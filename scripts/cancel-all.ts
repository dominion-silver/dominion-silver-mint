import {Connection,PublicKey,Keypair,Transaction,sendAndConfirmTransaction} from "@solana/web3.js";
import {AnchorProvider,Program,BN,Idl,Wallet} from "@coral-xyz/anchor";
import fs from "fs"; import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";
const PROGRAM_ID = SHARED_PROGRAM_ID;
// RE-AUDIT P0 (the CLASS, not the instance). This script sends transactions and had NO cluster guard:
// it hardcoded the devnet RPC, so `DOMINION_RPC` was ignored and nothing confirmed the chain matched.
// The re-audit named `create-fee-vault.ts` as "the missing fourth"; the structural assertion in
// scripts/verify-cluster-resolution.ts then found NINE more, of which this is one. Every sending script
// now resolves its cluster from the environment and passes through the one guard, which does the consent
// check AND the genesis-hash cross-check.
const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;
const c = new Connection(RPC, "confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-dev.json","utf8"))));
const wallet: Wallet = {publicKey: deployer.publicKey, signTransaction: async (tx: any) => { tx.partialSign(deployer); return tx; }, signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(deployer)); return txs; }, payer: deployer };
const provider = new AnchorProvider(c, wallet, {commitment: "confirmed"});
const idl = JSON.parse(fs.readFileSync("target/idl/dominion_silver_mint.json","utf8"));
const program = new Program(idl as Idl, provider);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

async function main() {
  await requireSanctionedCluster(RPC, "cancel-all.ts");
  console.log("  " + describeCluster(CLUSTER));
  const cfg = await (program.account as any).configAccount.fetch(configPda);
  console.log("active count:", cfg.activeProposalCount);
  // Try cancelling nonces 0..next
  for (let n = 0; n < Number(cfg.nextTimelockNonce); n++) {
    const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(n), 0);
    const [tlPda] = PublicKey.findProgramAddressSync([Buffer.from("timelock"), nonceBuf], PROGRAM_ID);
    const acct = await c.getAccountInfo(tlPda);
    if (!acct) continue;
    try {
      const ix = await (program.methods as any).cancelTimelockedAction(new BN(n)).accounts({config:configPda, timelock:tlPda, rentRecipient:deployer.publicKey, signer:deployer.publicKey, guardian:null}).instruction();
      const tx = new Transaction().add(ix); tx.feePayer = deployer.publicKey; tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(c, tx, [deployer], {commitment: "confirmed"});
      console.log("cancelled nonce", n);
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("TimelockActionCancelled") || msg.includes("AlreadyExecuted")) console.log("nonce", n, "already cancelled");
      else console.log("nonce", n, "skip:", msg.slice(0,80));
    }
  }
  const cfg2 = await (program.account as any).configAccount.fetch(configPda);
  console.log("active count after:", cfg2.activeProposalCount);
}
main().catch(e => console.error(e));
