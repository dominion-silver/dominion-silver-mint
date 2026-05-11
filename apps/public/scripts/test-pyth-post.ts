import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

const FEED_RAW = "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";
const FEED_PREFIXED = "0x" + FEED_RAW;

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-test-user.json","utf8"))));
  
  const hermes = new HermesClient("https://hermes.pyth.network");
  const updates = await hermes.getLatestPriceUpdates([FEED_RAW], { encoding: "base64" });
  console.log("Hermes returned", updates.binary?.data?.length ?? 0, "VAAs");
  const vaa = updates.binary.data[0];
  
  const wallet: any = {
    publicKey: deployer.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(deployer); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(deployer)); return txs; },
    payer: deployer,
  };
  const receiver = new PythSolanaReceiver({ connection: c, wallet });
  const builder: any = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates([vaa]);
  
  console.log("priceFeedIdToPriceUpdateAccount keys:", Object.keys(builder.priceFeedIdToPriceUpdateAccount));
  console.log("transactionInstructions groups:", builder.transactionInstructions.length);
  let totalIx = 0;
  for (const g of builder.transactionInstructions) totalIx += g.instructions.length;
  console.log("total instructions:", totalIx);
  console.log("close instructions:", builder.closeInstructions.length);
  
  const acct = builder.getPriceUpdateAccount(FEED_PREFIXED);
  console.log("priceUpdate account:", acct.toBase58());
}
main().catch(e => { console.error(e); process.exit(1); });
