/**
 * Functional E2E against the LIVE devnet program (launch-spec-2026-07 + FIX A).
 * Exercises the real launch mint path + the revert guards + FIX A on-chain.
 *
 * Run:
 *   DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
 *   npx tsx scripts/e2e-fixa-devnet.ts
 *
 * NOTE: execute_set_redeem_limits is NOT covered (24h timelock, no dev-hatch
 * bypass in the release build). We cover propose + cancel of that path.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, BN, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getMint,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";

const RPC = "https://api.devnet.solana.com";
// Review-of-fixes F6: no hardcoded id fallback. _program-id.ts resolves it from
// DOMINION_PROGRAM_ID or the generated IDL, and the consistency gate pins that
// to declare_id!.
const PROGRAM_ID = SHARED_PROGRAM_ID;
// AUDIT review of daac4ac (P2): PROGRAM_ID is env-overridable but SILV_MINT was a
// hardcoded constant, so ANY use of DOMINION_PROGRAM_ID produced a guaranteed-broken
// run (WrongMint on set_max_silv_supply, the wrong mint on premint) that looked like a
// real failure. The mint is now read from the live config, which is the only authority
// on which mint a given program is bound to. Set DOMINION_SILV_MINT only to override
// deliberately.
let SILV_MINT: PublicKey;

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}
function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
async function expectRevert(name: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "expected revert, tx SUCCEEDED");
  } catch (e: any) {
    const txt = (e?.error?.errorCode?.code || "") + " " + (e?.message || String(e));
    ok(name, txt.includes(code), `got ${e?.error?.errorCode?.code || txt.slice(0, 80)}`);
  }
}

async function main() {
  // RULE 1 (scripts/_guard.ts): refuse any cluster but devnet unless
  // DOMINION_ALLOW_MAINNET is explicitly set.
  await requireSanctionedCluster(RPC, "FIX A E2E");
  const INTENT = intentFromEnv();
  const conn = new Connection(RPC, "confirmed");
  const kp = loadKp(process.env.DOMINION_KEYPAIR || path.join(os.homedir(), ".config/solana/dominion-dev.json"));
  const admin = kp.publicKey;
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"), "utf8"),
  ) as Idl;
  const program = new Program(idl, provider);
  const acct = (program.account as any).configAccount;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from("silv_mint_authority")], PROGRAM_ID);
  console.log("Program:", PROGRAM_ID.toBase58(), "\nAdmin:", admin.toBase58(), "\nConfig:", configPda.toBase58(), "\n");

  let cfg = await acct.fetch(configPda);
  SILV_MINT = process.env.DOMINION_SILV_MINT
    ? new PublicKey(process.env.DOMINION_SILV_MINT)
    : (cfg.silvMint as PublicKey);
  console.log("SILV mint (from the live config):", SILV_MINT.toBase58());
  console.log("Initial: paused =", cfg.paused, "| publicMint =", cfg.publicMintEnabled, "| redeem =", cfg.redemptionsEnabled);

  // 1. unpause
  await program.methods.unpause().accounts({ config: configPda, admin }).rpc();
  cfg = await acct.fetch(configPda);
  ok("unpause: paused == false", cfg.paused === false);

  // 2. set_inventory_wallet(admin). Captured first so step 11 can restore it.
  const inventoryBefore: PublicKey | null = cfg.inventoryWallet.equals(PublicKey.default)
    ? null
    : cfg.inventoryWallet;
  await program.methods.setInventoryWallet(admin).accounts({ config: configPda, admin }).rpc();
  cfg = await acct.fetch(configPda);
  ok("set_inventory_wallet", cfg.inventoryWallet.toBase58() === admin.toBase58());

  // 3. inventory SILV ATA (Token-2022, owner = admin)
  const invAta = getAssociatedTokenAddressSync(SILV_MINT, admin, false, TOKEN_2022_PROGRAM_ID);
  await createAssociatedTokenAccountIdempotent(conn, kp, SILV_MINT, admin, {}, TOKEN_2022_PROGRAM_ID);

  // 4. admin_premint 1000 oz -> supply + inventory balance
  const supplyBefore = (await getMint(conn, SILV_MINT, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const invBalBefore = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const AMT = new BN(1_000_000_000); // 1000 oz @ 6dp
  await program.methods
    .adminPremint(AMT)
    .accounts({
      config: configPda,
      admin,
      silvMint: SILV_MINT,
      inventorySilvAta: invAta,
      silvMintAuthority: mintAuthPda,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  const supplyAfter = (await getMint(conn, SILV_MINT, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const invBalAfter = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  ok("admin_premint: supply += 1000oz", supplyAfter - supplyBefore === BigInt(AMT.toString()));
  // delta, not absolute: this script is run repeatedly against the same live
  // devnet config, so the inventory ATA already holds earlier premints.
  ok(
    "admin_premint: inventory credited",
    invBalAfter - invBalBefore === BigInt(AMT.toString()),
    `${invBalBefore} -> ${invBalAfter}`,
  );

  // 5. admin_premint over the 100k cap -> SupplyCapExceeded
  await expectRevert("admin_premint over cap reverts", "SupplyCapExceeded", () =>
    program.methods
      .adminPremint(new BN("100000000000")) // +100k oz on top of existing supply
      .accounts({
        config: configPda,
        admin,
        silvMint: SILV_MINT,
        inventorySilvAta: invAta,
        silvMintAuthority: mintAuthPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc(),
  );

  // 6. set_redemptions_enabled(true) -> blocked
  await expectRevert("enable redemptions reverts", "RedemptionsEnableBlocked", () =>
    program.methods.setRedemptionsEnabled(true).accounts({ config: configPda, admin }).rpc(),
  );

  // 7. set_max_silv_supply raise -> blocked. Takes silv_mint since the
  // SupplyCapBelowSupply invariant (audit DOM-011) reads the live supply.
  await expectRevert("supply-cap raise reverts", "SupplyCapRaiseBlocked", () =>
    program.methods
      .setMaxSilvSupply(new BN(cfg.maxSilvSupply).add(new BN(1)))
      .accounts({ config: configPda, admin, silvMint: SILV_MINT })
      .rpc(),
  );

  // 7b. a tighten BELOW the live supply is rejected (DOM-011). Derived from the LIVE
  // supply rather than hardcoded: the previous 999_000_000 only happened to be below
  // supply because a single premint had run, and would have silently stopped testing
  // anything the moment the devnet supply changed.
  const liveSupply = new BN(supplyAfter.toString());
  await expectRevert("supply-cap tighten below live supply reverts", "SupplyCapBelowSupply", () =>
    program.methods
      .setMaxSilvSupply(liveSupply.sub(new BN(1)))
      .accounts({ config: configPda, admin, silvMint: SILV_MINT })
      .rpc(),
  );

  // 7c. The happy path (tighten to >= live supply) is deliberately NOT exercised
  // here: the cap is tighten-only, so a successful tighten on this live devnet config
  // could never be undone and would cripple it for UI testing.
  //
  // CORRECTED after the review of daac4ac: this comment used to claim the branch was
  // "covered by the caps.rs unit tests instead". It was not. caps.rs had no test
  // module at all, which two reviewers checked and I had not. The tests now exist
  // (validate_new_max_supply, 9 cases including the exactly-at-supply boundary), so
  // the claim is finally true. Stated here because the wrong version of this sentence
  // is exactly the kind of thing an auditor takes at face value.

  // 8. FIX A: emergency_tighten (lower budget) applies
  const budBefore = new BN(cfg.instantRedeemBudgetUsdc);
  // Tighten by the smallest possible step. A tighten cannot be undone without the
  // 24h timelock, so halving the budget on every run would silently degrade the
  // live devnet config toward zero.
  const budTight = budBefore.sub(new BN(1));
  // RULE 2 (scripts/_guard.ts). This is the SAME class of hazard that closed the public
  // mint on 2026-07-29: tightening is instant, but LOOSENING back needs the 24h
  // timelock, so every run permanently shaves the live budget. It is only 1 atomic unit
  // per run, which is why it went unnoticed, but "small and irreversible" is still
  // irreversible. The operator must sanction it explicitly:
  //   DOMINION_INTENT=emergency_tighten_redeem_limits npx tsx scripts/e2e-fixa-devnet.ts
  assertReversible("emergency_tighten_redeem_limits", INTENT);
  await program.methods
    .emergencyTightenRedeemLimits({
      instantRedeemBudgetUsdc: budTight,
      instantRedeemWindowSeconds: null,
      largeRedeemThresholdUsdc: null,
      redeemQueueDelaySeconds: null,
    })
    .accounts({ config: configPda, admin })
    .rpc();
  cfg = await acct.fetch(configPda);
  ok("FIX A emergency_tighten lowers budget", new BN(cfg.instantRedeemBudgetUsdc).eq(budTight));

  // 9. FIX A: loosen via the instant path -> LooseningRequiresTimelock
  await expectRevert("FIX A instant loosen reverts", "LooseningRequiresTimelock", () =>
    program.methods
      .emergencyTightenRedeemLimits({
        instantRedeemBudgetUsdc: budBefore, // higher than current = loosen
        instantRedeemWindowSeconds: null,
        largeRedeemThresholdUsdc: null,
        redeemQueueDelaySeconds: null,
      })
      .accounts({ config: configPda, admin })
      .rpc(),
  );

  // 10. FIX A: propose loosen (timelocked) sets the pending nonce; then cancel clears it
  const nonce = new BN(cfg.nextTimelockNonce);
  const [tlPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("timelock"), Uint8Array.from(nonce.toArrayLike(Buffer, "le", 8))],
    PROGRAM_ID,
  );
  await program.methods
    .proposeSetRedeemLimits({
      instantRedeemBudgetUsdc: budBefore,
      instantRedeemWindowSeconds: null,
      largeRedeemThresholdUsdc: null,
      redeemQueueDelaySeconds: null,
    })
    .accounts({ config: configPda, admin, timelock: tlPda, systemProgram: anchor.web3.SystemProgram.programId })
    .rpc();
  cfg = await acct.fetch(configPda);
  ok("FIX A propose sets pending_redeem_limits_nonce", cfg.pendingRedeemLimitsNonce !== null && new BN(cfg.pendingRedeemLimitsNonce).eq(nonce));

  await program.methods
    .cancelTimelockedAction(nonce)
    .accounts({ config: configPda, timelock: tlPda, rentRecipient: admin, signer: admin, guardian: null })
    .rpc();
  cfg = await acct.fetch(configPda);
  ok("FIX A cancel clears pending nonce", cfg.pendingRedeemLimitsNonce === null);

  // 11. restore the inventory wallet. Step 2 had to point it at the admin (the
  // premint destination ATA must be owned by config.inventory_wallet), so without
  // this the script silently leaves the live config pointing at the deployer.
  //
  // AUDIT review of daac4ac (P2): the restore was skipped when inventoryBefore was
  // null, which is exactly the fresh-config first run the step exists for. It now
  // falls back to the intended launch inventory wallet, so the config always ends in
  // the posture it should be in rather than in the test's posture.
  const INTENDED_INVENTORY = new PublicKey(
    process.env.DOMINION_INVENTORY_WALLET ||
      "EkDhR65JUL8tGhxRhnueaqri6zNzxMEJ82UU35pQ7V56",
  );
  const restoreTo = inventoryBefore ?? INTENDED_INVENTORY;
  if (restoreTo.toBase58() !== admin.toBase58()) {
    await program.methods
      .setInventoryWallet(restoreTo)
      .accounts({ config: configPda, admin })
      .rpc();
    cfg = await acct.fetch(configPda);
    ok(
      "inventory wallet restored (or set to the intended launch wallet)",
      cfg.inventoryWallet.toBase58() === restoreTo.toBase58(),
      restoreTo.toBase58(),
    );
  }

  console.log(`\n=== E2E result: ${pass} passed, ${fail} failed ===`);
  console.log("final config: paused =", cfg.paused, "| inventory =", cfg.inventoryWallet.toBase58(), "| budget =", cfg.instantRedeemBudgetUsdc.toString());
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
