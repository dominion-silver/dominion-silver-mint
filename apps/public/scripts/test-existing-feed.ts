import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
// Standard Pyth price feed account PDAs are deterministic per (shardId, feedId).
// Pyth maintains a keeper for the price feed accounts on devnet.
async function main() {
  // The receiver-pulled PriceUpdateV2 from the test above.
  const candidate = new PublicKey("8jstFsgczSQCeAaZL8wGRptWp1r1Lpz9fk6oy8YygMvp");
  const acct = await c.getAccountInfo(candidate);
  console.log("PriceUpdate from receiver post:", acct ? "exists, " + acct.data.length + " bytes" : "DOES NOT EXIST (was meant to be created during the post tx)");
  
  // Check known shared XAG/USD price feed account PDA on devnet (shardId 0).
  // Per @pythnetwork/pyth-solana-receiver, the deterministic PDA is:
  // seeds = [shardId_le_bytes(2), feedId_bytes(32)]
  const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
  const FEED = Buffer.from("f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e", "hex");
  const shardId = Buffer.alloc(2); shardId.writeUInt16LE(0, 0);
  const [pda] = PublicKey.findProgramAddressSync([shardId, FEED], PYTH_RECEIVER);
  console.log("Standing XAG/USD price feed PDA:", pda.toBase58());
  const standing = await c.getAccountInfo(pda);
  console.log("Standing acct:", standing ? "✅ EXISTS, " + standing.data.length + " bytes" : "❌ does not exist");
}
main().catch(e => console.error(e));
