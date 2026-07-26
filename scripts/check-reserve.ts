import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";

const PID = SHARED_PROGRAM_ID;

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/dominion_silver_mint.json","utf8"));
  const wallet = { publicKey: PublicKey.default, signTransaction: async () => { throw 0; }, signAllTransactions: async () => { throw 0; } } as any;
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);
  const config: any = await (program.account as any).configAccount.fetch(cfg);
  console.log("treasury_min_reserve_bps:", config.treasuryMinReserveBps);
  console.log("premium_bps_mint:", config.premiumBpsMint);
  console.log("premium_bps_redeem:", config.premiumBpsRedeem);
  console.log("max_staleness_seconds:", config.maxStalenessSeconds);
  console.log("hourly_redeem_cap_bps_of_snapshot:", config.hourlyRedeemCapBpsOfSnapshot);
  // Liquidity check
  const [tr] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PID);
  const trAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(
    new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), tr, true,
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
  const trBal = await c.getTokenAccountBalance(trAta);
  const supply = await c.getTokenSupply(new PublicKey("AJxNZeX82pfDbiUXvbe442tX9Vz5XUnfsASvdvG3hNjn"));
  console.log("\nTreasury USDC:", trBal.value.uiAmountString);
  console.log("SILV supply:  ", supply.value.uiAmountString);
}
main().catch(e => { console.error(e); process.exit(1); });
