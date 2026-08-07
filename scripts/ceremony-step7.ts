/**
 * Runbook step 7: the THREE timelocked openings, proposed together so their 24h clocks mature together.
 *
 * The program allows one active proposal per TYPE, not one in total, so these do not queue behind each
 * other. Verified on devnet 2026-08-07 with four coexisting proposals. Getting this wrong costs a whole
 * extra day per proposal, which is why they are in one script rather than three runbook lines.
 *
 *   propose_set_public_mint(true)              opens the public mint
 *   propose_set_redeem_limits(enabled=true)    opens redemptions
 *   propose_set_treasury_min_float(<float>)    the withdrawal floor, a BLOCKER before opening redeem
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";
import idl from "../target/idl/dominion_silver_mint.json";

async function main() {
  const CLUSTER = await resolveCluster();
  await requireSanctionedCluster(CLUSTER.rpc, "ceremony step 7: the three timelocked openings");
  assertReversible("propose_any", intentFromEnv());
  console.error(`# ${describeCluster(CLUSTER)}`);

  const floatUsdc = Number(process.env.DOMINION_TREASURY_MIN_FLOAT_USDC ?? "");
  if (!Number.isFinite(floatUsdc) || floatUsdc <= 0) {
    throw new Error(
      "Set DOMINION_TREASURY_MIN_FLOAT_USDC to a NON-ZERO amount in micro-USDC. It defaults to 0 on chain, " +
        "which lets a withdrawal drain the whole treasury (SolidProof LOW #4). There is no safe default here.",
    );
  }
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DOMINION_KEYPAIR!, "utf8"))),
  );
  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const M = program.methods as any;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const cfg = async (): Promise<any> => (program.account as any).configAccount.fetch(configPda);
  const send = (ix: any) =>
    sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin], { commitment: "confirmed" });

  const c0 = await cfg();
  console.log(`  float demande: ${floatUsdc} micro-USDC (${(floatUsdc / 1e6).toFixed(2)} USDC)`);
  console.log(`  nonce courant: ${c0.nextTimelockNonce}, propositions actives: ${c0.activeProposalCount}`);

  const jobs: Array<[string, unknown, unknown]> = [
    ["propose_set_public_mint(true)", c0.pendingPublicMintNonce, () => M.proposeSetPublicMint(true)],
    [
      "propose_set_redeem_limits(redemptions_enabled=true)",
      c0.pendingRedeemLimitsNonce,
      () =>
        M.proposeSetRedeemLimits({
          instantRedeemBudgetUsdc: null,
          instantRedeemWindowSeconds: null,
          largeRedeemThresholdUsdc: null,
          redeemQueueDelaySeconds: null,
          redemptionsEnabled: true,
        }),
    ],
    [
      `propose_set_treasury_min_float(${floatUsdc})`,
      c0.pendingTreasuryFloatNonce,
      () => M.proposeSetTreasuryMinFloat(new anchor.BN(floatUsdc)),
    ],
  ];
  for (const [label, pending, build] of jobs) {
    if (pending !== null && pending !== undefined) {
      console.log(`  ${label}: DEJA en attente au nonce ${pending}`);
      continue;
    }
    const ix = await (build as () => any)()
      .accounts({ config: configPda, admin: admin.publicKey })
      .instruction();
    console.log(`  ${label}: ${await send(ix)}`);
  }

  const c = await cfg();
  console.log(`\n  propositions actives: ${c.activeProposalCount}`);
  console.log(`  publicMint=${c.pendingPublicMintNonce} redeemLimits=${c.pendingRedeemLimitsNonce} float=${c.pendingTreasuryFloatNonce}`);
  const eta = new Date(Date.now() + Number(c.adminTimelockSeconds) * 1000);
  console.log(`\n  LES TROIS EXECUTABLES A PARTIR DE: ${eta.toISOString()}`);
  console.log(`  Ensuite: etape 10, executer les trois, puis l E2E complet.`);
}
main().catch((e) => {
  console.error("etape 7 echouee:", e instanceof Error ? e.message : e);
  process.exit(1);
});
