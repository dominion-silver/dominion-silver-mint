// Compare the deployed ProgramData bytes against the local .so, over the local artifact's length.
import {Connection, PublicKey} from "@solana/web3.js";
import fs from "fs"; import crypto from "crypto";
const c = new Connection("https://api.devnet.solana.com","confirmed");
const programDataPda = new PublicKey("2CfTy1zP6BVEyYkD9dK3deQ4NUrR7H83ZnwYtKhhWBVB");
async function main() {
  const acct = await c.getAccountInfo(programDataPda);
  // null is an EXPECTED answer here, not an anomaly: the whole job is comparing a possibly-absent
  // ProgramData account against a local artifact.
  if (!acct) {
    console.error(`no account at ${programDataPda.toBase58()}. Wrong program id, or the program is closed.`);
    process.exit(1);
  }
  const programBytes = acct.data.subarray(45);
  const local = fs.readFileSync("target/deploy/dominion_silver_mint.so");
  const onchainCode = programBytes.subarray(0, local.length);
  const onchainHash = crypto.createHash("sha256").update(onchainCode).digest("hex");
  const localHash = crypto.createHash("sha256").update(local).digest("hex");
  console.log("First", local.length, "bytes match:", onchainHash === localHash);
  console.log("On-chain prefix hash:", onchainHash);
  console.log("Local hash:           ", localHash);
}
main();
