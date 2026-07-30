/**
 * T3: on-chain proof of the public-mint gate ("mint at launch", Thomas 2026-07-26).
 *
 * The gate is deliberately ASYMMETRIC, the same tighten-fast/loosen-slow shape as FIX A:
 *
 *   OPEN  = propose_set_public_mint(true) -> wait 24h -> execute_set_public_mint
 *           (announced, guardian-cancellable)
 *   CLOSE = set_public_mint_enabled(false)
 *           (instant, one transaction)
 *
 * Why: opening wakes the ORACLE path, which is completely dormant while public mint and
 * redemptions are both closed, so every staleness / confidence / publisher-floor /
 * price-band guard becomes load-bearing at that instant. It also lets the public consume
 * the supply-cap headroom that backs the pre-minted inventory. Closing is the emergency
 * direction and must take one transaction: if the feed degrades, minting has to stop NOW.
 *
 * NON-DESTRUCTIVE: leaves public_mint_enabled exactly as it found it. The 24h execute
 * happy path is not covered here (real wait, no timelock bypass in the release build);
 * the revert-before-ETA is.
 *
 * Run: DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json npx tsx scripts/e2e-public-mint-devnet.ts
 */
import { AnchorProvider, Program, Wallet, Idl, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireDevnet, assertReversible, intentFromEnv } from "./_guard";

const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";
const PROGRAM_ID = SHARED_PROGRAM_ID;

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}: ${name}${detail ? " -> " + detail : ""}`);
  cond ? pass++ : fail++;
}
async function expectRevert(name: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "expected revert, tx SUCCEEDED");
  } catch (e: any) {
    const txt = (e?.error?.errorCode?.code || "") + " " + (e?.message || String(e));
    ok(name, txt.includes(code), `got ${e?.error?.errorCode?.code || txt.slice(0, 90)}`);
  }
}

async function main() {
  // RULE 1 (scripts/_guard.ts): refuse any cluster but devnet unless
  // DOMINION_ALLOW_MAINNET is explicitly set.
  requireDevnet(RPC, "T3 public-mint gate");
  const INTENT = intentFromEnv();
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.DOMINION_KEYPAIR ||
            path.join(os.homedir(), ".config/solana/dominion-dev.json"),
          "utf8",
        ),
      ),
    ),
  );
  const admin = kp.publicKey;
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
      "utf8",
    ),
  ) as Idl;
  const program = new Program(idl, provider);
  const acct = (program.account as any).configAccount;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const tlPda = (nonce: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), Uint8Array.from(nonce.toArrayLike(Buffer, "le", 8))],
      PROGRAM_ID,
    )[0];

  let cfg: any = await acct.fetch(configPda);
  const startedOpen = cfg.publicMintEnabled;
  console.log("T3 public-mint gate");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  public_mint_enabled:", startedOpen);
  console.log("  pending_public_mint_nonce:", String(cfg.pendingPublicMintNonce), "\n");

  // The migration check: this field was carved out of `reserved` AFTER `version`, so an
  // in-place upgrade over a config written by the previous layout must read None here
  // and must NOT have shifted `version`. Getting this wrong bricks guardian removal
  // (see the ConfigAccount carve-out note in state/config.rs).
  ok("config still decodes with version == 2 after the layout carve-out", cfg.version === 2, `version=${cfg.version}`);
  ok(
    "pending_public_mint_nonce read as None from the old reserved bytes",
    cfg.pendingPublicMintNonce === null,
  );

  // --- 1. Opening instantly is refused. This is the core asymmetry.
  await expectRevert(
    "set_public_mint_enabled(true) is refused (open needs the timelock)",
    "PublicMintOpenRequiresTimelock",
    () =>
      program.methods
        .setPublicMintEnabled(true)
        .accounts({ config: configPda, admin })
        .rpc(),
  );

  // --- 2. Proposing a CLOSE through the timelock is refused: close is instant-only, so
  // allowing it here would create a second, slower path to the same place and a
  // pending-nonce that blocks the open path for 24h for no reason.
  await expectRevert(
    "propose_set_public_mint(false) is refused (close is instant-only)",
    "PublicMintOpenRequiresTimelock",
    async () => {
      const c: any = await acct.fetch(configPda);
      return program.methods
        .proposeSetPublicMint(false)
        .accounts({
          config: configPda,
          admin,
          timelock: tlPda(new BN(c.nextTimelockNonce)),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    },
  );

  if (!startedOpen) {
    // --- 3. A no-op close is refused, so an operator gets a clear error rather than a
    // silent success that implies something happened.
    await expectRevert(
      "closing an already-closed mint is refused as a no-op",
      "PublicMintUnchanged",
      () =>
        program.methods
          .setPublicMintEnabled(false)
          .accounts({ config: configPda, admin })
          .rpc(),
    );

    // --- 4. The real OPEN proposal.
    cfg = await acct.fetch(configPda);
    const nonce = new BN(cfg.nextTimelockNonce);
    await program.methods
      .proposeSetPublicMint(true)
      .accounts({
        config: configPda,
        admin,
        timelock: tlPda(nonce),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    cfg = await acct.fetch(configPda);
    ok(
      "propose_set_public_mint(true) sets the pending nonce",
      cfg.pendingPublicMintNonce !== null &&
        new BN(cfg.pendingPublicMintNonce).eq(nonce),
      `nonce ${nonce.toString()}`,
    );
    ok(
      "the mint is STILL closed while the proposal is pending",
      cfg.publicMintEnabled === false,
    );

    // --- 5. A second proposal is refused: single-active-per-kind.
    await expectRevert(
      "a second open proposal is refused",
      "ProposalAlreadyActive",
      async () => {
        const c: any = await acct.fetch(configPda);
        return program.methods
          .proposeSetPublicMint(true)
          .accounts({
            config: configPda,
            admin,
            timelock: tlPda(new BN(c.nextTimelockNonce)),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      },
    );

    // --- 6. Executing before the ETA is refused. THE point of the delay.
    await expectRevert(
      "execute before the 24h ETA is refused",
      "TimelockNotElapsed",
      () =>
        program.methods
          .executeSetPublicMint(nonce)
          .accounts({
            config: configPda,
            admin,
            timelock: tlPda(nonce),
            rentRecipient: admin,
          })
          .rpc(),
    );

    // --- 7. Cancel clears the pending nonce (this is the guardian's veto path; the
    // admin can use it too).
    await program.methods
      .cancelTimelockedAction(nonce)
      .accounts({
        config: configPda,
        timelock: tlPda(nonce),
        rentRecipient: admin,
        signer: admin,
        guardian: null,
      })
      .rpc();
    cfg = await acct.fetch(configPda);
    ok(
      "cancel clears pending_public_mint_nonce",
      cfg.pendingPublicMintNonce === null,
    );
    ok("the mint is still closed after the cancel", cfg.publicMintEnabled === false);
  } else {
    // DESIGN CORRECTION, learned the hard way on 2026-07-29. This branch used to
    // exercise the instant close when it found the mint already OPEN, then count a
    // failure because it could not restore the posture. That is worse than useless: it
    // CLOSED a mint that had just been opened through a 24h timelock, and reopening
    // costs another 24h. A test must never take an action whose undo is a day long.
    //
    // The instant-close path is covered by the unit tests in caps.rs
    // (public_mint_tests) and by the "closing an already-closed mint is refused" case
    // above when the mint is closed. Here we refuse and say why.
    console.log("  REFUSING to run the destructive half: public mint is currently OPEN.");
    console.log("  Exercising the instant close would shut a mint that took a 24h");
    console.log("  timelock to open, and reopening costs another 24h. The close path is");
    console.log("  covered by caps.rs::public_mint_tests instead.");
    console.log("  To test the open flow, run this against a config with mint CLOSED.");
  }

  const finalCfg: any = await acct.fetch(configPda);
  console.log(`\n=== T3 result: ${pass} passed, ${fail} failed ===`);
  console.log(
    "final: public_mint_enabled =",
    finalCfg.publicMintEnabled,
    "| pending nonce =",
    String(finalCfg.pendingPublicMintNonce),
  );
  if (finalCfg.publicMintEnabled !== startedOpen) {
    console.log("WARNING: this run changed public_mint_enabled. That should not happen.");
    process.exit(1);
  }
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error("T3 crashed:", e);
  process.exit(1);
});
