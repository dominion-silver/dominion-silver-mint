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
const nonceBuf = Buffer.alloc(8);
nonceBuf.writeBigUInt64LE(1n, 0);
const [timelockPda] = PublicKey.findProgramAddressSync([Buffer.from("timelock"), nonceBuf], PROGRAM_ID);
async function main() {
  const ix = await (program.methods as any).cancelTimelockedAction(new BN(1)).accounts({config:configPda, timelock:timelockPda, rentRecipient:deployer.publicKey, signer:deployer.publicKey, guardian:null}).instruction();
  const tx = new Transaction().add(ix); tx.feePayer = deployer.publicKey; tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(c, tx, [deployer], {commitment: "confirmed"});
  console.log("Cancelled nonce 1:", sig);
}
main().catch(e => { console.error(e); process.exit(1); });
