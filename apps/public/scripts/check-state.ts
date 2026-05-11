import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV = new PublicKey("AJxNZeX82pfDbiUXvbe442tX9Vz5XUnfsASvdvG3hNjn");
async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const idl = JSON.parse(fs.readFileSync("../../target/idl/dominion_silver_mint.json","utf8"));
  const p = new Program(idl as Idl, new AnchorProvider(c, {publicKey: PublicKey.default, signTransaction: async()=>{throw 0;}, signAllTransactions: async()=>{throw 0;}} as any, {commitment:"confirmed"}));
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);
  const [tr] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PID);
  const trAta = getAssociatedTokenAddressSync(USDC, tr, true, TOKEN_PROGRAM_ID);
  
  const config = await (p.account as any).configAccount.fetch(cfg);
  console.log("=== ConfigAccount ===");
  console.log("paused:", config.paused, "minReserveBps:", config.treasuryMinReserveBps);
  console.log("premiumBpsMint:", config.premiumBpsMint, "premiumBpsRedeem:", config.premiumBpsRedeem);
  console.log("Object.keys:", Object.keys(config));return;
  console.log("reserveCheckPriceScaled:", config.reserveCheckPriceScaled.toString());
  console.log("minMintAmountUsdc:", config.minMintAmountUsdc.toString());
  console.log("maxMintAmountPerTxUsdc:", config.maxMintAmountPerTxUsdc.toString());
  console.log("dailyMintCapUsdc:", config.dailyMintCapUsdc.toString());
  
  const trBal = await c.getTokenAccountBalance(trAta).catch(() => null);
  const supply = await c.getTokenSupply(SILV).catch(() => null);
  console.log("\n=== Liquidity ===");
  console.log("Treasury USDC:", trBal?.value.uiAmountString, "(raw:", trBal?.value.amount, ")");
  console.log("SILV supply:  ", supply?.value.uiAmountString, "(raw:", supply?.value.amount, ")");
}
main().catch(e => console.error(e));
