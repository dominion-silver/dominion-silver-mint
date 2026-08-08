/**
 * Runbook step 8: guardians, inventory wallet, unpause. The INSTANT admin calls, with every field read
 * back off the chain afterwards.
 *
 * Written after the 2026-08-07 devnet rehearsal found this step had no script: the runbook listed
 * instruction names for an operator to hand-type during a mainnet ceremony. It also listed
 * `set_treasury_min_float_usdc`, which does not exist. The float is TIMELOCKED
 * (propose_set_treasury_min_float), so it is not here.
 *
 * ROUND 5 P0-03 / D3: a BUILDER, not a sender. See scripts/_ceremony-emit.ts for why and for the
 * emit / verify / send contract.
 *
 * ROUND 5 P2-04: the resumption checks are now CONTENT checks. The old version accepted any existing
 * guardian PDA as "already registered" and asserted `guardian_count >= guardians.length`, which passes
 * with an unexpected guardian present. It now enumerates the exact expected set and fails on an extra.
 *
 * ROUND 5 P1-06 / D5: the readback no longer asserts `treasury_min_float_usdc == 0` as a thing "to be
 * proposed". D5 decided 0, so 0 is the destination, not a waypoint.
 *
 *   npx tsx scripts/ceremony-step8.ts             # EMIT the instructions (mainnet path)
 *   npx tsx scripts/ceremony-step8.ts --verify    # read the chain back and compare
 *   npx tsx scripts/ceremony-step8.ts --send      # devnet rehearsal only
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";
import { modeFromArgv, assertSendable, emit, sendAll, Checks, type CeremonyAction } from "./_ceremony-emit";
import idl from "../target/idl/dominion_silver_mint.json";

function ceremony(): { guardians: string[]; inventoryWallet: string } {
  const a = JSON.parse(fs.readFileSync(`${__dirname}/../config/mainnet-authorities.json`, "utf8"));
  const g = a?.authorities?.guardian?.pubkey;
  const inv = a?.authorities?.inventory_wallet?.pubkey;
  if (!g || !inv) throw new Error("config/mainnet-authorities.json is missing guardian or inventory_wallet");
  const extra: string[] = a?.authorities?.additional_guardians?.map((x: { pubkey: string }) => x.pubkey) ?? [];
  // Deduplicated: a guardian listed both as `guardian` and in `additional_guardians` would otherwise
  // make the expected-set comparison below fail against a chain that is perfectly correct.
  return { guardians: [...new Set([g, ...extra])], inventoryWallet: inv };
}

const guardianPda = (g: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("guardian"), g.toBuffer()], PROGRAM_ID)[0];

async function main() {
  const MODE = modeFromArgv(process.argv);
  const CLUSTER = await resolveCluster();
  await requireSanctionedCluster(CLUSTER.rpc, "ceremony step 8: guardians, inventory, unpause");
  if (MODE === "send") assertReversible("add_guardian", intentFromEnv());
  console.error(`# ${describeCluster(CLUSTER)}  mode=${MODE}`);

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const signer =
    MODE === "send"
      ? Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DOMINION_KEYPAIR!, "utf8"))),
        )
      : null;
  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(signer ?? Keypair.generate()),
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const M = program.methods as any;
  const cfg = async (): Promise<any> => (program.account as any).configAccount.fetch(configPda);

  const c0 = await cfg();
  const { guardians, inventoryWallet } = ceremony();
  const admin: PublicKey = MODE === "send" ? signer!.publicKey : c0.admin;
  console.log(`  config.admin      : ${c0.admin.toBase58()}${PublicKey.isOnCurve(c0.admin.toBytes()) ? "" : "  (off-curve)"}`);
  console.log(`  guardians to register: ${guardians.join(", ")}`);
  console.log(`  inventory wallet  : ${inventoryWallet}`);

  if (MODE === "verify") return verify(conn, await cfg(), guardians, inventoryWallet);

  if (MODE === "send") assertSendable(c0.admin, signer!.publicKey, "step 8");

  const actions: CeremonyAction[] = [];
  const inv = new PublicKey(inventoryWallet);

  for (const g of guardians) {
    const pk = new PublicKey(g);
    const exists = (await conn.getAccountInfo(guardianPda(pk))) != null;
    actions.push({
      label: `add_guardian(${g})`,
      intent:
        "Registers a guardian: pause, cancel a timelocked action, cancel an admin transfer. Instant, " +
        "and add_guardian refuses config.admin itself.",
      alreadyDone: exists,
      // P2-04: "the PDA exists" is now stated as what it is. The set comparison in verify() is what
      // actually decides, because presence of the right ones does not exclude presence of a wrong one.
      observed: exists ? `guardian PDA ${guardianPda(pk).toBase58()} already exists` : undefined,
      ix: await M.addGuardian(pk)
        .accounts({ config: configPda, admin, payer: admin, guardianAccount: guardianPda(pk) })
        .instruction(),
    });
  }

  const invDone = c0.inventoryWallet != null && new PublicKey(c0.inventoryWallet).equals(inv);
  actions.push({
    label: `set_inventory_wallet(${inventoryWallet})`,
    intent: "Destination of admin_premint. Instant, and redirectable later, which is why it emits an event.",
    alreadyDone: invDone,
    observed: invDone ? `already ${inventoryWallet}` : `currently ${c0.inventoryWallet?.toBase58?.() ?? "unset"}`,
    ix: await M.setInventoryWallet(inv).accounts({ config: configPda, admin }).instruction(),
  });

  actions.push({
    label: "unpause()",
    intent: "Lifts the launch pause. Instant in both directions; pause stays instant afterwards.",
    alreadyDone: c0.paused === false,
    observed: c0.paused === false ? "already unpaused" : undefined,
    ix: await M.unpause().accounts({ config: configPda, admin }).instruction(),
  });

  if (MODE === "send") {
    await sendAll(conn, signer!, actions);
    return verify(conn, await cfg(), guardians, inventoryWallet);
  }
  emit("step8", describeCluster(CLUSTER), actions);
  console.log(`\n  After the Squads executions land, run:  npx tsx scripts/ceremony-step8.ts --verify`);
}

async function verify(
  conn: Connection,
  c: any,
  guardians: string[],
  inventoryWallet: string,
): Promise<void> {
  const ck = new Checks();
  console.log("\n  reading the chain back:");
  ck.eq("paused", c.paused, false);
  ck.eq("inventory_wallet", c.inventoryWallet.toBase58(), inventoryWallet);

  // ROUND 5 P2-04. The EXACT set, not a count and not a floor. `guardian_count >= expected.length`
  // passed with a guardian nobody chose registered alongside the ones we did, which is precisely the
  // state a resumed ceremony can reach and precisely the one that matters.
  const present: string[] = [];
  for (const g of guardians) {
    if (await conn.getAccountInfo(guardianPda(new PublicKey(g)))) present.push(g);
  }
  ck.sameSet("registered guardians (of the expected set)", present, guardians);
  // And the COUNT must agree with the set, which is what catches an extra guardian whose key we do not
  // know and therefore cannot look up by PDA.
  ck.eq("guardian_count equals the expected set size", Number(c.guardianCount), guardians.length);

  ck.eq("public mint still closed (step 10 opens it)", c.publicMintEnabled, false);
  ck.eq("redemptions closed (launch posture)", c.redemptionsEnabled, false);
  // D5: a value, not a verdict.
  ck.note("treasury_min_float_usdc", `${c.treasuryMinFloatUsdc} (D5 ships 0, risk accepted)`);
  console.log("\n  Next: step 9 (pre-mint), 9b (fee vault), then step 10 executes the queued proposal(s).");
  ck.finish("step 8");
}

main().catch((e) => {
  console.error("step 8 failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
