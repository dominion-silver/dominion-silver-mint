import {Connection, PublicKey} from "@solana/web3.js";
import fs from "fs"; import crypto from "crypto";
const c = new Connection("https://api.devnet.solana.com","confirmed");
const programDataPda = new PublicKey("2CfTy1zP6BVEyYkD9dK3deQ4NUrR7H83ZnwYtKhhWBVB");
async function main() {
  const acct = await c.getAccountInfo(programDataPda);
  if (!acct) throw new Error("no account");
  // ProgramData layout: 45 bytes header + program bytes
  const programBytes = acct.data.subarray(45);
  console.log("On-chain program data length:", programBytes.length);
  const hash = crypto.createHash("sha256").update(programBytes).digest("hex");
  console.log("On-chain program hash:", hash);
  // Compare with local
  const local = fs.readFileSync("target/deploy/dominion_silver_mint.so");
  console.log("Local program length:", local.length);
  console.log("Local program hash:", crypto.createHash("sha256").update(local).digest("hex"));
}
main();
