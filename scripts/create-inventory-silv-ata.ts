/**
 * Create the SILV associated token account of `config.inventory_wallet`, and prove it exists.
 *
 * A CEREMONY BLOCKER, not a convenience, and the gap it fills was found on 2026-08-12 by two
 * independent reviews of the launch plan.
 *
 * `admin_premint` takes `inventory_silv_ata` as an ALREADY EXISTING account: `premint.rs:41-46`
 * declares it `#[account(mut, token::mint = silv_mint, token::token_program = token_2022_program)]`
 * with no `init` and no `associated_token::authority`, and the handler's only ownership test is
 * `inventory_silv_ata.owner == config.inventory_wallet` at `:66-68`. Nothing in the program creates it.
 *
 * NOTHING ELSE IN THE REPO CREATED IT EITHER, on the mainnet shape:
 *  - `premint.ts:529` did, but it sat behind a refusal that fires when `config.admin` is off-curve, so
 *    it was unreachable exactly when it was needed.
 *  - The admin panel derives the address correctly (`admin-actions.ts:377-382`, with
 *    `allowOwnerOffCurve = true`) and then emits `admin_premint` alone. It creates nothing.
 *  - `create-fee-vault.ts` creates a different account: the USDC ATA of the `fee_vault` PDA.
 *  - T1 pre-creates the treasury USDC ATA, not this one.
 *
 * So the pre-mint would have reverted `AccountNotInitialized` at Squads-execute time, AFTER three
 * humans had approved the proposal. Recoverable, but it burns a full 3-of-5 approval round at the one
 * step that mints the launch supply.
 *
 * `allowOwnerOffCurve = true` IS MANDATORY HERE. Since 2026-08-12 `config.inventory_wallet` is the ops
 * Squads vault, a PDA. `getAssociatedTokenAddressSync` throws `TokenOwnerOffCurveError` without that
 * flag, which is the mistake `e2e-fixa-devnet.ts:128` still contains and which no devnet rehearsal ever
 * exercised, because devnet's inventory wallet was a plain keypair.
 *
 * PERMISSIONLESS: creating an ATA needs no signature from the owner, only a payer for the rent. So the
 * deployer can run this alone, with no Squads round.
 *
 * Idempotent: uses `createAssociatedTokenAccountIdempotentInstruction`, and it ends by READING THE
 * ACCOUNT BACK rather than trusting the transaction it just sent.
 *
 * Run: DOMINION_RPC=... [DOMINION_KEYPAIR=/path/to/payer.json] npx tsx scripts/create-inventory-silv-ata.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import os from "os";
import path from "path";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { resolveCluster } from "./_cluster";
import { redactRpc } from "./_redact";

const CLUSTER = resolveCluster();

function payerKeypair(): Keypair {
  const p =
    process.env.DOMINION_KEYPAIR ||
    path.join(os.homedir(), ".config", "solana", "dominion-dev.json");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main(): Promise<void> {
  await requireSanctionedCluster(CLUSTER.rpc, "create-inventory-silv-ata");
  // It DOES send, so it goes through the intent guard like every other sender. The action is classified
  // `reversible` in _guard.ts: an ATA holds only rent, and its owner can close it, which here costs a
  // 3-of-5 round. Slow, not impossible.
  assertReversible("create_inventory_silv_ata", intentFromEnv());

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const payer = payerKeypair();
  console.log("create inventory SILV ATA");
  console.log(`  cluster : ${redactRpc(CLUSTER.rpc)} (${CLUSTER.cluster})`);
  console.log(`  payer   : ${payer.publicKey.toBase58()}`);

  // READ THE DESTINATION FROM THE CHAIN, never from the manifest. The manifest is the intent; the config
  // account is what `admin_premint` will actually compare against. If they disagree, the chain wins and
  // creating the manifest's ATA would leave the pre-mint still reverting.
  const program = new Program(
    loadIdl() as Idl,
    new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" }),
  );
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
  const cfg = (await (program.account as never as Record<string, { fetch: (k: PublicKey) => Promise<Record<string, unknown>> }>)
    .configAccount.fetch(configPda)) as Record<string, unknown>;

  const owner = new PublicKey(String(cfg.inventoryWallet));
  const mint = new PublicKey(String(cfg.silvMint));
  const onCurve = PublicKey.isOnCurve(owner.toBytes());
  console.log(`  owner   : ${owner.toBase58()} (${onCurve ? "on-curve wallet" : "OFF-CURVE, a PDA"})`);
  console.log(`  mint    : ${mint.toBase58()}`);

  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  console.log(`  ATA     : ${ata.toBase58()}`);

  const before = await conn.getAccountInfo(ata);
  if (before) {
    console.log("  already exists, nothing to send.");
  } else {
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    );
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], {
      commitment: "confirmed",
    });
    console.log(`  created, signature ${sig}`);
  }

  // READ BACK. The transaction succeeding is not the same claim as the account being correct.
  const acct = await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
  const ownerOk = acct.owner.equals(owner);
  const mintOk = acct.mint.equals(mint);
  console.log("");
  console.log(`  read back owner : ${acct.owner.toBase58()} ${ownerOk ? "OK" : "*** MISMATCH ***"}`);
  console.log(`  read back mint  : ${acct.mint.toBase58()} ${mintOk ? "OK" : "*** MISMATCH ***"}`);
  console.log(`  balance         : ${acct.amount.toString()} atomic SILV`);
  if (!ownerOk || !mintOk) {
    console.error("\n  the account exists but does not match config. admin_premint will still revert.");
    process.exit(1);
  }
  console.log("\n  admin_premint's inventory_silv_ata precondition is satisfied.");
}

main().catch((e) => {
  console.error("create-inventory-silv-ata FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
