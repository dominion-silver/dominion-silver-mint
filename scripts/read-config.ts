import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { PROGRAM_ID as SHARED_PROGRAM_ID, IDL_PATH } from "./_program-id";
import { connect, describeCluster } from "./_cluster";
async function main() {
  const PROGRAM_ID = SHARED_PROGRAM_ID;
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  // Cluster from the environment, never a literal: the runbook sets DOMINION_RPC=<mainnet> to confirm
  // a mainnet ceremony, and a devnet literal would show a DIFFERENT deployment's config as the new one.
  const { conn, ctx } = connect();
  console.error(`# ${describeCluster(ctx)}`);
  const p = new Program(idl as Idl, new AnchorProvider(conn, new Wallet(Keypair.generate()), {}));
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const c: any = await (p.account as any).configAccount.fetch(cfg);
  // Stringify EVERY field (toBase58, then toString, then JSON) so nothing prints as [object Object].
  const out: Record<string,string> = {};
  for (const k of Object.keys(c).sort()) {
    const v = c[k];
    out[k] = v === null ? "null" : (v?.toBase58?.() ?? v?.toString?.() ?? JSON.stringify(v));
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => {
  // Exit non-zero. constants.ts tells operators to read back SILV_MINT with this script after every
  // init, so a silent success on an RPC failure is the worst possible behaviour here.
  console.error("read-config failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
