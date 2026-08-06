/**
 * Create the premium FEE VAULT and prove it exists. A DEPLOY BLOCKER, not a convenience: mint_silv
 * and redeem_silv both take the fee vault as a REQUIRED account, so until it exists every mint and
 * every redeem reverts with a constraint error that reads like a client bug. Run once per cluster,
 * BEFORE public mint or redemption is opened.
 *
 * The vault is the ATA of the `fee_vault` PDA for `config.usdc_mint`, and once created it can NEVER
 * be closed: closing needs the owner's signature and this program never signs CloseAccount for that
 * PDA. So the step is one-way and idempotent, and it ends by READING THE ACCOUNT BACK rather than
 * trusting the transaction it just sent.
 * Run: [DOMINION_RPC=...] [DOMINION_KEYPAIR=/path/to/payer.json] npx tsx scripts/create-fee-vault.ts
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
  // dominion-dev.json before id.json: defaulting to the global key would pay from whatever wallet
  // the operator's Solana CLI happens to point at.
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
  // A MANDATORY MAINNET STEP, so the guard is kept (an accidental wrong cluster is still worth
  // preventing) but its refusal names the exact override: an opaque throw on the one script the
  // launch cannot proceed without is the wrong ergonomics.
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
  // Cheap and required, but still declared rather than assumed. See ACTION_COST in _guard.ts.
  assertReversible("create_fee_vault", intentFromEnv());

  const conn = new Connection(RPC, "confirmed");
  const payer = loadPayer();

  // USDC mint from the LIVE config, never a constant: a cluster whose config disagrees with the repo
  // would otherwise get a vault for the wrong mint.
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
      // Address passed explicitly: the convenience helper re-derives it and rejects an off-curve owner.
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

  // VERIFY BY READING BACK: a sent transaction is not proof.
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
