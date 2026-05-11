/**
 * Reproduces the EXACT sequence the UI does:
 *   1. postPythUpdate (closeUpdateAccounts: false)
 *   2. build mint tx (legacy Transaction, signed by wallet)
 *   3. simulateTransaction
 *   4. sendRawTransaction
 *
 * Run: cd apps/public && npx tsx scripts/sim-ui-exact.ts
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Idl, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import fs from "fs"; import os from "os";

const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV = new PublicKey("AJxNZeX82pfDbiUXvbe442tX9Vz5XUnfsASvdvG3hNjn");
const FEED = "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

async function main() {
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir()+"/.config/solana/dominion-test-user.json","utf8"))));
  console.log("User:", user.publicKey.toBase58());

  const wallet: Wallet = {
    publicKey: user.publicKey,
    signTransaction: async (tx: any) => { if (tx instanceof Transaction) { tx.partialSign(user); } else { tx.sign([user]); } return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => { if (t instanceof Transaction) t.partialSign(user); else t.sign([user]); }); return txs; },
    payer: user,
  };
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("../../target/idl/dominion_silver_mint.json","utf8"));
  const program = new Program(idl as Idl, provider);

  // Step 1: post Pyth (closeUpdateAccounts: false)
  console.log("\n=== Step 1: Pyth post ===");
  const hermes = new HermesClient("https://hermes.pyth.network");
  const updates = await hermes.getLatestPriceUpdates([FEED], { encoding: "base64" });
  const vaa = updates.binary.data[0];
  const receiver = new PythSolanaReceiver({ connection: c, wallet: wallet as any });
  const builder: any = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates([vaa]);
  const priceUpdate = builder.getPriceUpdateAccount("0x"+FEED);
  console.log("priceUpdate:", priceUpdate.toBase58());
  const versioned = await builder.buildVersionedTransactions({computeUnitPriceMicroLamports:50000, tightComputeBudget:true});
  for (const v of versioned) {
    v.tx.sign([user, ...v.signers]);
    const sig = await c.sendRawTransaction(v.tx.serialize(), {skipPreflight:false});
    await c.confirmTransaction(sig, "confirmed");
    console.log("  pyth tx:", sig);
  }
  // Verify priceUpdate alive.
  const acct = await c.getAccountInfo(priceUpdate);
  console.log("priceUpdate exists?", !!acct, "owner:", acct?.owner.toBase58());

  // Step 2: build mint tx EXACTLY like buildMintTx in anchor-client.ts
  console.log("\n=== Step 2: build mint tx (legacy Transaction) ===");
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PID);
  const [tr] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PID);
  const [silvAuth] = PublicKey.findProgramAddressSync([Buffer.from("silv_mint_authority")], PID);
  const treasuryAta = getAssociatedTokenAddressSync(USDC, tr, true, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const day = Math.floor(Date.now() / 1000 / 86400);
  const dayBuf = Buffer.alloc(4); dayBuf.writeUInt32LE(day, 0);
  const [daily] = PublicKey.findProgramAddressSync([Buffer.from("daily"), dayBuf], PID);

  const ix = await (program.methods as any)
    .mintSilv(new BN(10_000_000), new BN(100_000), day)
    .accounts({
      config: cfg, daily,
      user: user.publicKey, usdcMint: USDC, silvMint: SILV,
      usdcTreasury: treasuryAta, userUsdcAta, userSilvAta,
      silvMintAuthority: silvAuth,
      priceUpdate,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    }).instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({units: 400000}),
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
    ix,
  );
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user.publicKey;

  // Sign EXACTLY like the UI does (wallet.signTransaction)
  const signed = await wallet.signTransaction(tx);
  console.log("Signed. signatures count:", signed.signatures.length);

  // Step 3: simulateTransaction (this is where UI sees ProgramAccountNotFound)
  console.log("\n=== Step 3: simulate ===");
  const sim = await c.simulateTransaction(signed);
  console.log("err:", sim.value.err);
  console.log("logs (last 10):");
  (sim.value.logs ?? []).slice(-10).forEach(l => console.log("  ", l));
  if (sim.value.err) {
    console.log("\nFAIL at simulate step");
    process.exit(1);
  }

  // Step 4: send
  console.log("\n=== Step 4: send ===");
  const sig = await c.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", skipPreflight: false });
  console.log("Sent:", sig);
  await c.confirmTransaction(sig, "confirmed");
  console.log("Confirmed.");
}
main().catch(e => { console.error("FAIL:", e); process.exit(1); });
