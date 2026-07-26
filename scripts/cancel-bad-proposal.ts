import { Connection, PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { AnchorProvider, Program, BN, Idl, Wallet } from "@coral-xyz/anchor";
import fs from "fs"; import path from "path"; import os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";

const PROGRAM_ID = SHARED_PROGRAM_ID;
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-dev.json", "utf8"))));

const wallet: Wallet = {
  publicKey: deployer.publicKey,
  signTransaction: async (tx: any) => { tx.partialSign(deployer); return tx; },
  signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(deployer)); return txs; },
  payer: deployer,
};
const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync("target/idl/dominion_silver_mint.json", "utf8"));
const program = new Program(idl as Idl, provider);

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
const [guardianPda] = PublicKey.findProgramAddressSync([Buffer.from("guardian"), deployer.publicKey.toBuffer()], PROGRAM_ID);
const nonceBuf = Buffer.alloc(8);
nonceBuf.writeBigUInt64LE(0n, 0);
const [timelockPda] = PublicKey.findProgramAddressSync([Buffer.from("timelock"), nonceBuf], PROGRAM_ID);

async function main() {
  const cfg = await (program.account as any).configAccount.fetch(configPda);
  console.log("active_proposal_count:", cfg.activeProposalCount);
  console.log("pending_min_reserve_nonce:", cfg.pendingMinReserveNonce?.toString());
  
  if (cfg.activeProposalCount === 0) { console.log("No active proposals"); return; }
  
  const ix = await (program.methods as any)
    .cancelTimelockedAction(new BN(0))
    .accounts({
      config: configPda,
      timelock: timelockPda,
      rentRecipient: deployer.publicKey,
      signer: deployer.publicKey,
      guardian: null, // admin cancels without guardian
    })
    .instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = deployer.publicKey;
  const bh = await conn.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [deployer], {commitment:"confirmed"});
  console.log("Cancelled:", sig);
}
main().catch(e => { console.error(e); process.exit(1); });
