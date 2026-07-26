import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
async function main() {
  const PROGRAM_ID = new PublicKey(process.env.DOMINION_PROGRAM_ID!);
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
    "utf8",
  ));
  idl.address = PROGRAM_ID.toBase58();
  const conn = new Connection("https://api.devnet.solana.com","confirmed");
  const p = new Program(idl as Idl, new AnchorProvider(conn, new Wallet(Keypair.generate()), {}));
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const c: any = await (p.account as any).configAccount.fetch(cfg);
  const out: Record<string,string> = {};
  for (const k of Object.keys(c).sort()) {
    const v = c[k];
    out[k] = v === null ? "null" : (v?.toBase58?.() ?? v?.toString?.() ?? JSON.stringify(v));
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => {
  // AUDIT review of daac4ac (P2): main() had no .catch(), so an RPC failure exited 0
  // with an unhandled rejection. constants.ts tells operators to use this script to
  // read back SILV_MINT after every init, so a silent success on failure is the worst
  // possible behaviour here.
  console.error("read-config failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
