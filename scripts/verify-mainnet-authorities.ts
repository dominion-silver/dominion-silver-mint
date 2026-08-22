/**
 * Verify every address in config/mainnet-authorities.json against the live cluster,
 * BEFORE the mainnet deploy ceremony.
 * Why this exists: the mainnet authority assignment contains decisions that are
 * irreversible at mint creation (freeze authority, permanent delegate) or expensive to
 * undo (upgrade authority, admin). A single mistyped base58 character produces a valid
 * pubkey that nobody controls, and the failure is silent: `initialize` succeeds, the
 * program looks healthy, and the compliance lever simply does not work when it is
 * finally needed. This script makes the ceremony reproducible from a reviewed file
 * instead of from a terminal command line.
 * Run:
 *   npx tsx scripts/verify-mainnet-authorities.ts              # mainnet
 *   DOMINION_RPC=https://api.devnet.solana.com npx tsx ...     # rehearse on devnet
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const CFG_PATH = path.join(__dirname, "..", "config", "mainnet-authorities.json");
const RPC = process.env.DOMINION_RPC || "https://api.mainnet-beta.solana.com";

/** Rent for a program of this size, so "is the deployer funded" is answerable. */
const PROGRAM_BYTES_ESTIMATE = 1_101_000;

let pass = 0;
let warn = 0;
let fail = 0;
function ok(msg: string, detail = "") {
  console.log(`  PASS  ${msg}${detail ? ` -> ${detail}` : ""}`);
  pass++;
}
function bad(msg: string, detail = "") {
  console.log(`  FAIL  ${msg}${detail ? ` -> ${detail}` : ""}`);
  fail++;
}
function caution(msg: string, detail = "") {
  console.log(`  WARN  ${msg}${detail ? ` -> ${detail}` : ""}`);
  warn++;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  const conn = new Connection(RPC, "confirmed");
  const a = cfg.authorities as Record<
    string,
    { pubkey: string; role: string; kind: string }
  >;

  console.log("Mainnet authority verification");
  console.log("  rpc:", RPC);
  console.log("  config:", CFG_PATH, "\n");

  // 1. Every address must be a syntactically valid pubkey. A typo usually still
  //    decodes, which is exactly why the checks below matter more than this one.
  const keys: Record<string, PublicKey> = {};
  for (const [role, entry] of Object.entries(a)) {
    // `_`-prefixed entries are prose, not addresses. That convention is used throughout this manifest
    // and was not honoured here, so adding a note inside `authorities` made the gate report
    // "_squads_facts_verified_2026_08_12 is NOT a valid pubkey" and refuse the ceremony outright.
    if (role.startsWith("_")) continue;
    try {
      keys[role] = new PublicKey(entry.pubkey);
      ok(`${role} is a valid pubkey`, entry.pubkey);
    } catch {
      bad(`${role} is NOT a valid pubkey`, entry.pubkey);
    }
  }

  console.log("\n2. Multisig vs single-signer (on-curve test)");
  // A Squads vault is a PDA and is therefore off-curve. A keypair-backed wallet is
  // on-curve. This is the only way to tell them apart from the outside, because a
  // vault holding lamports and no data is System-owned exactly like a wallet.
  // `inventory_wallet` MOVED FROM expectWallet TO expectPda on 2026-08-12: it was an on-curve hot
  // wallet and is now the ops Squads vault, so the old classification emitted a caution reading
  // "Intended to be a plain wallet", the opposite of the current design.
  const expectPda = ["ops_admin", "upgrade_authority", "compliance", "guardian", "inventory_wallet"];
  const expectWallet = ["deployer", "inventory_transit_wallet"];
  for (const role of expectPda) {
    if (!keys[role]) continue;
    const onCurve = PublicKey.isOnCurve(keys[role].toBytes());
    if (onCurve) {
      bad(
        `${role} is ON-CURVE, i.e. a single-signer wallet, but the design requires a multisig`,
        keys[role].toBase58(),
      );
    } else {
      ok(`${role} is off-curve (PDA, consistent with a Squads vault)`);
    }
  }
  for (const role of expectWallet) {
    if (!keys[role]) continue;
    const onCurve = PublicKey.isOnCurve(keys[role].toBytes());
    if (onCurve) ok(`${role} is a plain wallet, as intended`);
    else caution(`${role} is off-curve (a PDA). Intended to be a plain wallet.`);
  }

  console.log("\n3. Role separation");
  // The separation that actually matters to the CODE: add_guardian refuses
  // config.admin, and GuardianAccount::may_act refuses a guardian that IS the admin.
  // If these collide, the guardian veto is silently inert.
  if (keys.guardian && keys.ops_admin) {
    if (keys.guardian.equals(keys.ops_admin)) {
      bad(
        "guardian == ops_admin. add_guardian will REJECT it (Unauthorized) and the veto cannot exist",
      );
    } else {
      ok("guardian != ops_admin (the veto is exercisable)");
    }
  }
  if (keys.upgrade_authority && keys.ops_admin) {
    if (keys.upgrade_authority.equals(keys.ops_admin)) {
      bad(
        "upgrade_authority == ops_admin: one key compromise is a total takeover (SolidProof MEDIUM #1)",
      );
    } else {
      ok("upgrade_authority != ops_admin");
    }
  }
  // inventory_wallet == ops_admin is a DECISION, not a defect: no program check forbids it, initialize
  // only rejects Pubkey::default. Surfaced rather than left silent, because it is the one collision in
  // this file that a reader would otherwise assume is a mistake.
  if (keys.inventory_wallet && keys.ops_admin) {
    if (keys.inventory_wallet.equals(keys.ops_admin)) {
      caution(
        "inventory_wallet == ops_admin. DELIBERATE since 2026-08-12: the float sits behind the same " +
          "3-of-5 that authorises the pre-mint. Loses separation between who mints and who custodies; " +
          "buys moving the float off a single key that was also a signer of both multisigs.",
      );
    } else {
      ok("inventory_wallet != ops_admin");
    }
  }
  if (keys.upgrade_authority && keys.compliance) {
    if (keys.upgrade_authority.equals(keys.compliance)) {
      caution(
        "upgrade_authority == compliance. ACCEPTED for launch, tracked as a follow-up: " +
          "a compromise of this one vault can both rewrite the program and freeze/seize any holder",
      );
    } else {
      ok("upgrade_authority != compliance (fully split)");
    }
  }

  console.log("\n4. Existence and funding on the live cluster");
  for (const [role, key] of Object.entries(keys)) {
    const info = await conn.getAccountInfo(key);
    if (!info) {
      if (role === "deployer") {
        bad(
          "deployer does not exist on this cluster and cannot pay for a deploy",
          "fund it first",
        );
      } else {
        caution(
          `${role} does not exist on this cluster yet (no lamports)`,
          "fine for an authority that has never received SOL, but confirm it is the right address",
        );
      }
      continue;
    }
    const sol = info.lamports / 1e9;
    ok(`${role} exists`, `${sol.toFixed(6)} SOL`);
  }

  console.log("\n5. Deploy funding");
  // MEASURED, not estimated. The devnet deploy of a 1,068,168-byte artifact on
  // 2026-07-26 moved the payer from 11.596 to 5.415 SOL (6.18 SOL net) and left
  // 7.44 SOL sitting in the program account as rent. The current CLI allocates the
  // artifact's own length rather than 2x, and the deploy buffer's rent is refunded
  // when it converts into the ProgramData account. So the requirement is roughly one
  // rent-exemption plus fees, and 9 SOL is a comfortable ceiling for a ~1.1 MB
  // program. Do NOT use 2x: it over-asks by ~7 SOL and invites a wrong funding call.
  const rent = await conn.getMinimumBalanceForRentExemption(PROGRAM_BYTES_ESTIMATE);
  const needed = rent / 1e9 + 1.5;
  const dep = keys.deployer ? await conn.getAccountInfo(keys.deployer) : null;
  const have = dep ? dep.lamports / 1e9 : 0;
  console.log(
    `  program rent for ~${PROGRAM_BYTES_ESTIMATE} bytes: ${(rent / 1e9).toFixed(3)} SOL`,
  );
  console.log(
    `  recommended deployer balance (rent + headroom for fees): ~${needed.toFixed(2)} SOL`,
  );
  // This line said the rent "is RECOVERABLE with `solana program close` if the id is ever retired".
  // Deleted 2026-08-10, the same day the identical sentence was deleted from the runbook's funding
  // checklist. It is true about the lamports and catastrophic as advice, and it printed directly
  // under a red funding line, which is exactly when somebody is looking for SOL. Closing a program id
  // destroys it FOREVER; this project has already done it once and gc5TWUkm… still answers "has been
  // closed". Losing 3ucji6… means losing declare_id!, the IDL, every PDA and the audited surface.
  console.log(
    "  note: this rent is LOCKED for the life of the program. Do NOT plan to recover it:" +
      " `solana program close` destroys the program id permanently and there is no situation" +
      " in this launch where that is the right answer (a bad deploy is fixed by deploying again).",
  );
  if (have >= needed) ok("deployer is funded for the deploy", `${have.toFixed(3)} SOL`);
  else bad("deployer is NOT funded for the deploy", `${have.toFixed(3)} SOL available`);

  console.log("\n6. Cluster-specific constants in the config");
  // Read from `cluster_constants`, the single source: the same address in two places is how they drift.
  const cc = cfg.cluster_constants ?? {};
  const expectedUsdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const expectedLazerTreasury = "Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak";
  cc.usdc_mint === expectedUsdc
    ? ok("USDC mint is the mainnet mint")
    : bad("USDC mint is not the mainnet mint", cc.usdc_mint);
  cc.lazer_treasury === expectedLazerTreasury
    ? ok("Lazer treasury is the mainnet value (it is cluster-specific)")
    : bad("Lazer treasury is not the mainnet value", cc.lazer_treasury);

  console.log(`\n=== ${pass} passed, ${warn} warnings, ${fail} failures ===`);
  if (fail > 0) {
    console.log("DO NOT run the mainnet ceremony until the failures above are resolved.");
    process.exit(1);
  }
  if (warn > 0) {
    console.log("Proceed only if every warning above is a consciously accepted risk.");
  }
}

main().catch((e) => {
  console.error("verification crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
