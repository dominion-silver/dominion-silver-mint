/**
 * PROBE: can the automated (no human popup) Pyth post+consume flow fit inside
 * the live on-chain `max_staleness_seconds` (currently 15s on devnet)?
 *
 * This is the gating unknown for the full mint/redeem/queue/claim lifecycle:
 * mint_silv / redeem_silv / claim_redemption all do an oracle read with the
 * staleness guard. If a fast keypair-signed flow still can't fit 15s, those
 * paths are blocked until max_staleness is raised (24h timelock).
 *
 * Run from the dominion root:
 *   PATH="<solana-bin>:$PATH" \
 *   node_modules/.bin/tsx scripts/probe-mint-pyth.ts
 *
 * Resolves ALL deps from apps/public/node_modules so the @solana/web3.js
 * instance is shared with the Pyth SDK (mixed copies break instanceof).
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";

const APUB = "/Users/thomasblanc/1_app/dominion/apps/public/";
const r = createRequire(APUB);

/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} = r("@solana/web3.js");
const anchor = r("@coral-xyz/anchor");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = r("@solana/spl-token");
const { HermesClient } = r("@pythnetwork/hermes-client");
const { PythSolanaReceiver } = r("@pythnetwork/pyth-solana-receiver");
const { BN } = anchor;

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = SHARED_PROGRAM_ID;
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SILV_MINT = new PublicKey("4bNYnE1d8XV1W4iJuWVqmxVi5qqvAopvxekifDVvB4Ew");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROG = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const XAG_FEED =
  "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e";

function pda(seed: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    PROGRAM_ID,
  )[0] as InstanceType<typeof PublicKey>;
}

async function main() {
  const user = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          os.homedir() + "/.config/solana/dominion-test-user.json",
          "utf8",
        ),
      ),
    ),
  );
  const conn = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(user);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(APUB + "src/lib/idl/dominion_silver_mint.json", "utf8"),
  );
  const program = new anchor.Program(idl, provider);

  console.log("PROBE mint+Pyth fit-in-15s");
  console.log("user:", user.publicKey.toBase58());
  const t0 = Date.now();

  // 1. Hermes latest VAA + capture its publish_time.
  const hermes = new HermesClient("https://hermes.pyth.network");
  const upd = await hermes.getLatestPriceUpdates([XAG_FEED], {
    encoding: "base64",
  });
  const vaa = upd.binary.data[0];
  const pubTime: number = upd.parsed?.[0]?.price?.publish_time ?? 0;
  const priceRaw = upd.parsed?.[0]?.price;
  console.log(
    `hermes fetched in ${Date.now() - t0}ms; price publish_time=${pubTime} (age now ${Math.floor(Date.now() / 1000) - pubTime}s) price=${priceRaw?.price}e${priceRaw?.expo}`,
  );

  // 2. Post the price update (closeUpdateAccounts:false so it survives to
  //    the consumer tx).
  const receiver = new PythSolanaReceiver({ connection: conn, wallet });
  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: false,
  });
  await builder.addPostPriceUpdates([vaa]);
  const priceUpdate: InstanceType<typeof PublicKey> = (
    builder as any
  ).getPriceUpdateAccount("0x" + XAG_FEED);
  const bundles = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: true,
  });
  for (const b of bundles) {
    b.tx.sign([user, ...(b.signers as any[])]);
    const sig = await conn.sendRawTransaction(b.tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    const bh = b.tx.message.recentBlockhash;
    const { lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction(
      { signature: sig, blockhash: bh, lastValidBlockHeight },
      "confirmed",
    );
  }
  console.log(
    `pyth posted in ${Date.now() - t0}ms total (price age now ${Math.floor(Date.now() / 1000) - pubTime}s vs max_staleness 15s)`,
  );

  // 3. Build + send the mint consumer tx (5 USDC, no slippage floor).
  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    pda("treasury"),
    true,
    TOKEN,
  );
  const userUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    user.publicKey,
    false,
    TOKEN,
  );
  const userSilvAta = getAssociatedTokenAddressSync(
    SILV_MINT,
    user.publicKey,
    false,
    T22,
  );
  const ix = await (program.methods as any)
    .mintSilv(new BN(5_000_000), new BN(0))
    .accounts({
      config: pda("config"),
      user: user.publicKey,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      silvMintAuthority: pda("silv_mint_authority"),
      priceUpdate,
      classicTokenProgram: TOKEN,
      token2022Program: T22,
      associatedTokenProgram: ATA_PROG,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey,
      userSilvAta,
      user.publicKey,
      SILV_MINT,
      T22,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey,
      userUsdcAta,
      user.publicKey,
      USDC_MINT,
      TOKEN,
    ),
    ix,
  );
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user.publicKey;
  tx.sign(user);

  const ageAtSend = Math.floor(Date.now() / 1000) - pubTime;
  console.log(
    `sending mint consumer at ${Date.now() - t0}ms (price age ~${ageAtSend}s)`,
  );
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    const bal = await conn.getTokenAccountBalance(userSilvAta);
    console.log(
      `\n==== MINT OK ==== total ${Date.now() - t0}ms, SILV=${bal.value.uiAmountString}, sig=${sig}`,
    );
    console.log(
      "=> automated Pyth flow FITS in max_staleness=15s. Full lifecycle is testable now.",
    );
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const logs = (e?.logs ?? []).join("\n");
    const stale = /StaleOracle|stale/i.test(msg + logs);
    console.log(`\n==== MINT FAILED ==== ${msg}`);
    if (logs) console.log(logs.split("\n").slice(-12).join("\n"));
    console.log(
      stale
        ? "=> CONFIRMED: 15s is too tight even for an automated client. Pyth-gated paths (mint/instant-redeem/claim) are BLOCKED until max_staleness is raised (24h timelock). This empirically validates the deploy-config decision (raise to 90s)."
        : "=> Failed for a NON-staleness reason (see logs above).",
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
