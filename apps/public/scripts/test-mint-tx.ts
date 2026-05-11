import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs"; import os from "os";

const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV = new PublicKey("AJxNZeX82pfDbiUXvbe442tX9Vz5XUnfsASvdvG3hNjn");

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-test-user.json","utf8"))));
  const wallet: any = {
    publicKey: user.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(user); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(user)); return txs; },
    payer: user,
  };
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("../../target/idl/dominion_silver_mint.json","utf8"));
  const program = new Program(idl as Idl, provider);

  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);
  const [tr] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PID);
  const [silvAuth] = PublicKey.findProgramAddressSync([Buffer.from("silv_mint_authority")], PID);
  const treasuryAta = getAssociatedTokenAddressSync(USDC, tr, true, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const day = Math.floor(Date.now() / 1000 / 86400);
  const dayBuf = Buffer.alloc(4); dayBuf.writeUInt32LE(day, 0);
  const [daily] = PublicKey.findProgramAddressSync([Buffer.from("daily"), dayBuf], PID);

  // Use a dummy priceUpdate just to build the ix and check account list.
  const dummyPyth = Keypair.generate().publicKey;
  
  const ix = await (program.methods as any)
    .mintSilv(new BN(10_000_000), new BN(1), day)
    .accounts({
      config: cfg,
      daily,
      user: user.publicKey,
      usdcMint: USDC,
      silvMint: SILV,
      usdcTreasury: treasuryAta,
      userUsdcAta,
      userSilvAta,
      silvMintAuthority: silvAuth,
      priceUpdate: dummyPyth,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  
  console.log("✅ ix built, account count:", ix.keys.length);
  console.log("ix data length:", ix.data.length);
  console.log("Keys:");
  for (const k of ix.keys) {
    console.log(`  ${k.pubkey.toBase58()} W=${k.isWritable} S=${k.isSigner}`);
  }
}
main().catch(e => { console.error("FAIL:", e.message || e); process.exit(1); });
