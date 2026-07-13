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

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("AX7seVo6Mu1j8jgipvN4dMk4erNrwdSUXNPDACYoHw2W");
const SILV_MINT = new PublicKey("5i13gz6vGKTYhpWbMuQfiBAApfNHCxxJu2GtDGM1A2Li");

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
  console.log("Initial: paused =", cfg.paused, "| publicMint =", cfg.publicMintEnabled, "| redeem =", cfg.redemptionsEnabled);

  // 1. unpause
  await program.methods.unpause().accounts({ config: configPda, admin }).rpc();
  cfg = await acct.fetch(configPda);
  ok("unpause: paused == false", cfg.paused === false);

  // 2. set_inventory_wallet(admin)
  await program.methods.setInventoryWallet(admin).accounts({ config: configPda, admin }).rpc();
  cfg = await acct.fetch(configPda);
  ok("set_inventory_wallet", cfg.inventoryWallet.toBase58() === admin.toBase58());

  // 3. inventory SILV ATA (Token-2022, owner = admin)
  const invAta = getAssociatedTokenAddressSync(SILV_MINT, admin, false, TOKEN_2022_PROGRAM_ID);
  await createAssociatedTokenAccountIdempotent(conn, kp, SILV_MINT, admin, {}, TOKEN_2022_PROGRAM_ID);

  // 4. admin_premint 1000 oz -> supply + inventory balance
  const supplyBefore = (await getMint(conn, SILV_MINT, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
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
  const invBal = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  ok("admin_premint: supply += 1000oz", supplyAfter - supplyBefore === BigInt(AMT.toString()));
  ok("admin_premint: inventory credited", invBal === BigInt(AMT.toString()));

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

  // 7. set_max_silv_supply raise -> blocked
  await expectRevert("supply-cap raise reverts", "SupplyCapRaiseBlocked", () =>
    program.methods.setMaxSilvSupply(new BN(cfg.maxSilvSupply).add(new BN(1))).accounts({ config: configPda, admin }).rpc(),
  );

  // 8. FIX A: emergency_tighten (lower budget) applies
  const budBefore = new BN(cfg.instantRedeemBudgetUsdc);
  const budTight = budBefore.div(new BN(2));
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

  console.log(`\n=== E2E result: ${pass} passed, ${fail} failed ===`);
  console.log("final config: paused =", cfg.paused, "| inventory =", cfg.inventoryWallet.toBase58(), "| budget =", cfg.instantRedeemBudgetUsdc.toString());
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
