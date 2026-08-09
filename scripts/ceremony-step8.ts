/**
 * Runbook step 8: guardians and unpause. The INSTANT admin calls, with every field read back off the
 * chain afterwards.
 *
 * ROUND 8 T8-03 removed the inventory wallet from this step. `initialize` binds it atomically from
 * its own arguments and `set_inventory_wallet` no longer exists, so there is nothing left to send.
 * What replaced it is a CHECK: if the chain holds an inventory wallet that is not the one in the
 * manifest, this script REFUSES the whole step. Continuing would mean unpausing a protocol whose
 * pre-mint destination is an address nobody in this ceremony chose, and the only repair is a 24h
 * timelocked change, so the refusal has to come before the unpause and not after it.
 *
 * ROUND 8 also made `unpause` require an ACTIVE guardian distinct from the admin, which is why the
 * add_guardian actions must land BEFORE the unpause in the same step.
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
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";
import { modeFromArgv, assertSendable, emit, sendAll, Checks, type CeremonyAction } from "./_ceremony-emit";
// ROUND 8 L1-04: the go-live preconditions live in ONE decision function, shared with
// scripts/test-launch-open-readiness.ts, so the rule the test exercises is the rule that gates here.
import { decideLaunchReadiness, type LaunchState } from "./_launch-readiness";
import idl from "../target/idl/dominion_silver_mint.json";

export function ceremony(): { guardians: string[]; inventoryWallet: string } {
  const a = JSON.parse(fs.readFileSync(`${__dirname}/../config/mainnet-authorities.json`, "utf8"));
  const g = a?.authorities?.guardian?.pubkey;
  const inv = a?.authorities?.inventory_wallet?.pubkey;
  if (!g || !inv) throw new Error("config/mainnet-authorities.json is missing guardian or inventory_wallet");
  const extra: string[] = a?.authorities?.additional_guardians?.map((x: { pubkey: string }) => x.pubkey) ?? [];
  // Deduplicated: a guardian listed both as `guardian` and in `additional_guardians` would otherwise
  // make the expected-set comparison below fail against a chain that is perfectly correct.
  return { guardians: [...new Set([g, ...extra])], inventoryWallet: inv };
}

export const guardianPda = (g: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("guardian"), g.toBuffer()], PROGRAM_ID)[0];

/** Everything `buildStep8Actions` needs, with the chain reads already done by the caller. Split out so
 *  the builder is PURE and importable: `scripts/test-ceremony-inventory-flow.ts` drives this exact
 *  function and decodes the instructions it returns, rather than re-deriving what it thinks step 8
 *  would emit. Importing this module must therefore not run `main`, which is why the entrypoint below
 *  is guarded. */
export interface Step8Input {
  program: anchor.Program;
  configPda: PublicKey;
  admin: PublicKey;
  guardians: string[];
  /** Resumption: which guardian PDAs already exist on chain. */
  guardianExists: (pda: PublicKey) => boolean;
  paused: boolean;
  /** `config.inventory_wallet` as the chain holds it. `initialize` is the only thing that can have
   *  written it, so on a correct deployment it already equals `expectedInventoryWallet`. */
  boundInventoryWallet: PublicKey;
  /** The address `config/mainnet-authorities.json` names. */
  expectedInventoryWallet: PublicKey;
  /** Whether the premium fee vault ATA exists. ROUND 8 made this a PRECONDITION of the unpause;
   *  see `FeeVaultMissing` for why the old runbook order no longer holds. */
  feeVaultExists: boolean;
  /** ROUND 8 L1-04, made MANDATORY by F-01. It was optional, and `main()` never filled it, so the
   *  real ceremony emitted the unpause after the inventory and fee-vault checks alone and never
   *  evaluated the treasury, the feed, the publisher floor, the oracle probe or the public app. The
   *  repository showed a green readiness suite while the go-live path ran none of it.
   *
   *  Optional was the defect. A caller that cannot gather this state cannot be about to unpause. */
  readiness: LaunchState;
}

/** Thrown when the chain's pre-mint destination is not the one this ceremony was authorised for. Its
 *  own class so a caller can tell it apart from a transport failure and so the test can assert on it. */
export class InventoryWalletMismatch extends Error {
  constructor(
    readonly onChain: PublicKey,
    readonly expected: PublicKey,
  ) {
    super(
      `config.inventory_wallet is ${onChain.toBase58()} but config/mainnet-authorities.json names ` +
        `${expected.toBase58()}. initialize binds this field atomically and no instruction can set it ` +
        `instantly, so this deployment was initialized with a different destination. REFUSING step 8: ` +
        `unpausing here would open mint and redeem against a pre-mint destination nobody in this ` +
        `ceremony chose. The only repair is propose_set_inventory_wallet plus the 24h timelock.`,
    );
    this.name = "InventoryWalletMismatch";
  }
}

/**
 * Thrown when the unpause would go out before the premium fee vault exists.
 *
 * THE ORDER CHANGED WITH THE POSTURE, and this is the trap it opened. Under the old posture the
 * unpause did not make the priced path usable: the public mint stayed closed until a separate
 * timelocked step, and the runbook only needed the vault before THAT. Round 8 opens both switches at
 * `initialize`, so the unpause IS the go-live, and `mint_silv` and `redeem_silv` both take the fee
 * vault as a REQUIRED account. Unpausing without it publishes a protocol where every mint and every
 * redeem reverts `AccountNotInitialized`, which reads to a user like a broken program.
 *
 * The runbook numbers the vault 9b, after this step. That number is kept because the readiness gate
 * is keyed to it, so the constraint is enforced HERE instead of by the order of two headings. This
 * repo has already shipped one "prerequisite nobody numbers is a prerequisite somebody skips" (round
 * 3 P1, the same vault).
 */
export class FeeVaultMissing extends Error {
  constructor() {
    super(
      "the premium fee vault does not exist yet. ROUND 8: unpause is now the go-live, because " +
        "initialize leaves public mint and redemptions OPEN, and mint_silv/redeem_silv both take the " +
        "fee vault as a REQUIRED account. Unpausing here would publish a protocol in which every " +
        "mint and every redeem reverts AccountNotInitialized. REFUSING step 8: run runbook step 9b " +
        "(scripts/create-fee-vault.ts) FIRST, then re-run this step.",
    );
    this.name = "FeeVaultMissing";
  }
}

/** The instructions step 8 sends, in order. No chain access, no signing, no sending. */
export async function buildStep8Actions(i: Step8Input): Promise<CeremonyAction[]> {
  if (!i.boundInventoryWallet.equals(i.expectedInventoryWallet)) {
    throw new InventoryWalletMismatch(i.boundInventoryWallet, i.expectedInventoryWallet);
  }
  // Only when the unpause would actually be SENT. On a resumed ceremony the protocol is already
  // live, so the vault question is settled and re-asking it would block a re-run that emits nothing.
  if (i.paused && !i.feeVaultExists) throw new FeeVaultMissing();
  // ROUND 8 L1-04. The full go-live gate, same function the readiness test drives. The fee vault
  // above is one of its blockers and is kept as its own class because it has its own repair.
  if (i.paused) {
    const d = decideLaunchReadiness(i.readiness);
    if (!d.ready) {
      throw new Error(
        "REFUSING step 8: the unpause is the go-live and these preconditions do not hold:\n" +
          d.blockers.map((b) => `  - [${b.id}] ${b.why}`).join("\n"),
      );
    }
  }

  const M = i.program.methods as any;
  const actions: CeremonyAction[] = [];

  for (const g of i.guardians) {
    const pk = new PublicKey(g);
    const pda = guardianPda(pk);
    const exists = i.guardianExists(pda);
    actions.push({
      label: `add_guardian(${g})`,
      intent:
        "Registers a guardian: pause, cancel a timelocked action, cancel an admin transfer. Instant, " +
        "and add_guardian refuses config.admin itself. ROUND 8: the FIRST guardian was already " +
        "appointed by initialize, so these are the additional ones.",
      alreadyDone: exists,
      // P2-04: "the PDA exists" is now stated as what it is. The set comparison in verify() is what
      // actually decides, because presence of the right ones does not exclude presence of a wrong one.
      observed: exists ? `guardian PDA ${pda.toBase58()} already exists` : undefined,
      // ROUND 8 F-02: single signer again. The co-signature made this unexecutable through Squads.
      ix: await M.addGuardian(pk)
        .accounts({ config: i.configPda, admin: i.admin, payer: i.admin, guardianAccount: pda })
        .instruction(),
    });
  }

  // ROUND 8: `unpause` carries a guardian account and the handler refuses one whose key is the
  // current admin. The FIRST entry of the expected set is the one `initialize` appointed, so it is
  // already registered and is the safe presenter: an additional guardian whose add_guardian has not
  // been executed yet would make the unpause fail on a missing account.
  const presenter = new PublicKey(i.guardians[0]);
  actions.push({
    label: "unpause()",
    intent:
      "Lifts the launch pause, which is the ONLY thing holding the protocol: mint and redeem are " +
      `already open in the initialized config. Presents guardian ${presenter.toBase58()} as the ` +
      "independent brake the handler now demands. Instant in both directions.",
    alreadyDone: i.paused === false,
    observed: i.paused === false ? "already unpaused" : undefined,
    ix: await M.unpause()
      .accounts({ config: i.configPda, admin: i.admin, guardian: guardianPda(presenter) })
      .instruction(),
  });

  return actions;
}

async function main() {
  const MODE = modeFromArgv(process.argv);
  const CLUSTER = await resolveCluster();
  await requireSanctionedCluster(CLUSTER.rpc, "ceremony step 8: guardians, then unpause");
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
  const cfg = async (): Promise<any> => (program.account as any).configAccount.fetch(configPda);

  const c0 = await cfg();
  const { guardians, inventoryWallet } = ceremony();
  const admin: PublicKey = MODE === "send" ? signer!.publicKey : c0.admin;
  console.log(`  config.admin      : ${c0.admin.toBase58()}${PublicKey.isOnCurve(c0.admin.toBytes()) ? "" : "  (off-curve)"}`);
  console.log(`  guardians to register: ${guardians.join(", ")}`);
  console.log(`  inventory wallet  : ${inventoryWallet}  (bound by initialize; step 8 only checks it)`);

  if (MODE === "verify") return verify(conn, await cfg(), guardians, inventoryWallet);

  if (MODE === "send") assertSendable(c0.admin, signer!.publicKey, "step 8");

  // The chain reads the pure builder must not perform itself.
  const existing = new Set<string>();
  for (const g of guardians) {
    const pda = guardianPda(new PublicKey(g));
    if (await conn.getAccountInfo(pda)) existing.add(pda.toBase58());
  }

  // The fee vault is the USDC ATA of the fee_vault PDA, read here rather than derived by the builder
  // so the builder stays pure. `create-fee-vault.ts` owns creating it.
  const feeVaultAta = getAssociatedTokenAddressSync(
    new PublicKey(c0.usdcMint),
    PublicKey.findProgramAddressSync([Buffer.from("fee_vault")], PROGRAM_ID)[0],
    true,
    TOKEN_PROGRAM_ID,
  );
  const feeVaultExists = (await conn.getAccountInfo(feeVaultAta)) !== null;
  console.log(
    `  fee vault         : ${feeVaultAta.toBase58()}  ${feeVaultExists ? "exists" : "MISSING (step 9b)"}`,
  );

  const readiness = await collectLaunchState(conn, c0, guardians, inventoryWallet, feeVaultExists);

  const actions = await buildStep8Actions({
    program,
    configPda,
    admin,
    guardians,
    guardianExists: (pda) => existing.has(pda.toBase58()),
    paused: c0.paused === true,
    boundInventoryWallet: new PublicKey(c0.inventoryWallet),
    expectedInventoryWallet: new PublicKey(inventoryWallet),
    feeVaultExists,
    readiness,
  });

  if (MODE === "send") {
    await sendAll(conn, signer!, actions);
    return verify(conn, await cfg(), guardians, inventoryWallet);
  }
  emit("step8", describeCluster(CLUSTER), actions);
  console.log(`\n  After the Squads executions land, run:  npx tsx scripts/ceremony-step8.ts --verify`);
}

/**
 * ROUND 8 A-03. THE GO-LIVE STATE, COLLECTED IN ONE PLACE so `--verify` cannot check less than the
 * emit path did.
 *
 * This block used to live inline in the emit path only. `--verify` returned before reaching it, so
 * the command the runbook tells the operator to run AFTER the multisig execution re-read `paused`
 * and the fee vault and nothing else: not the supply, not the feed, not the publisher floor, not
 * whether a guardian is still eligible. Every field the decision depends on could have moved between
 * emission and execution and the verification would still have reported success.
 */
async function collectLaunchState(
  conn: Connection,
  c0: any,
  guardians: string[],
  inventoryWallet: string,
  feeVaultExists: boolean,
): Promise<LaunchState> {
  // ROUND 8 F-01. The go-live state, GATHERED HERE, on the path that actually emits the unpause.
  //
  // Everything here is READ, never asserted. An earlier version carried two booleans set from
  // environment variables, which measured nothing and are gone; see _launch-readiness.ts.
  const manifest = JSON.parse(
    fs.readFileSync(`${__dirname}/../config/mainnet-authorities.json`, "utf8"),
  );
  const posture = manifest?.launch_posture ?? {};
  // Circulating supply, read off the SILV mint. See _launch-readiness.ts for why this replaced a
  // treasury threshold: at the first unpause the supply is provably zero, so an empty treasury is
  // harmless, and demanding a decided dollar figure was ceremony rather than safety.
  // FAILS CLOSED. `.catch(() => null)` with a 0 default turned an RPC ERROR into "no supply", which
  // is the reassuring answer and the one that lets the check pass. A helper that cannot tell "no"
  // from "do not know" must not answer, so an unreadable supply aborts the step.
  let circulatingSilv: bigint;
  try {
    const silvSupply = await conn.getTokenSupply(new PublicKey(c0.silvMint));
    circulatingSilv = BigInt(silvSupply.value.amount);
  } catch (e) {
    throw new Error(
      `REFUSING step 8: could not read the SILV supply (${String(e).slice(0, 120)}). The go-live ` +
        "check needs to know it is zero, and an unreadable value is not a zero.",
    );
  }
  // Guardians the PROGRAM would accept: active, and not the current admin.
  const eligible = (
    await Promise.all(
      guardians.map(async (g) => {
        const info = await conn.getAccountInfo(guardianPda(new PublicKey(g)));
        if (!info || info.data.length < 56) return false;
        const cooldown = info.data.readBigInt64LE(48);
        return cooldown === 0n && !new PublicKey(g).equals(new PublicKey(c0.admin));
      }),
    )
  ).filter(Boolean).length;

  return {
    paused: c0.paused === true,
    publicMintEnabled: c0.publicMintEnabled === true,
    redemptionsEnabled: c0.redemptionsEnabled === true,
    boundInventoryWallet: new PublicKey(c0.inventoryWallet),
    expectedInventoryWallet: new PublicKey(inventoryWallet),
    feeVaultExists,
    circulatingSilv,
    activeIndependentGuardians: eligible,
    minPublishers: Number(c0.minPublishers),
    requiredMinPublishers: Number(requireField(posture, "min_publishers")),
    feedId: Number(c0.pythLazerFeedId),
    expectedFeedId: Number(requireField(posture, "pyth_lazer_feed_id")),
  }
}

/**
 * ROUND 8 A-03. A manifest field the decision depends on is MANDATORY, not defaulted.
 *
 * `posture.min_publishers ?? 2` and `posture.pyth_lazer_feed_id ?? 3154` silently substituted the
 * values a reader would expect to see, so a manifest that had lost either field produced a green
 * readiness against numbers nobody recorded. An absent field means the manifest is incomplete, and
 * an incomplete manifest is exactly the state that must stop a launch.
 */
function requireField(posture: any, name: string): number | string {
  const v = posture?.[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(
      `REFUSING step 8: config/mainnet-authorities.json launch_posture.${name} is missing. ` +
        "The go-live decision reads it, and defaulting it would validate the launch against a " +
        "number nobody recorded.",
    );
  }
  return v;
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

  // ROUND 8 L1-04. THE FEE VAULT IS RE-READ HERE, not only refused at emit time.
  //
  // The emit path refuses to build an unpause without it, which is useless against the case that
  // matters: an unpause constructed somewhere else (the panel, a hand-built transaction, a resumed
  // ceremony) takes the protocol live, and then the verification this runbook tells the operator to
  // run reports success while every mint and every redeem reverts AccountNotInitialized. A check
  // that only guards one door is not a check on the state.
  const feeVaultAta = getAssociatedTokenAddressSync(
    new PublicKey(c.usdcMint),
    PublicKey.findProgramAddressSync([Buffer.from("fee_vault")], PROGRAM_ID)[0],
    true,
    TOKEN_PROGRAM_ID,
  );
  // An RPC failure is NOT "the vault is missing": it is "unknown", and the reassuring answer must
  // never be the default. Reported as a failed check either way, with the reason.
  let vaultExists: boolean | null = null;
  try {
    vaultExists = (await conn.getAccountInfo(feeVaultAta)) !== null;
  } catch (e) {
    console.log(`  FAIL  fee vault existence UNKNOWN: ${String(e).slice(0, 90)}`);
  }
  ck.eq(
    `the premium fee vault exists (${feeVaultAta.toBase58()})`,
    vaultExists === true,
    true,
  );
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

  // ROUND 8 launch posture. Both switches ship OPEN from `initialize`, so asserting them CLOSED here
  // would now fail on a correct deployment. What holds the launch is the pause above, and what holds
  // the pause is the guardian requirement asserted with it. The old step 10 that executed a queued
  // opening of the public mint no longer exists.
  ck.eq("public mint open (round 8 launch posture)", c.publicMintEnabled, true);
  ck.eq("redemptions open (round 8 launch posture)", c.redemptionsEnabled, true);
  // D5: a value, not a verdict.
  ck.note("treasury_min_float_usdc", `${c.treasuryMinFloatUsdc} (D5 ships 0, risk accepted)`);
  // ROUND 8 A-03. RE-RUN THE SAME DECISION, from the same collector, on the state AS EXECUTED.
  //
  // The unpause is a Squads proposal: it is built at one moment and executed at another. Everything
  // above re-reads individual fields; none of it re-ran the go-live DECISION, and the decision is
  // what the operator was told the launch depended on. Between emission and execution a matured
  // timelocked action could land, the feed or the publisher floor could move, or a guardian could
  // enter cooldown, and this command would still print a clean list.
  //
  // The on-chain `unpause` now refuses while any slot is armed, which closes the mechanism. This
  // closes the REPORT: after the fact, the same function that authorised the launch says whether the
  // state that actually went live is the state it approved.
  const executedState = await collectLaunchState(
    conn,
    c,
    guardians,
    inventoryWallet,
    vaultExists === true,
  );
  const executedDecision = decideLaunchReadiness({ ...executedState, paused: false });
  ck.eq(
    "the executed state still satisfies the same go-live decision",
    executedDecision.blockers.length,
    0,
  );
  for (const b of executedDecision.blockers) {
    console.log(`        blocker after execution: ${b.id}: ${b.why}`);
  }
  ck.eq("no timelocked action is armed", Number(c.activeProposalCount ?? 0), 0);

  console.log("\n  Next: step 9 (pre-mint, D11: the operational tranche only) and 9b (fee vault).");
  ck.finish("step 8");
}

// Guarded so `import { buildStep8Actions } from "./ceremony-step8"` does not run a ceremony. T8-06
// requires the test to drive the REAL builder, and a module that sends transactions on import cannot
// be imported.
if (require.main === module) {
  main().catch((e) => {
    console.error("step 8 failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
