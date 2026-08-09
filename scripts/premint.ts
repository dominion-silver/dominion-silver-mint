/**
 * admin_premint against a LIVE cluster, in tranches, with a read-back after every tranche.
 *
 * WHY IT EXISTS. Runbook step 9 says to run `admin_premint(<atomic>)` and, until this file, NOTHING
 * in the repo sent it. The only two senders were scripts/e2e-fixa-devnet.ts, a test pinned at
 * 1000 oz, and the admin panel. So the one ceremony step that mints the entire launch supply was the
 * step with no tooling, three days before mainnet. Found during the devnet rehearsal of 2026-08-10.
 *
 * WHY TRANCHES ARE THE INTERFACE, and not a single amount. D11 (2026-08-09) makes
 * pre-mint-the-operational-tranche-only a RULE: the inventory wallet is a single-signer key and, with
 * redemptions open at launch, whoever holds it can call redeem_silv directly with no timelock. The
 * bound is the rolling window and the REAL bound is ~2x the budget over one window. So the shape of
 * this script is the shape of the decision: a list, re-runnable, never one irreversible number.
 *
 * `admin_premint` is `reversible` in _guard.ts's table because the cap bounds it. That is about the
 * SUPPLY, not about custody: minted tokens sit in a hot wallet and nothing here can pull them back.
 *
 *   npx tsx scripts/premint.ts --oz 1000                 # one tranche, ounces
 *   npx tsx scripts/premint.ts --atomic 106115340615     # one tranche, atomic (6dp)
 *   npx tsx scripts/premint.ts --atomic 106115340615 --atomic 43884659385   # two
 *   npx tsx scripts/premint.ts --oz 1000 --dry-run       # resolve and print, send nothing
 *
 * Size the tranches with scripts/premint-sizing.ts AT CEREMONY TIME: the budget is in dollars and the
 * cap is in ounces, so a fall in the silver price raises the ounces a fixed budget buys.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import idl from "../target/idl/dominion_silver_mint.json";

const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";
const DRY_RUN = process.argv.includes("--dry-run");

/** 6 decimals, fixed at mint creation and not negotiable. An off-by-1e6 here is a 1,000,000x error. */
const DECIMALS = 6n;

/**
 * Tranches from argv, in order, as atomic u64 strings. `--oz` is a convenience that multiplies by
 * 1e6; `--atomic` is what premint-sizing.ts prints, so it is the form to prefer at a ceremony.
 * Rejects a non-integer ounce figure rather than truncating it: 0.5 oz silently becoming 0 is the
 * class of bug this whole file is defensive about.
 */
function tranchesFromArgv(): bigint[] {
  const out: bigint[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--oz" && flag !== "--atomic") continue;
    const raw = argv[i + 1];
    if (!raw) throw new Error(`${flag} needs a value`);
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${flag} value must be a positive number, got ${raw}`);
    if (flag === "--atomic") {
      if (raw.includes(".")) throw new Error(`--atomic must be an integer, got ${raw}`);
      out.push(BigInt(raw));
    } else {
      const [whole, frac = ""] = raw.split(".");
      if (frac.length > Number(DECIMALS)) {
        throw new Error(`--oz has at most ${DECIMALS} decimal places, got ${raw}`);
      }
      out.push(BigInt(whole) * 10n ** DECIMALS + BigInt(frac.padEnd(Number(DECIMALS), "0") || "0"));
    }
    if (out[out.length - 1] === 0n) throw new Error(`${flag} ${raw} resolves to zero atomic units`);
  }
  return out;
}

function loadAdmin(): Keypair {
  const candidates = [
    process.env.DOMINION_KEYPAIR,
    path.join(os.homedir(), ".config", "solana", "dominion-dev.json"),
  ].filter((p): p is string => !!p);
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) throw new Error("no admin keypair found; set DOMINION_KEYPAIR");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function fmtOz(atomic: bigint): string {
  const oz = Number(atomic) / Number(10n ** DECIMALS);
  return oz.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

async function main() {
  const tranches = tranchesFromArgv();
  if (tranches.length === 0) {
    throw new Error("no tranche given. Use --oz <n> or --atomic <n>, repeatable.");
  }
  await requireSanctionedCluster(RPC, "premint");
  assertReversible("admin_premint", intentFromEnv());

  const kp = loadAdmin();
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl as Idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    PROGRAM_ID,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await (program.account as any).configAccount.fetch(configPda);
  const silvMint = new PublicKey(cfg.silvMint);
  // The CONFIGURED destination, never the signer's own ATA. premint.rs checks the owner of this
  // account against config.inventory_wallet, and that check is the only thing in the entire program
  // that reads inventory_wallet, so this is where it is exercised for real.
  const inventoryWallet = new PublicKey(cfg.inventoryWallet);
  if (inventoryWallet.equals(PublicKey.default)) {
    throw new Error("config.inventory_wallet is the zero pubkey; premint would revert");
  }
  const cap = BigInt(cfg.maxSilvSupply.toString());

  console.log("premint");
  console.log("  cluster  :", RPC);
  console.log("  program  :", PROGRAM_ID.toBase58());
  console.log("  admin    :", kp.publicKey.toBase58());
  console.log("  silv mint:", silvMint.toBase58());
  console.log("  inventory:", inventoryWallet.toBase58());

  const supply0 = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const total = tranches.reduce((a, b) => a + b, 0n);
  console.log(`  cap      : ${cap} (${fmtOz(cap)} oz)`);
  console.log(`  minted   : ${supply0} (${fmtOz(supply0)} oz)`);
  console.log(`  planned  : ${total} (${fmtOz(total)} oz) in ${tranches.length} tranche(s)`);

  // Refuse the WHOLE plan before sending the first tranche. Discovering the cap at tranche 3 leaves
  // the supply somewhere nobody chose, and there is no un-mint.
  if (supply0 + total > cap) {
    throw new Error(
      `the plan exceeds the cap: ${supply0} minted + ${total} planned = ${supply0 + total} > ${cap}. ` +
        `max_silv_supply is TIGHTEN-ONLY, so the cap cannot be raised to fit this.`,
    );
  }
  const headroomAfter = cap - supply0 - total;
  console.log(
    `  headroom after: ${headroomAfter} (${fmtOz(headroomAfter)} oz) left for PUBLIC MINT, ` +
      `which draws on the SAME cap`,
  );
  if (headroomAfter === 0n) {
    console.log(
      "  WARNING: zero headroom. mint_silv will revert SupplyCapExceeded until something is redeemed.",
    );
  }

  if (DRY_RUN) {
    console.log("\n  --dry-run: nothing sent.");
    return;
  }

  const invAta = getAssociatedTokenAddressSync(
    silvMint,
    inventoryWallet,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  await createAssociatedTokenAccountIdempotent(
    conn,
    kp,
    silvMint,
    inventoryWallet,
    {},
    TOKEN_2022_PROGRAM_ID,
  );
  console.log("  inv ATA  :", invAta.toBase58());

  for (const [i, amt] of tranches.entries()) {
    const supplyBefore = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    const balBefore = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const sig = await program.methods
      .adminPremint(new BN(amt.toString()))
      .accounts({
        config: configPda,
        admin: kp.publicKey,
        silvMint: silvMint,
        inventorySilvAta: invAta,
        silvMintAuthority: mintAuthPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    const supplyAfter = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    const balAfter = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    console.log(`\n  tranche ${i + 1}/${tranches.length}: ${amt} (${fmtOz(amt)} oz)  tx ${sig}`);
    console.log(`    supply  ${supplyBefore} -> ${supplyAfter}`);
    console.log(`    inv ATA ${balBefore} -> ${balAfter}`);
    // Both deltas, not just the supply: a mint that lands in the WRONG account still moves supply.
    if (supplyAfter - supplyBefore !== amt || balAfter - balBefore !== amt) {
      throw new Error(
        `tranche ${i + 1} did not move supply AND the inventory ATA by exactly ${amt}. ` +
          `supply delta=${supplyAfter - supplyBefore}, ata delta=${balAfter - balBefore}. STOPPING.`,
      );
    }
    console.log("    OK: supply and inventory both moved by exactly the tranche");
  }

  const finalSupply = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  console.log(`\n  final supply : ${finalSupply} (${fmtOz(finalSupply)} oz)`);
  console.log(`  headroom left: ${cap - finalSupply} (${fmtOz(cap - finalSupply)} oz)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
