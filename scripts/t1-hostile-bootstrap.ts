/**
 * T1: hostile bootstrap. Proves DOM-001 (P0) is closed: `initialize` used to accept ANY signer, so on a
 * fresh program id an attacker could call it first, seize the single [CONFIG_SEED] PDA, make itself
 * config.admin, unpause, redirect the inventory and pre-mint the entire supply cap.
 *
 * Run against a FRESHLY DEPLOYED, NOT YET INITIALIZED program, and BEFORE scripts/initialize-devnet.ts:
 * `initialize` fires ONCE per program id, so once the config PDA exists every attempt fails with
 * AccountAlreadyInitialized and this proves nothing. Case 5 below IS that initialisation. Case numbers
 * are the master audit doc's (section 10, T1), and each mustFail regex demands its case's SPECIFIC error.
 *   DOMINION_PROGRAM_ID=<fresh id> DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
 *     npx tsx scripts/t1-hostile-bootstrap.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet, Idl, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { createSilvMintForTest } from "./_t1-mint-helper";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import {
  resolveCluster,
  describeCluster,
  mainnetConfig,
  type ClusterContext,
} from "./_cluster";

// NEVER a hardcoded RPC or USDC constant here: a literal containing "devnet" satisfies the guard on its
// first line, making the mainnet branch dead code, and _cluster.ts THROWS on an unknown mainnet address
// instead of falling back to the devnet one (audit S-01, P0).
const CLUSTER: ClusterContext = resolveCluster();
const RPC = CLUSTER.rpc;
// ROUND 8 L1-01. The demand for DOMINION_PROGRAM_ID is now conditional on this file being the
// ENTRYPOINT, and `main()` at the bottom is guarded the same way.
//
// It used to be unconditional at module scope, with a comment explaining that the `new PublicKey`
// below would otherwise crash the import. That was right about the crash and wrong about the fix:
// the ceremony's argument builder lives in this file, so its acceptance test has to import it, and a
// module that refuses to load cannot be tested. `test-upgrade-gate.ts` needed the same guard on
// `upgrade-program.ts` for the same reason, and the classification gate is what found it there.
//
// The loud failure is KEPT for anyone who runs T1: a placeholder id that silently pointed the hostile
// cases at the wrong program would be far worse than a crash.
const IS_ENTRYPOINT = require.main === module;
if (IS_ENTRYPOINT && !process.env.DOMINION_PROGRAM_ID) {
  throw new Error(
    "set DOMINION_PROGRAM_ID to the freshly deployed program id.\n" +
      "T1 must run against a deployed but NOT YET INITIALIZED program.",
  );
}
// On the import path nothing reads this: every use is inside `main()` or the cases it drives.
const PROGRAM_ID = process.env.DOMINION_PROGRAM_ID
  ? new PublicKey(process.env.DOMINION_PROGRAM_ID)
  : PublicKey.default;
const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

let pass = 0;
let fail = 0;
/** Set by main() once the hostile key exists, so the `finally` at the bottom can always sweep it. */
let sweep: (() => Promise<void>) | null = null;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}
function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}
/**
 * ROUND 8 L1-01. The ceremony's `InitializeArgs`, built from config/mainnet-authorities.json.
 *
 * EXTRACTED AND EXPORTED because this is the function that actually initialises mainnet, and it was
 * silently wrong. `inventory_wallet` became a required argument of `initialize` in round 8 and this
 * builder never read it. Anchor's client coder does not refuse a missing field: it encodes the
 * absent Pubkey as 32 zero bytes, so the transaction is well-formed, reaches the program, and reverts
 * InventoryWalletNotSet AFTER the ceremony has already created the real Token-2022 mint. The runbook
 * says a green T1 IS the mainnet initialisation and says not to edit this script, so the operator had
 * no way out.
 *
 * It is a pure function of the manifest and four keys so that
 * `scripts/test-t1-initialize-args.ts` can call THIS code, encode it with the real IDL coder and read
 * the bytes back. A test that rebuilt the arg list itself would have agreed with the defect.
 *
 * `devnetFallback` is the local dev keypair: on devnet and localnet it stands in for every ceremony
 * authority, which is what makes T1 runnable there at all. On any other cluster a missing authority
 * throws rather than falling back.
 */
export interface T1InitializeArgs {
  admin: PublicKey;
  upgradeAuthorityInfo: PublicKey;
  permanentDelegateExpected: PublicKey;
  freezeAuthorityExpected: PublicKey;
  complianceMode: boolean;
  premiumBpsMint: number;
  premiumBpsRedeem: number;
  adminTimelockSeconds: number;
  maxGuardianCount: number;
  pythLazerFeedId: number;
  inventoryWallet: PublicKey;
  guardian: PublicKey;
}

export function buildT1InitializeArgs(
  manifest: Record<string, unknown>,
  cluster: string,
  devnetFallback: PublicKey,
  upgradeAuthorityInfo: PublicKey,
): T1InitializeArgs {
  const posture = ((manifest.launch_posture ?? {}) as Record<string, number>);
  const required = (field: string): number => {
    const v = posture[field];
    if (typeof v !== "number") {
      throw new Error(
        `launch_posture.${field} missing or not a number in config/mainnet-authorities.json`,
      );
    }
    return v;
  };
  const auths = (manifest.authorities ?? {}) as Record<
    string,
    { pubkey?: string } | undefined
  >;
  const authority = (role: string): PublicKey => {
    if (cluster === "devnet" || cluster === "localnet") return devnetFallback;
    const pk = auths[role]?.pubkey;
    if (!pk) {
      throw new Error(
        `authorities.${role}.pubkey missing from config/mainnet-authorities.json, and this is ` +
          `${cluster}. Refusing to initialise a real deployment with the dev keypair.`,
      );
    }
    return new PublicKey(pk);
  };
  // The pre-mint destination. NO devnet fallback and no default: this field is bound atomically and
  // for good, the only later writer is the 24h timelock, and a zero here is refused on chain. A
  // ceremony that cannot name it must stop before it creates the mint, not after.
  const invRaw = auths.inventory_wallet?.pubkey;
  if (!invRaw) {
    throw new Error(
      "authorities.inventory_wallet.pubkey is missing from config/mainnet-authorities.json. " +
        "initialize binds the pre-mint destination atomically and nothing can set it afterwards, " +
        "so there is no value to fall back to. Fill it in before running T1.",
    );
  }
  const inventoryWallet = new PublicKey(invRaw);
  if (inventoryWallet.equals(PublicKey.default)) {
    throw new Error("authorities.inventory_wallet.pubkey is the zero pubkey, which initialize refuses.");
  }

  const guardianRaw = auths.guardian?.pubkey;
  if (!guardianRaw) {
    throw new Error(
      "authorities.guardian.pubkey is missing from config/mainnet-authorities.json. ROUND 8 L1-02: " +
        "initialize appoints the first guardian, so the independent brake is part of the ceremony " +
        "artifact rather than a later admin-only call. There is nothing to fall back to.",
    );
  }
  const firstGuardian = new PublicKey(guardianRaw);
  const compliance = authority("compliance");
  if (firstGuardian.equals(PublicKey.default)) {
    throw new Error("authorities.guardian.pubkey is the zero pubkey, which initialize refuses.");
  }
  return {
    // NOT the signer. `initialize` writes `args.admin` VERBATIM with only a non-zero check, and
    // DOM-001 binds the SIGNER to the BPF upgrade authority, not this field. The signer here would
    // leave the deployer unilateral admin with no transfer step anywhere in the path.
    admin: authority("ops_admin"),
    // The SIGNER: informational, an immutable launch record of the upgrade trust root.
    upgradeAuthorityInfo,
    permanentDelegateExpected: compliance,
    freezeAuthorityExpected: compliance,
    complianceMode: false,
    premiumBpsMint: required("premium_bps_mint"),
    premiumBpsRedeem: required("premium_bps_redeem"),
    adminTimelockSeconds: required("admin_timelock_seconds"),
    maxGuardianCount: required("max_guardian_count"),
    pythLazerFeedId: required("pyth_lazer_feed_id"),
    inventoryWallet,
    // ROUND 8 L1-02. The FIRST guardian, appointed by initialize itself. Same treatment as the
    // inventory wallet: no devnet fallback and no default, because the whole point is that this key
    // is chosen in the reviewed ceremony artifact and not by a later admin-only call.
    guardian: firstGuardian,
  };
}

/** The launch posture `initialize` writes, as the ceremony must read it back. Exported so T1 and its
 *  test cannot drift from each other: round 8 opened both switches, and T1 still counted the closed
 *  values as success, which would have reported two failures after an irreversible initialisation. */
export const EXPECTED_POST_INITIALIZE = {
  paused: true,
  publicMintEnabled: true,
  redemptionsEnabled: true,
} as const;

function programData(id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([id.toBytes()], BPF_LOADER)[0];
}

async function main() {
  // RULE 1 (scripts/_guard.ts): devnet consent plus the genesis-hash cross-check.
  await requireSanctionedCluster(RPC, "T1 hostile bootstrap");
  // RULE 2, checked HERE and never moved down to case 5: a gate on an irreversible action must fire before
  // the first lamport moves. Gated at case 5 it throws after the attacker is funded and the REAL SILV mint
  // created, and that keypair is only printed once case 5 succeeds: rent spent, config bare, mint lost.
  const INTENT = intentFromEnv();
  assertReversible("initialize", INTENT);
  const conn = new Connection(RPC, "confirmed");
  const authority = loadKp(
    process.env.DOMINION_KEYPAIR ??
      path.join(os.homedir(), ".config/solana/dominion-dev.json"),
  );
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
      "utf8",
    ),
  ) as Idl;

  // ROUND 5 P1-07, and it must run HERE: before the first lamport, before the attacker is funded, and
  // before the one-shot SILV mint keypair is created.
  //
  // THE DEFECT. `new Program(idl, provider)` takes its program address from `idl.address`, while every
  // PDA above and the mint below are derived from `DOMINION_PROGRAM_ID`. Nothing compared the two. A
  // stale IDL (a rebuild that was not copied, a checkout at the wrong commit) meant the hostile cases
  // were sent to one program id while the accounts belonged to another: the negative cases then "pass"
  // for the wrong reason, and case 5's real `initialize` fails AFTER the deploy has been paid for and
  // after the mint keypair, which is deliberately never persisted, has already been used.
  //
  // Three facts are required, not one, because each rules out a different way of being wrong:
  //   a) idl.address == DOMINION_PROGRAM_ID     the client and the derivations agree
  //   b) declare_id! == DOMINION_PROGRAM_ID     the SOURCE agrees, so the IDL is not merely
  //                                             self-consistent with a binary nobody built
  //   c) the program account exists and is executable, and its ProgramData names an upgrade authority
  //      DOM-001 binds initialize's signer to that authority, so a mismatch here is a guaranteed
  //      failure at case 5, and the whole point is to find it before spending.
  {
    const wantId = PROGRAM_ID.toBase58();
    const idlAddress = (idl as unknown as { address?: string }).address;
    if (idlAddress !== wantId) {
      throw new Error(
        `IDL/program mismatch, refusing before the first lamport moves.\n` +
          `  DOMINION_PROGRAM_ID : ${wantId}\n` +
          `  target/idl address  : ${idlAddress ?? "(absent)"}\n` +
          `Regenerate the IDL against the deployed id:\n` +
          `  (cd programs/dominion_silver_mint_v2 && anchor idl build -o ../../target/idl/dominion_silver_mint.json -- --locked)`,
      );
    }
    const libRs = fs.readFileSync(
      path.join(__dirname, "..", "programs", "dominion_silver_mint_v2", "src", "lib.rs"),
      "utf8",
    );
    const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(libRs)?.[1];
    if (declared !== wantId) {
      throw new Error(
        `declare_id! does not match the program being bootstrapped.\n` +
          `  DOMINION_PROGRAM_ID : ${wantId}\n` +
          `  declare_id!         : ${declared ?? "(not found)"}\n` +
          `The deployed binary was built from a different id, so every PDA below belongs to a program\n` +
          `that is not the one at ${wantId}. Fix declare_id!, rebuild, redeploy.`,
      );
    }
    const progInfo = await conn.getAccountInfo(PROGRAM_ID);
    if (!progInfo || !progInfo.executable) {
      throw new Error(
        `${wantId} is ${progInfo ? "not executable" : "not deployed on this cluster"}.\n` +
          `T1 must run against a DEPLOYED but NOT YET INITIALIZED program.`,
      );
    }
    const pdInfo = await conn.getAccountInfo(programData(PROGRAM_ID));
    // ProgramData layout: 4-byte enum tag, 8-byte slot, 1-byte Option tag, then the 32-byte authority.
    if (!pdInfo || pdInfo.data.length < 45 || pdInfo.data[12] !== 1) {
      throw new Error(
        `${wantId} has no upgrade authority (immutable, or the ProgramData is unreadable).\n` +
          `initialize binds its signer to the CURRENT upgrade authority (DOM-001), so it can never\n` +
          `succeed here.`,
      );
    }
    const upgradeAuthority = new PublicKey(pdInfo.data.subarray(13, 45));
    if (!upgradeAuthority.equals(authority.publicKey)) {
      throw new Error(
        `the loaded keypair is NOT the upgrade authority, so case 5 is guaranteed to fail.\n` +
          `  keypair           : ${authority.publicKey.toBase58()}\n` +
          `  upgrade authority : ${upgradeAuthority.toBase58()}\n` +
          `DOM-001 binds initialize's signer to the BPF loader's upgrade authority. Refusing now costs\n` +
          `nothing; refusing at case 5 costs the funded attacker account and the one-shot SILV mint.`,
      );
    }
    console.log(`  bound: idl.address == declare_id! == ${wantId}, executable, upgrade authority OK`);
  }

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    PROGRAM_ID,
  );
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    PROGRAM_ID,
  );
  const usdcTreasury = getAssociatedTokenAddressSync(
    CLUSTER.usdcMint,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  console.log("T1 hostile bootstrap");
  // Printed FIRST: otherwise a devnet run under a mainnet invocation looks identical to a mainnet run.
  console.log("  " + describeCluster(CLUSTER));
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  config PDA:", configPda.toBase58());
  console.log("  upgrade authority:", authority.publicKey.toBase58());

  const cfgExists = await conn.getAccountInfo(configPda);
  if (cfgExists) {
    throw new Error(
      "config PDA already exists: this program is already initialized, so T1 " +
        "cannot prove anything. Deploy a fresh program id and run this FIRST.",
    );
  }
  console.log("  config PDA does not exist yet: the bootstrap window is open.\n");

  // Resolved and VALIDATED here, before a single lamport moves: this file is hand-edited during the
  // ceremony, so a missing field must throw before the attacker is funded and the real SILV mint created,
  // or the retry repeats the loss. The args are READ, never retyped as literals: the literals here once
  // said 150/200 bps against a source of truth of 100/150, and a premium fix costs a 24h proposal each.
  // ROUND 8 L1-01: the args come from the ONE exported builder above, so this script and its offline
  // test exercise the same code. It throws rather than defaulting when the manifest is incomplete.
  const CEREMONY_ARGS = buildT1InitializeArgs(
    mainnetConfig() as Record<string, unknown>,
    CLUSTER.cluster,
    authority.publicKey,
    authority.publicKey,
  );
  const COMPLIANCE = CEREMONY_ARGS.permanentDelegateExpected;
  const CEREMONY_ADMIN = CEREMONY_ARGS.admin;
  console.log(
    `  ceremony args from config/mainnet-authorities.json: ` +
      `mint=${CEREMONY_ARGS.premiumBpsMint}bps redeem=${CEREMONY_ARGS.premiumBpsRedeem}bps ` +
      `timelock=${CEREMONY_ARGS.adminTimelockSeconds}s guardians<=${CEREMONY_ARGS.maxGuardianCount} ` +
      `feed=${CEREMONY_ARGS.pythLazerFeedId} inventory=${CEREMONY_ARGS.inventoryWallet.toBase58()}`,
  );


  // ---- the attacker ----
  const attacker = Keypair.generate();
  // Funded by transfer, not requestAirdrop: the devnet faucet rate-limits with -32603 "Internal error" and
  // would make T1 flaky for a reason unrelated to what it tests. Keep the amount at what the hostile cases
  // need (a Token-2022 mint with extensions, an ATA, a few failing transactions) and sweep the remainder:
  // the key lives only in this process's memory, so on a real cluster anything left is burned every retry.
  const ATTACKER_FUNDING = 60_000_000; // 0.06 SOL
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: attacker.publicKey,
        lamports: ATTACKER_FUNDING,
      }),
    ),
    [authority],
    { commitment: "confirmed" },
  );
  console.log(
    `  attacker funded: ${attacker.publicKey.toBase58()} (${ATTACKER_FUNDING / 1e9} SOL, swept back at the end)\n`,
  );

  /** Return whatever the hostile key still holds. Best effort: a failure here must never turn a passing T1
   *  into a failing one. Published to module scope so the `finally` at the bottom runs it on EVERY exit. */
  sweep = async function sweepAttacker(): Promise<void> {
    try {
      const bal = await conn.getBalance(attacker.publicKey);
      const FEE = 5_000;
      if (bal <= FEE) {
        console.log(`  attacker sweep: nothing to return (${bal} lamports)`);
        return;
      }
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: attacker.publicKey,
            toPubkey: authority.publicKey,
            lamports: bal - FEE,
          }),
        ),
        [attacker],
        { commitment: "confirmed" },
      );
      console.log(`  attacker sweep: returned ${(bal - FEE) / 1e9} SOL to the authority`);
    } catch (e) {
      console.log(
        `  attacker sweep FAILED (${String(e).slice(0, 120)}). ` +
          `Abandoned key: ${attacker.publicKey.toBase58()}`,
      );
    }
  };

  const mkProgram = (kp: Keypair) =>
    new Program(
      idl,
      new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }),
    );

  // Created by the AUTHORITY so case 1 is the worst case: the attacker points at the real, valid mint.
  //
  // DOMINION_SILV_MINT_KEYPAIR is an OPT-IN, added 2026-08-11 so the SILV address can be known and
  // pre-validated (Jupiter, pools, listings) BEFORE the ceremony rather than first appearing in the
  // ceremony's own scrollback. Unset, the behaviour is exactly what it was and audit A-30 holds: a
  // fresh keypair, never persisted.
  //
  // WHAT A-30 IS ABOUT, so the trade is made with open eyes. After creation the mint keypair has NO
  // power over the token: the mint authority is a program PDA, freeze and permanent delegate are the
  // compliance vault. Persisting it therefore buys nothing operationally and only adds a secret to
  // lose, which is why the default is to discard it.
  // WHAT PRE-GENERATING RISKS is narrow and it is NOT a fund risk: whoever holds the secret before
  // the ceremony can create that mint account first, which makes createSilvMintForTest fail and burns
  // the address you already announced. Griefing the ceremony, not stealing from it. So keep the file
  // mode 600 on the ceremony machine and delete it once the mint exists.
  const preGenerated = process.env.DOMINION_SILV_MINT_KEYPAIR;
  const silvMint = preGenerated
    ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(preGenerated, "utf8"))))
    : Keypair.generate();
  if (preGenerated) {
    console.log(`  SILV mint keypair supplied from ${preGenerated} (pre-announced address)`);
    const already = await conn.getAccountInfo(silvMint.publicKey);
    if (already) {
      throw new Error(
        `the pre-generated SILV mint ${silvMint.publicKey.toBase58()} ALREADY EXISTS on this cluster.\n` +
          `Creation would fail. Either this ceremony already ran, or the keypair leaked and someone\n` +
          `created it first. Do not proceed: generate a new one and re-announce the address.`,
      );
    }
  }
  console.log("  creating the real SILV mint (Token-2022 + extensions)...");
  await createSilvMintForTest(
    conn,
    authority,
    silvMint,
    mintAuthPda,
    PROGRAM_ID,
    COMPLIANCE,
  );
  console.log("  SILV mint:", silvMint.publicKey.toBase58(), "\n");

  const args = (admin: PublicKey) => ({ ...CEREMONY_ARGS, admin });

  const accs = (signer: PublicKey, pd: PublicKey, prog: PublicKey) => ({
    deployer: signer,
    // ROUND 8 L1-02: initialize creates the first GuardianAccount, so its PDA is an account of the
    // ceremony transaction.
    firstGuardian: PublicKey.findProgramAddressSync(
      [Buffer.from("guardian"), CEREMONY_ARGS.guardian.toBuffer()],
      PROGRAM_ID,
    )[0],
    dominionProgram: prog,
    programData: pd,
    config: configPda,
    treasuryPda,
    usdcMint: CLUSTER.usdcMint,
    silvMint: silvMint.publicKey,
    usdcTreasury,
    classicTokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  async function mustFail(name: string, expect: RegExp, fn: () => Promise<unknown>) {
    try {
      await fn();
      ok(name, false, "the transaction SUCCEEDED, the P0 is NOT closed");
    } catch (e: unknown) {
      const err = e as { error?: { errorCode?: { code?: string } }; message?: string };
      const txt = `${err?.error?.errorCode?.code ?? ""} ${err?.message ?? String(e)}`;
      ok(name, expect.test(txt), (err?.error?.errorCode?.code ?? txt.slice(0, 90)).trim());
    }
  }

  // --- case 1: attacker signs, pointing at the REAL mint and the REAL ProgramData
  await mustFail(
    "case 1: attacker signs with the real mint and real ProgramData",
    /DeployerNotUpgradeAuthority/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(accs(attacker.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never)
        .rpc(),
  );

  // --- case 2: attacker signs with a correctly shaped mint IT created and controls. The realistic attack:
  // it needs the config PDA, not the real mint. Authentication runs BEFORE any mint validation, so the
  // expected failure is still DeployerNotUpgradeAuthority and the check cannot depend on mint shape.
  {
    const attackerMint = Keypair.generate();
    // The attacker is deliberately its own compliance authority, so this fails on AUTHENTICATION.
    await createSilvMintForTest(
      conn,
      attacker,
      attackerMint,
      mintAuthPda,
      PROGRAM_ID,
      attacker.publicKey,
    );
    const accsOwnMint = {
      ...accs(attacker.publicKey, programData(PROGRAM_ID), PROGRAM_ID),
      silvMint: attackerMint.publicKey,
    };
    await mustFail(
      "case 2: attacker signs with its own compliant mint",
      /DeployerNotUpgradeAuthority/,
      () =>
        mkProgram(attacker)
          .methods.initialize(args(attacker.publicKey) as never)
          .accounts(accsOwnMint as never)
          .rpc(),
    );
  }

  // --- case 3: attacker supplies a FOREIGN ProgramData. It must be a third-party live upgradeable
  // program, never a Dominion id: we retire ids routinely, and a closed program turns this case into a
  // false FAIL (AccountNotInitialized matches none of the expected codes). Asserted below, not assumed.
  const foreignProgram = CLUSTER.foreignUpgradeableProgram;
  {
    const pdInfo = await conn.getAccountInfo(programData(foreignProgram));
    if (!pdInfo || !pdInfo.owner.equals(BPF_LOADER)) {
      throw new Error(
        `case 3 precondition failed: ${foreignProgram.toBase58()} has no ` +
          `loader-owned ProgramData on this cluster. Pick another live ` +
          `upgradeable program; do NOT use a Dominion id.`,
      );
    }
  }
  await mustFail(
    "case 3: attacker supplies a foreign ProgramData",
    // The programdata_address() constraint raises Unauthorized specifically. Do not widen this to
    // ConstraintRaw or InvalidProgramId: it would stop distinguishing its own failure mode.
    /Unauthorized/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(
          accs(attacker.publicKey, programData(foreignProgram), PROGRAM_ID) as never,
        )
        .rpc(),
  );

  // --- case 4: a non-ProgramData account. The SILV mint: a real account of the wrong type.
  await mustFail(
    "case 4: attacker supplies a non-ProgramData account",
    // Anchor's Owner impl for ProgramData rejects a non-loader-owned account.
    /AccountOwnedByWrongProgram/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(accs(attacker.publicKey, silvMint.publicKey, PROGRAM_ID) as never)
        .rpc(),
  );

  // --- case 4b: attacker points dominionProgram at another program
  await mustFail(
    "case 4b: attacker points dominion_program at a different program",
    // Program<'info, T> pins the account to crate::ID.
    /InvalidProgramId/,
    () =>
      mkProgram(attacker)
        .methods.initialize(args(attacker.publicKey) as never)
        .accounts(
          accs(attacker.publicKey, programData(foreignProgram), foreignProgram) as never,
        )
        .rpc(),
  );

  // --- case 6 / DOM-002: a pre-created treasury ATA must not brick initialize.
  console.log("\n  pre-creating the treasury USDC ATA (DOM-002 regression)...");
  // The instruction form, not the helper: the helper re-derives the address with
  // allowOwnerOffCurve=false and throws TokenOwnerOffCurveError on a PDA owner.
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        attacker.publicKey, // anyone may create it: that is the point
        usdcTreasury,
        treasuryPda,
        CLUSTER.usdcMint,
        TOKEN_PROGRAM_ID,
      ),
    ),
    [attacker],
    { commitment: "confirmed" },
  );
  const ataInfo = await conn.getAccountInfo(usdcTreasury);
  ok("DOM-002: the treasury ATA now exists before initialize", ataInfo !== null);

  // --- case 5: the genuine upgrade authority succeeds, DESPITE the pre-created ATA
  let initSig = "";
  try {
    initSig = await mkProgram(authority)
      .methods.initialize(args(CEREMONY_ADMIN) as never)
      .accounts(
        accs(authority.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never,
      )
      .rpc();
    ok("case 5: the genuine upgrade authority initializes successfully", true, initSig.slice(0, 12) + "...");
  } catch (e) {
    ok("case 5: the genuine upgrade authority initializes successfully", false, String(e).slice(0, 200));
  }

  // --- case 8: verify the resulting on-chain state matches intent
  if (initSig) {
    const program = mkProgram(authority);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = await (program.account as any).configAccount.fetch(configPda);
    // Against the SOURCE OF TRUTH, never against the signer: "the admin is whoever signed" is true by
    // construction and proves nothing. On mainnet this fails loudly if the admin is not the Ops vault.
    ok(
      "case 8: config.admin is the intended ceremony admin",
      new PublicKey(cfg.admin).equals(CEREMONY_ADMIN),
      `${new PublicKey(cfg.admin).toBase58()} (expected ${CEREMONY_ADMIN.toBase58()})`,
    );
    ok(
      "case 8: on a real cluster the admin is NOT the deployer",
      CLUSTER.cluster === "devnet" ||
        CLUSTER.cluster === "localnet" ||
        !new PublicKey(cfg.admin).equals(authority.publicKey),
      "the deployer must not retain unilateral admin authority",
    );
    ok("case 8: config.silvMint is the intended mint", new PublicKey(cfg.silvMint).equals(silvMint.publicKey));
    // ROUND 8 posture. These three used to assert the CLOSED values, which the program stopped
    // writing on 2026-08-09: a correct mainnet initialisation would have ended on two red lines,
    // indistinguishable from a half-failed ceremony and inviting a re-run that `initialize` can never
    // accept. Read from the shared constant so the script and its test cannot drift again.
    ok("case 8: starts paused", cfg.paused === EXPECTED_POST_INITIALIZE.paused);
    ok(
      "case 8: public mint OPEN at initialize (round 8 posture)",
      cfg.publicMintEnabled === EXPECTED_POST_INITIALIZE.publicMintEnabled,
    );
    ok(
      "case 8: redemptions OPEN at initialize (round 8 posture)",
      cfg.redemptionsEnabled === EXPECTED_POST_INITIALIZE.redemptionsEnabled,
    );
    // L1-01: the argument actually landed. A zero here is what the omitted field produced.
    ok(
      "case 8: config.inventoryWallet is the manifest's pre-mint destination",
      new PublicKey(cfg.inventoryWallet).equals(CEREMONY_ARGS.inventoryWallet),
      `${new PublicKey(cfg.inventoryWallet).toBase58()} (expected ${CEREMONY_ARGS.inventoryWallet.toBase58()})`,
    );
    ok("case 8: guardian floor field present", typeof cfg.guardianCount === "number");
    ok(
      "case 8: the instant redeem WINDOW respects its floor",
      // The label above and the field below must name the same thing: this is ceremony evidence. The live
      // throttle is the rolling window; `redeemQueueDelaySeconds` is DEAD on chain since 2026-08-05.
      cfg.instantRedeemWindowSeconds >= 60,
      String(cfg.instantRedeemWindowSeconds),
    );
    // Reads the REAL mint, never a self-comparison of constants: the claim is the C-01 rug-by-init defence.
    const mintAfter = await getMint(
      conn,
      silvMint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    ok(
      "case 8: SILV supply is zero at init",
      mintAfter.supply === 0n,
      `supply=${mintAfter.supply}`,
    );
    ok(
      "case 8: mint authority is the program PDA",
      mintAfter.mintAuthority?.equals(mintAuthPda) ?? false,
      mintAfter.mintAuthority?.toBase58() ?? "null",
    );

    // --- case 9: a second initialize (even by the authority) cannot re-seize
    await mustFail(
      "case 9: initialize cannot be replayed once the config exists",
      // Not "0x0": it matches a broad class of unrelated messages.
      /already in use|AccountAlreadyInitialized/,
      () =>
        mkProgram(authority)
          .methods.initialize(args(authority.publicKey) as never)
          .accounts(
            accs(authority.publicKey, programData(PROGRAM_ID), PROGRAM_ID) as never,
          )
          .rpc(),
    );
  }

  console.log(`\n=== T1 result: ${pass} passed, ${fail} failed ===`);
  if (initSig) {
    console.log("initialize tx:", initSig);
    console.log("SILV mint secret is NOT persisted by this script (audit A-30).");
    console.log("SILV mint pubkey:", silvMint.publicKey.toBase58());
  }
  // exitCode, not exit(): `process.exit` would pre-empt the `finally` below and abandon the hostile
  // key's remaining SOL on the success path too.
  process.exitCode = fail === 0 ? 0 : 1;
}
// The sweep runs in a `finally`, not at the end of main(): the loss case is a retry after a configuration
// error, i.e. the THROWING path, which is the one path a sweep at the end of the happy flow cannot reach.
if (IS_ENTRYPOINT) {
  main()
    .catch((e) => {
      console.error("T1 crashed:", e);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (sweep) await sweep();
    });
}
