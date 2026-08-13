/**
 * Create the USDC TREASURY token account early, so it can be funded BEFORE the launch ceremony.
 *
 * WHY EARLY IS SAFE AND NOT A WORKAROUND. `initialize` opens this account with `init_if_needed` and
 * validates it against the same three constraints it would have created it with (mint, authority,
 * token program). That shape is deliberate: audit DOM-002 pointed out that creating an ATA is
 * PERMISSIONLESS, so with a plain `init` a stranger could pre-create exactly this one and make
 * `initialize` fail forever. So an already-present, correctly-formed account is accepted, and creating
 * it ourselves is the same path a stranger could take, taken deliberately.
 *
 * WHY THE ADDRESS CANNOT MOVE BETWEEN NOW AND THE DEPLOY, which is the question worth answering before
 * anyone sends money: it derives from the program ID, not from the deployment. `declare_id!` already
 * fixes the id, the keypair for it exists, and deploying a program AT an id does not change the id. So
 * the treasury PDA and its ATA are already determined. The one thing that would move them is a change
 * of program id.
 *
 * THE RISK OF FUNDING EARLY, stated plainly because money is involved: USDC sent here is movable only
 * by a program deployed at that id. If the id were ever lost or burned, the funds would be stranded
 * PERMANENTLY, because the account's owner is a PDA of that specific id and nothing else can sign for
 * it. Send a small amount first; keep the rest until `initialize` has run.
 *
 * The rent for this account is locked for the life of the program, exactly like the fee vault: the
 * owner is a PDA and the program signs no CloseAccount for it.
 *
 *   DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=https://api.mainnet-beta.solana.com \
 *     DOMINION_INTENT=create_usdc_treasury npx tsx scripts/create-usdc-treasury-ata.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { resolveCluster } from "./_cluster";

const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;

function loadPayer(): Keypair {
  const explicit = process.env.DOMINION_KEYPAIR;
  const p = explicit ?? path.join(os.homedir(), ".config", "solana", "dominion-dev.json");
  if (!fs.existsSync(p)) throw new Error(`no payer keypair at ${p}`);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  await requireSanctionedCluster(RPC, "create-usdc-treasury-ata");
  assertReversible("create_usdc_treasury", intentFromEnv());

  const conn = new Connection(RPC, "confirmed");
  const payer = loadPayer();
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID);
  // The cluster's OWN USDC mint, resolved rather than typed: a devnet literal here would create a
  // devnet-USDC account on mainnet, at an address nobody would be sending to.
  const usdcMint = CLUSTER.usdcMint;
  // allowOwnerOffCurve = true is MANDATORY: the owner is a PDA and the helper throws otherwise.
  const ata = getAssociatedTokenAddressSync(usdcMint, treasuryPda, true, TOKEN_PROGRAM_ID);

  console.log("USDC treasury account");
  console.log("  cluster     :", RPC);
  console.log("  program     :", PROGRAM_ID.toBase58());
  console.log("  usdc mint   :", usdcMint.toBase58());
  console.log("  treasury PDA:", treasuryPda.toBase58(), PublicKey.isOnCurve(treasuryPda.toBytes()) ? "(ON-curve?!)" : "(off-curve, as expected)");
  console.log("  ADDRESS     :", ata.toBase58());
  console.log("  payer       :", payer.publicKey.toBase58());

  // Read the mint back before spending anything: 6 decimals is what every amount in this system
  // assumes, and a mint that disagreed would mean the resolved address is not the USDC anyone means.
  const mint = await getMint(conn, usdcMint, "confirmed", TOKEN_PROGRAM_ID);
  if (mint.decimals !== 6) {
    throw new Error(`the resolved USDC mint has ${mint.decimals} decimals, expected 6. Wrong mint.`);
  }

  const existing = await conn.getAccountInfo(ata);
  if (existing) {
    const acc = await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID);
    console.log("\n  it ALREADY exists. Nothing to do.");
    console.log(`    owner  : ${acc.owner.toBase58()} ${acc.owner.equals(treasuryPda) ? "ok" : "MISMATCH"}`);
    console.log(`    mint   : ${acc.mint.toBase58()} ${acc.mint.equals(usdcMint) ? "ok" : "MISMATCH"}`);
    console.log(`    balance: ${Number(acc.amount) / 1e6} USDC`);
    return;
  }

  const sig = await (async () => {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ata,
        treasuryPda,
        usdcMint,
        TOKEN_PROGRAM_ID,
      ),
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    const s = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(s, "confirmed");
    return s;
  })();
  console.log("\n  created:", sig);

  // READ IT BACK. The transaction confirming is not the same claim as the account being what we meant.
  const acc = await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID);
  const ownerOk = acc.owner.equals(treasuryPda);
  const mintOk = acc.mint.equals(usdcMint);
  console.log(`    owner  : ${acc.owner.toBase58()} ${ownerOk ? "ok" : "MISMATCH"}`);
  console.log(`    mint   : ${acc.mint.toBase58()} ${mintOk ? "ok" : "MISMATCH"}`);
  console.log(`    balance: ${Number(acc.amount) / 1e6} USDC`);
  if (!ownerOk || !mintOk) throw new Error("the account that was created is not the one intended");

  console.log("\n  SEND USDC TO:", ata.toBase58());
  console.log("  Start with a small amount. It is movable only by a program deployed at");
  console.log("  " + PROGRAM_ID.toBase58() + ", so it is not recoverable before `initialize` runs.");
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
