import {Connection,PublicKey} from "@solana/web3.js";
import {AnchorProvider,Program,Idl} from "@coral-xyz/anchor";
import fs from "fs";
const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const c = new Connection("https://api.devnet.solana.com","confirmed");
const idl = JSON.parse(fs.readFileSync("target/idl/dominion_silver_mint.json","utf8"));
const p = new Program(idl as Idl, new AnchorProvider(c,{publicKey:PublicKey.default,signTransaction:async()=>{throw 0;},signAllTransactions:async()=>{throw 0;}} as any,{commitment:"confirmed"}));
const [pda]=PublicKey.findProgramAddressSync([Buffer.from("config")], PID);
console.log("computed configPda:", pda.toBase58());
async function main() {
  const cfg = await (p.account as any).configAccount.fetchNullable(pda);
  if (!cfg) { console.log("CONFIG NOT FOUND - new contract not initialized?"); return; }
  console.log("✅ config:", {premMint:cfg.premiumBpsMint, premRed:cfg.premiumBpsRedeem, paused:cfg.paused, admin:cfg.admin.toBase58()});
}
main().catch(e=>console.error("ERR:",e.message||e));
