import {Connection, PublicKey} from "@solana/web3.js";
import fs from "fs"; import crypto from "crypto";
const c = new Connection("https://api.devnet.solana.com","confirmed");
const programDataPda = new PublicKey("2CfTy1zP6BVEyYkD9dK3deQ4NUrR7H83ZnwYtKhhWBVB");
async function main() {
  const acct = await c.getAccountInfo(programDataPda);
  const programBytes = acct.data.subarray(45);
  const local = fs.readFileSync("target/deploy/dominion_silver_mint.so");
  // Compare first N bytes (where N = local size)
  const onchainCode = programBytes.subarray(0, local.length);
  const onchainHash = crypto.createHash("sha256").update(onchainCode).digest("hex");
  const localHash = crypto.createHash("sha256").update(local).digest("hex");
  console.log("First", local.length, "bytes match:", onchainHash === localHash);
  console.log("On-chain prefix hash:", onchainHash);
  console.log("Local hash:           ", localHash);
}
main();
