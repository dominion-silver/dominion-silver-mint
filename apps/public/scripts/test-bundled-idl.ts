import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../src/lib/idl/dominion_silver_mint.json";

async function main() {
  console.log("Bundled IDL address field:", (idl as any).address);
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = { publicKey: PublicKey.default, signTransaction: async () => { throw 0; }, signAllTransactions: async () => { throw 0; } } as any;
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  console.log("Program.programId from bundled IDL:", program.programId.toBase58());
  if (program.programId.toBase58() === "J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5") {
    console.log("OK: matches the deployed devnet program.");
  } else {
    console.log("FAIL: still wrong!"); process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
