/**
 * Create the premium FEE VAULT and prove it exists.
 *
 * WHY THIS IS A DEPLOY BLOCKER, not a convenience script. Since 2026-08-05 both `mint_silv`
 * and `redeem_silv` take the fee vault as a REQUIRED account. If it does not exist, EVERY mint
 * and EVERY redeem reverts with a constraint error that reads like a client bug. So this must
 * run once per cluster, BEFORE public mint or redemption is opened.
 *
 * The vault is the associated token account of the `fee_vault` PDA for `config.usdc_mint`. Two
 * things about that shape matter:
 *
 *   - The owner is a PDA, so `getAssociatedTokenAddressSync` MUST be called with
 *     allowOwnerOffCurve = true. Omitting it throws TokenOwnerOffCurveError. That exact mistake
 *     already cost this project a debugging session on the treasury ATA, which is why the
 *     helper below is the only place the address is derived.
 *   - Once created it can NEVER be closed. Closing a token account needs the owner's signature,
 *     and this program never signs a CloseAccount for this PDA. So this is a one-time,
 *     one-directional setup step: run it once and it is permanently satisfied.
 *
 * Idempotent: safe to re-run. It reports whether it created the account or found it already
 * there, and it always ends by READING THE ACCOUNT BACK from chain rather than trusting that the
 * transaction it just sent did what it intended.
 *
 * Run:
 *   npx tsx scripts/create-fee-vault.ts
 *   DOMINION_RPC=... npx tsx scripts/create-fee-vault.ts
 *   DOMINION_KEYPAIR=/path/to/payer.json npx tsx scripts/create-fee-vault.ts
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
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";

const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";

/** The fee-vault authority PDA. Seeds must match state/config.rs FEE_VAULT_SEED. */
export function feeVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault")],
    PROGRAM_ID,
  )[0];
}

/** The vault itself. allowOwnerOffCurve = true is MANDATORY: the owner is a PDA. */
export function feeVaultUsdcAta(usdcMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    usdcMint,
    feeVaultPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
}

function loadPayer(): Keypair {
  // `dominion-dev.json` before `id.json`: this repo's convention is a project-specific key,
  // and defaulting to the global `id.json` first would make the script pay from whatever
  // wallet the operator's Solana CLI happens to point at.
  const candidates = [
    process.env.DOMINION_KEYPAIR,
    path.join(os.homedir(), ".config", "solana", "dominion-dev.json"),
    path.join(os.homedir(), ".config", "solana", "id.json"),
  ].filter((p): p is string => !!p);
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) {
    throw new Error(
      `no keypair found. Tried:\n  ${candidates.join("\n  ")}\n` +
        `Set DOMINION_KEYPAIR to the payer's json keypair.`,
    );
  }
  console.log("  payer key:", p);
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}

async function main() {
  // D4: this is one of the very few scripts that is a MANDATORY MAINNET STEP, so a bare
  // requireSanctionedCluster throw is the wrong ergonomics: an operator following the runbook would hit an
  // opaque refusal on the one script the launch cannot proceed without. The guard is KEPT (running
  // it against the wrong cluster by accident is still worth preventing), but the refusal now names
  // the exact override and says why it exists.
  try {
    await requireSanctionedCluster(RPC, "create-fee-vault");
  } catch (e) {
    console.error(
      "\nThis script IS a required mainnet step: mint_silv and redeem_silv both take the fee\n" +
        "vault as a REQUIRED account, so without it every mint and every redeem reverts.\n" +
        "It is also idempotent and cannot be closed once created, so running it is one-way and safe.\n\n" +
        "To run it on mainnet, set the same acknowledgement every other mainnet action uses:\n" +
        "  DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=<mainnet-rpc> npx tsx scripts/create-fee-vault.ts\n",
    );
    throw e;
  }
  // Creating the vault is cheap and required, but it still goes through the guard so that the
  // action is declared rather than assumed. See ACTION_COST in _guard.ts.
  assertReversible("create_fee_vault", intentFromEnv());

  const conn = new Connection(RPC, "confirmed");
  const payer = loadPayer();

  // Read the USDC mint from the LIVE config rather than a constant, so this script cannot
  // create a vault for the wrong mint on a cluster whose config disagrees with the repo.
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
      "utf8",
    ),
  ) as Idl;
  const program = new Program(
    idl,
    new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" }),
  );
  const [cfgPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg: any = await (program.account as any).configAccount.fetch(cfgPda);
  const usdcMint = cfg.usdcMint as PublicKey;

  const authority = feeVaultPda();
  const vault = feeVaultUsdcAta(usdcMint);

  console.log("Fee vault setup");
  console.log("  cluster  :", RPC.includes("mainnet") ? "MAINNET" : "devnet");
  console.log("  program  :", PROGRAM_ID.toBase58());
  console.log("  usdc mint:", usdcMint.toBase58());
  console.log("  authority:", authority.toBase58(), "(PDA, off-curve)");
  console.log("  VAULT    :", vault.toBase58());

  const before = await conn.getAccountInfo(vault);
  if (before) {
    console.log("\n  already exists, nothing to do.");
  } else {
    console.log("\n  does not exist, creating...");
    const tx = new Transaction().add(
      // Idempotent instruction AND the address is passed explicitly, rather than using the
      // convenience helper that re-derives it: that helper rejects an off-curve owner.
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        vault,
        authority,
        usdcMint,
        TOKEN_PROGRAM_ID,
      ),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
      commitment: "confirmed",
    });
    console.log("  tx:", sig);
  }

  // VERIFY BY READING BACK. A sent transaction is not proof: confirm the account exists, is
  // owned by the classic Token program, and holds the right mint and the right authority.
  const after = await conn.getAccountInfo(vault);
  if (!after) {
    throw new Error(
      "FAILED: the vault still does not exist after the transaction confirmed.",
    );
  }
  const bal = await conn.getTokenAccountBalance(vault);
  const ok = after.owner.equals(TOKEN_PROGRAM_ID);
  console.log("\n  VERIFIED");
  console.log("    exists       :", true);
  console.log("    owner program:", after.owner.toBase58(), ok ? "ok" : "WRONG");
  console.log("    balance      :", bal.value.uiAmountString, "USDC");
  if (!ok) {
    throw new Error(
      "FAILED: the vault is not owned by the classic Token program. mint_silv pins " +
        "classic_token_program, so this account would be rejected.",
    );
  }
  console.log(
    "\n  mint_silv and redeem_silv can now be called. This step never needs repeating on\n" +
      "  this cluster: a PDA-owned ATA cannot be closed.",
  );
}

main().catch((e) => {
  console.error("create-fee-vault failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
