/**
 * Runbook step 8: guardians, inventory wallet, unpause. The four INSTANT admin calls, in one pass, with
 * every field read back off the chain afterwards.
 *
 * Written after the 2026-08-07 devnet rehearsal found this step had no script: the runbook listed four
 * instruction names for an operator to hand-type during a mainnet ceremony. It also listed
 * `set_treasury_min_float_usdc`, which does not exist. The float is TIMELOCKED
 * (propose_set_treasury_min_float), so it is NOT here: propose it alongside the public mint.
 *
 * Idempotent: each call is skipped if the chain already holds the target value.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";
import idl from "../target/idl/dominion_silver_mint.json";

function ceremony(): { guardians: string[]; inventoryWallet: string } {
  const a = JSON.parse(fs.readFileSync(`${__dirname}/../config/mainnet-authorities.json`, "utf8"));
  const g = a?.authorities?.guardian?.pubkey;
  const inv = a?.authorities?.inventory_wallet?.pubkey;
  if (!g || !inv) throw new Error("config/mainnet-authorities.json is missing guardian or inventory_wallet");
  const extra: string[] = a?.authorities?.additional_guardians?.map((x: { pubkey: string }) => x.pubkey) ?? [];
  return { guardians: [g, ...extra], inventoryWallet: inv };
}

async function main() {
  const CLUSTER = await resolveCluster();
  await requireSanctionedCluster(CLUSTER.rpc, "ceremony step 8: guardians, inventory, unpause");
  assertReversible("add_guardian", intentFromEnv());
  console.error(`# ${describeCluster(CLUSTER)}`);

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DOMINION_KEYPAIR!, "utf8"))),
  );
  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const M = program.methods as any;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const cfg = async (): Promise<any> => (program.account as any).configAccount.fetch(configPda);
  const gPda = (g: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("guardian"), g.toBuffer()], PROGRAM_ID)[0];
  const send = (ix: any) =>
    sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin], { commitment: "confirmed" });

  const { guardians, inventoryWallet } = ceremony();
  console.log(`  guardians a enregistrer : ${guardians.join(", ")}`);
  console.log(`  inventory wallet        : ${inventoryWallet}`);

  for (const g of guardians) {
    const pk = new PublicKey(g);
    if (await conn.getAccountInfo(gPda(pk))) {
      console.log(`  add_guardian(${g.slice(0, 8)}...): deja enregistre`);
      continue;
    }
    const sig = await send(
      await M.addGuardian(pk)
        .accounts({ config: configPda, admin: admin.publicKey, payer: admin.publicKey, guardianAccount: gPda(pk) })
        .instruction(),
    );
    console.log(`  add_guardian(${g.slice(0, 8)}...): ${sig}`);
  }

  const inv = new PublicKey(inventoryWallet);
  if ((await cfg()).inventoryWallet?.equals(inv)) {
    console.log("  set_inventory_wallet: deja a la bonne valeur");
  } else {
    const sig = await send(
      await M.setInventoryWallet(inv).accounts({ config: configPda, admin: admin.publicKey }).instruction(),
    );
    console.log(`  set_inventory_wallet: ${sig}`);
  }

  if (!(await cfg()).paused) {
    console.log("  unpause: deja depause");
  } else {
    const sig = await send(await M.unpause().accounts({ config: configPda, admin: admin.publicKey }).instruction());
    console.log(`  unpause: ${sig}`);
  }

  // Read every field back. A step that reports success without reading the chain proves nothing.
  const c = await cfg();
  let bad = 0;
  const ok = (cond: boolean, label: string, detail = "") => {
    if (!cond) bad++;
    console.log(`  ${cond ? "ok  " : "BAD "} ${label}${detail ? " -> " + detail : ""}`);
  };
  console.log("\n  relecture sur la chaine:");
  ok(c.paused === false, "paused est false");
  ok(c.inventoryWallet.equals(inv), "inventory_wallet", c.inventoryWallet.toBase58());
  ok(Number(c.guardianCount) >= guardians.length, "guardian_count", String(c.guardianCount));
  ok(Number(c.treasuryMinFloatUsdc) === 0, "treasury_min_float_usdc est encore 0 (timelocke, a proposer)", String(c.treasuryMinFloatUsdc));
  ok(c.publicMintEnabled === false, "public mint encore ferme (ouverture timelockee)");
  ok(c.redemptionsEnabled === false, "redemptions encore fermees (ouverture timelockee)");
  if (bad > 0) {
    console.error(`\n  ${bad} champ(s) inattendu(s). Ne pas continuer sans comprendre.`);
    process.exit(1);
  }
  console.log("\n  ETAPE 8 OK. Ensuite: etape 9 (pre-mint), 9b (fee vault), puis les TROIS propositions.");
}
main().catch((e) => {
  console.error("etape 8 echouee:", e instanceof Error ? e.message : e);
  process.exit(1);
});
