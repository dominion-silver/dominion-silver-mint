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
    signTransaction: async (tx: any) => { tx.partialSign(user); return tx; },
    signAllTransactions: async (txs: any) => { txs.forEach((t: any) => t.partialSign(user)); return txs; },
    payer: user,
  };
  const provider = new AnchorProvider(c, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("../../target/idl/dominion_silver_mint.json","utf8"));
  const program = new Program(idl as Idl, provider);

  // Step 1: post pyth update via SDK
  console.log("\n== Posting Pyth update ==");
  const hermes = new HermesClient("https://hermes.pyth.network");
  const updates = await hermes.getLatestPriceUpdates([FEED], { encoding: "base64" });
  const vaa = updates.binary.data[0];
  const receiver = new PythSolanaReceiver({ connection: c, wallet: wallet as any });
  const builder: any = receiver.newTransactionBuilder({ closeUpdateAccounts: false }); // KEEP open for simulation
  await builder.addPostPriceUpdates([vaa]);
  const priceUpdate = builder.getPriceUpdateAccount("0x"+FEED);
  console.log("PriceUpdateV2 account:", priceUpdate.toBase58());
  const versioned = await builder.buildVersionedTransactions({computeUnitPriceMicroLamports:50000, tightComputeBudget:true});
  console.log("Pyth tx count:", versioned.length);
  for (const v of versioned) {
    v.tx.sign([user, ...v.signers]);
    const sig = await c.sendRawTransaction(v.tx.serialize(), {skipPreflight:false});
    await c.confirmTransaction(sig, "confirmed");
    console.log("  pyth tx:", sig);
  }
  
  // Verify priceUpdate account exists
  const acct = await c.getAccountInfo(priceUpdate);
  console.log("PriceUpdate account exists?", !!acct, "data length:", acct?.data.length);
  console.log("Owner:", acct?.owner.toBase58());
  
  // Step 2: build mint tx
  console.log("\n== Building mint tx ==");
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
    .mintSilv(new BN(10_000_000), new BN(100_000), day) // 10 USDC, min 0.1 SILV
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
    })
    .instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({units: 400000}),
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userSilvAta, user.publicKey, SILV, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userUsdcAta, user.publicKey, USDC, TOKEN_PROGRAM_ID),
    ix,
  );
  tx.feePayer = user.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(user);
  
  console.log("\n== Sending mint tx ==");
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("Tx sig:", sig);
  await c.confirmTransaction(sig, "confirmed");
  console.log("Confirmed.");
  const userSilvBal = await c.getTokenAccountBalance(userSilvAta).catch(() => null);
  const userUsdcBal = await c.getTokenAccountBalance(userUsdcAta).catch(() => null);
  const treasuryBal = await c.getTokenAccountBalance(treasuryAta).catch(() => null);
  console.log("\nPost-mint balances:");
  console.log("  user SILV    :", userSilvBal?.value.uiAmountString ?? "n/a");
  console.log("  user USDC    :", userUsdcBal?.value.uiAmountString ?? "n/a");
  console.log("  treasury USDC:", treasuryBal?.value.uiAmountString ?? "n/a");
}
main().catch(e => { console.error("FAIL:", e.message || e); process.exit(1); });
