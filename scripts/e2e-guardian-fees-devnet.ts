/**
 * Live-cluster proof of the four rails that had never been pulled on this deploy: the GUARDIAN VETO,
 * the FEE SWEEP, the ORACLE ANTI-REPLAY, and the READINESS DIGEST that gates the go-live unpause.
 *
 * WHY THESE FOUR. After the 2026-08-11 fee-exemption session, these were what remained unproven on a
 * live cluster and consequential on 08-13:
 *
 *  - THE GUARDIAN. It is the only brake in the system and the explicit mitigation for the accepted
 *    risk that one vault holds upgrade + freeze + delegate. It had never been actioned: on devnet the
 *    manifest's guardian address has no account at all, so it cannot sign. `add_guardian` and a spare
 *    slot (max 5, one used) make a real veto testable with a key we hold.
 *  - THE READINESS DIGEST. `add_guardian` moves `guardian_count`, which is INSIDE the digest the
 *    unpause carries. So adding a guardian and then replaying a digest built before it is the exact
 *    StaleReadinessDigest interaction the runbook describes in prose and nothing had ever executed.
 *  - THE FEE SWEEP. The fee vault holds real premiums collected by the previous session. Sweeping is
 *    the revenue path end to end, and it had only ever run against the harness.
 *  - THE ANTI-REPLAY. `LazerReplayed` is a P0-class rail (one signed envelope prices exactly one
 *    operation). Nine operations each fetching a fresh print SUGGESTS it works; only a replay PROVES
 *    it, and only in the negative.
 *
 * ORDERING IS A SAFETY PROPERTY HERE, not a preference. `execute_set_inventory_wallet` refuses while
 * paused (execute.rs), and a matured T8-06 proposal is waiting to be executed. So the pause test runs
 * LAST and its unpause is in a `finally`, and the script's last act is to read `paused` back off the
 * chain. Leaving this program paused would silently break the timelock rehearsal.
 *
 *   PYTH_LAZER_KEY=... DOMINION_INTENT=remove_guardian npx tsx scripts/e2e-guardian-fees-devnet.ts
 *
 * The intent is for the guardian this script ADDS. Removing a guardian is timelocked-undo, so the
 * second guardian is left in place deliberately: it is a key we hold on a rehearsal cluster, and
 * pretending to clean it up would cost 24h and prove nothing.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { resolveCluster } from "./_cluster";
import { fetchSilvEnvelope } from "./_lazer-envelope";
import { readinessDigestFromConfig } from "./_readiness-digest";
import { guardianPda } from "./_guardian";
import { lazerMessageData } from "../apps/public/src/lib/lazer-assembly";
import { assembleLazerOracleIxs, ED25519_IX_INDEX } from "../apps/public/src/lib/lazer-tx";

const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LAZER_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");

const E_LAZER_REPLAYED = 12121;
const E_STALE_READINESS = 12126;
const E_WITHDRAW_RECIPIENT_MISMATCH = 12048;

const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}

function key(file: string): Keypair {
  const p = path.join(os.homedir(), ".config", "solana", file);
  if (!fs.existsSync(p)) throw new Error(`missing keypair ${p}`);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/** Anchor error code out of whatever shape the failure arrived in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errCode(e: any): number | null {
  const n = e?.error?.errorCode?.number;
  if (typeof n === "number") return n;
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(JSON.stringify(e?.logs ?? "") + String(e?.message ?? ""));
  return m ? parseInt(m[1], 16) : null;
}

async function expectCode(label: string, code: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(label, false, "it SUCCEEDED, which is the failure");
  } catch (e) {
    const got = errCode(e);
    ok(label, got === code, got === null ? `no anchor code in: ${String((e as Error).message).slice(0, 90)}` : `got ${got}, wanted ${code}`);
  }
}

async function main() {
  await requireSanctionedCluster(RPC, "guardian + fees E2E");
  const admin = key("dominion-dev.json");
  const user = key("dominion-test-user.json"); // becomes guardian #2
  const conn = new Connection(RPC, "confirmed");
  const adminProvider = new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" });
  const userProvider = new AnchorProvider(conn, new Wallet(user), { commitment: "confirmed" });
  const program = new Program(loadIdl() as Idl, adminProvider);
  const userProgram = new Program(loadIdl() as Idl, userProvider);
  const configPda = pda("config");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readConfig = async () => await (program.account as any).configAccount.fetch(configPda);

  let cfg = await readConfig();
  const SILV_MINT = new PublicKey(cfg.silvMint);
  const USDC_MINT = new PublicKey(cfg.usdcMint);
  const feeVaultAta = getAssociatedTokenAddressSync(USDC_MINT, pda("fee_vault"), true, TOKEN_PROGRAM_ID);
  const usdcTreasuryAta = getAssociatedTokenAddressSync(USDC_MINT, pda("treasury"), true, TOKEN_PROGRAM_ID);
  const adminUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey, false, TOKEN_PROGRAM_ID);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(SILV_MINT, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bal = async (a: PublicKey, prog = TOKEN_PROGRAM_ID) => {
    try {
      return Number((await getAccount(conn, a, "confirmed", prog)).amount);
    } catch {
      return 0;
    }
  };

  console.log("guardian + fees + anti-replay E2E");
  console.log("  cluster:", RPC);
  console.log("  admin  :", admin.publicKey.toBase58());
  console.log("  new gd :", user.publicKey.toBase58());
  if (cfg.paused) throw new Error("this program is already paused; refusing to start");

  // ------------------------------------------------------------ 1. add_guardian
  console.log("\n1. add_guardian: a second, INDEPENDENT guardian we can actually sign for");
  const gPda = guardianPda(user.publicKey, PROGRAM_ID);
  const countBefore = Number(cfg.guardianCount);
  if (!(await conn.getAccountInfo(gPda))) {
    assertReversible("add_guardian", intentFromEnv());
    const sig = await program.methods
      .addGuardian(user.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        payer: admin.publicKey,
        guardianAccount: gPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  added: ${sig.slice(0, 16)}...`);
  } else {
    console.log("  the guardian account already exists; reusing it");
  }
  cfg = await readConfig();
  ok("the guardian account exists on chain", (await conn.getAccountInfo(gPda)) !== null, gPda.toBase58());
  ok(
    "guardian_count moved",
    Number(cfg.guardianCount) >= countBefore,
    `${countBefore} -> ${cfg.guardianCount}`,
  );
  ok(
    "and it is independent of the admin, which is what the code requires",
    !user.publicKey.equals(new PublicKey(cfg.admin)),
  );

  // --------------------------------------------------------- 2. withdraw_fees
  console.log("\n2. withdraw_fees: the revenue path, on premiums a real user actually paid");
  const feeBefore = await bal(feeVaultAta);
  ok("the fee vault holds premiums from the earlier session", feeBefore > 0, `${feeBefore / 1e6} USDC`);
  if (feeBefore > 0) {
    // The negative FIRST, because it costs nothing and a sweep that already emptied the vault could
    // not exercise it afterwards.
    await expectCode("sweeping INTO the fee vault itself is refused", E_WITHDRAW_RECIPIENT_MISMATCH, () =>
      program.methods
        .withdrawFees(new anchor.BN(1))
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          usdcMint: USDC_MINT,
          feeVaultPda: pda("fee_vault"),
          feeVault: feeVaultAta,
          destination: feeVaultAta,
          usdcTreasury: usdcTreasuryAta,
          classicTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
    );
    const adminBefore = await bal(adminUsdcAta);
    const sig = await adminProvider.sendAndConfirm(
      new Transaction()
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            admin.publicKey,
            adminUsdcAta,
            admin.publicKey,
            USDC_MINT,
            TOKEN_PROGRAM_ID,
          ),
        )
        .add(
          await program.methods
            .withdrawFees(new anchor.BN(feeBefore))
            .accounts({
              config: configPda,
              admin: admin.publicKey,
              usdcMint: USDC_MINT,
              feeVaultPda: pda("fee_vault"),
              feeVault: feeVaultAta,
              destination: adminUsdcAta,
              usdcTreasury: usdcTreasuryAta,
              classicTokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ),
      [],
    );
    console.log(`  swept: ${sig.slice(0, 16)}...`);
    const feeAfter = await bal(feeVaultAta);
    const adminAfter = await bal(adminUsdcAta);
    ok("the fee vault is empty", feeAfter === 0, `${feeAfter} atoms`);
    ok(
      "and every atom landed at the destination",
      adminAfter - adminBefore === feeBefore,
      `+${adminAfter - adminBefore} of ${feeBefore}`,
    );
  }

  // ------------------------------------------------------ 3. oracle anti-replay
  console.log("\n3. anti-replay: one signed envelope prices exactly ONE operation");
  const { envelope, priceUsd } = await fetchSilvEnvelope();
  const msg = Buffer.from(lazerMessageData(envelope));
  const mintIx = async () =>
    await (userProgram.methods as any)
      .mintSilv(new anchor.BN(10_000_000), new anchor.BN(Math.floor((10 / priceUsd) * 0.9 * 1e6)), msg, ED25519_IX_INDEX, 0)
      .accounts({
        config: configPda,
        user: user.publicKey,
        usdcMint: USDC_MINT,
        silvMint: SILV_MINT,
        usdcTreasury: usdcTreasuryAta,
        userUsdcAta,
        userSilvAta,
        feeVaultPda: pda("fee_vault"),
        feeVault: feeVaultAta,
        feeExempt: null,
        kyc: null,
        silvMintAuthority: pda("silv_mint_authority"),
        lazerProgram: LAZER_PROGRAM,
        lazerStorage: LAZER_STORAGE,
        lazerTreasury: CLUSTER.lazerTreasury,
        lazerFeePayer: pda("lazer_fee_payer"),
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        classicTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ATA_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  const atas = [
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userUsdcAta, user.publicKey, USDC_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userSilvAta, user.publicKey, SILV_MINT, TOKEN_2022_PROGRAM_ID),
  ];
  const firstSig = await userProvider.sendAndConfirm(
    new Transaction().add(...assembleLazerOracleIxs(await mintIx(), envelope, atas)),
    [],
  );
  ok("the first use of the envelope mints", true, firstSig.slice(0, 16) + "...");
  // THE SAME envelope, byte for byte, in a second transaction. Nothing else changes.
  await expectCode("the SAME envelope replayed is refused", E_LAZER_REPLAYED, async () =>
    userProvider.sendAndConfirm(
      new Transaction().add(...assembleLazerOracleIxs(await mintIx(), envelope, atas)),
      [],
    ),
  );

  // -------------------------------------------- 4. guardian cancels a timelock
  console.log("\n4. the guardian veto on a timelocked action, on a THROWAWAY proposal");
  console.log("   (never nonce 0: that is the T8-06 rehearsal waiting to mature)");
  const nonceBefore = Number(cfg.nextTimelockNonce);
  const tlPda = PublicKey.findProgramAddressSync(
    // Little-endian u8x8, the same derivation e2e-inventory-change-devnet.ts uses. The IDL says the
    // seed is config.next_timelock_nonce, so it must be read immediately before the propose.
    [Buffer.from("timelock"), Uint8Array.from(new anchor.BN(nonceBefore).toArrayLike(Buffer, "le", 8))],
    PROGRAM_ID,
  )[0];
  assertReversible("propose_any", intentFromEnv());
  const proposeSig = await program.methods
    .proposeSetTreasuryMinFloat(new anchor.BN(1_000_000))
    .accounts({ config: configPda, admin: admin.publicKey, timelock: tlPda, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`  proposed a throwaway float change, nonce ${nonceBefore}: ${proposeSig.slice(0, 16)}...`);
  ok("the proposal exists on chain", (await conn.getAccountInfo(tlPda)) !== null);

  assertReversible("cancel_timelocked_action", intentFromEnv());
  const cancelSig = await userProgram.methods
    .cancelTimelockedAction(new anchor.BN(nonceBefore))
    .accounts({
      config: configPda,
      timelock: tlPda,
      rentRecipient: admin.publicKey,
      signer: user.publicKey, // THE GUARDIAN, not the admin
      guardian: gPda,
    })
    .rpc();
  console.log(`  the GUARDIAN cancelled it: ${cancelSig.slice(0, 16)}...`);
  cfg = await readConfig();
  ok("the guardian's cancel closed the proposal", (await conn.getAccountInfo(tlPda)) === null);
  ok(
    "and the value it would have written was never applied",
    Number(cfg.treasuryMinFloatUsdc) === 0,
    `treasury_min_float_usdc = ${cfg.treasuryMinFloatUsdc}`,
  );

  // ------------------------------- 5. guardian pause, and the readiness digest
  console.log("\n5. the guardian pauses, and the go-live unpause refuses a STALE readiness digest");
  // Captured BEFORE the pause. `paused` is deliberately excluded from the digest, so this value is
  // still current for every field the digest covers; what makes it stale below is the guardian count,
  // which section 1 moved.
  const staleDigest = readinessDigestFromConfig({ ...cfg, guardianCount: countBefore });
  try {
    assertReversible("pause", intentFromEnv());
    const pauseSig = await userProgram.methods
      .pause()
      .accounts({ config: configPda, signer: user.publicKey, guardian: gPda })
      .rpc();
    console.log(`  the GUARDIAN paused the protocol: ${pauseSig.slice(0, 16)}...`);
    cfg = await readConfig();
    ok("the protocol is paused, by a guardian rather than the admin", cfg.paused === true);

    // While paused, the money paths must be shut. admin_premint is the cheapest witness: no oracle,
    // no user funds, and its Paused guard is the one the 2026-08-10 rehearsal tripped over.
    await expectCode("admin_premint is refused while paused", 12000, () =>
      program.methods
        .adminPremint(new anchor.BN(1))
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          silvMint: SILV_MINT,
          inventorySilvAta: getAssociatedTokenAddressSync(SILV_MINT, new PublicKey(cfg.inventoryWallet), true, TOKEN_2022_PROGRAM_ID),
          silvMintAuthority: pda("silv_mint_authority"),
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc(),
    );

    // THE POINT OF THIS SECTION. A digest built when guardian_count was 1 must not unpause a config
    // whose guardian_count is now 2. This is the interaction the runbook describes and nothing had
    // ever executed.
    await expectCode("an unpause carrying a STALE digest is refused", E_STALE_READINESS, () =>
      program.methods
        .unpause(staleDigest)
        .accounts({ config: configPda, admin: admin.publicKey, guardian: gPda })
        .rpc(),
    );
  } finally {
    // ALWAYS, even on a failed assertion above. execute_set_inventory_wallet refuses while paused, so
    // leaving this program paused would silently break the T8-06 timelock rehearsal tonight.
    cfg = await readConfig();
    if (cfg.paused) {
      const fresh = readinessDigestFromConfig(cfg);
      const sig = await program.methods
        .unpause(fresh)
        .accounts({ config: configPda, admin: admin.publicKey, guardian: gPda })
        .rpc();
      console.log(`  unpaused with a FRESH digest: ${sig.slice(0, 16)}...`);
    }
    cfg = await readConfig();
    ok("the protocol is UNPAUSED again, read back off the chain", cfg.paused === false);
    ok(
      "so the matured T8-06 execute is not blocked",
      cfg.paused === false,
      "execute_set_inventory_wallet requires !paused",
    );
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
