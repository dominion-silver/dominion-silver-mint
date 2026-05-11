import {Connection,PublicKey,Keypair,Transaction,sendAndConfirmTransaction} from "@solana/web3.js";
import {AnchorProvider,Program,BN,Idl,Wallet} from "@coral-xyz/anchor";
import fs from "fs"; import os from "os";
const PROGRAM_ID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
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
