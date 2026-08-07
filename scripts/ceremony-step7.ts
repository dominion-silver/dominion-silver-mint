/**
 * Runbook step 7: the timelocked launch openings, proposed together so their 24h clocks mature together.
 *
 * The program allows one active proposal per TYPE, not one in total, so these do not queue behind each
 * other. Verified on devnet 2026-08-07 with four coexisting proposals. Getting this wrong costs a whole
 * extra day per proposal, which is why they are in one script rather than three runbook lines.
 *
 *   propose_set_public_mint(true)              opens the public mint
 *   propose_set_treasury_min_float(<float>)    the withdrawal floor, a BLOCKER before opening redeem
 *
 * ROUND 4 P0-04: this used to ALSO propose redemptions_enabled = true, which contradicts the launch posture.
 * `config/mainnet-authorities.json` says `redemptions_enabled: False`, and the audit brief says redemptions
 * ship CLOSED. Two operators following two halves of the documentation got two different launch postures,
 * and following this script opened the only path that pays out principal USDC. Opening redeem is a
 * post-launch decision, made deliberately, not a line in the launch script. The assertion at the end fails
 * if that ever drifts back.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { resolveCluster, describeCluster } from "./_cluster";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { PROGRAM_ID } from "./_program-id";
import idl from "../target/idl/dominion_silver_mint.json";

/**
 * ROUND 4 P0-03. `config.admin` en mainnet est un PDA Squads OFF-CURVE
 * (`65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS`, `isOnCurve == false`). Aucune cle privee ne peut signer
 * pour lui, donc tout `has_one = admin` echoue, quelle que soit la cle passee. Ce script envoyait
 * directement avec un `Keypair`: il ne pouvait pas fonctionner en mainnet, et il a ete valide sur devnet ou
 * l admin EST la cle de dev, c est-a-dire la seule configuration ou le defaut est invisible.
 *
 * En attendant la decision (supprimer ces scripts et passer par le panneau admin, qui route deja 35 actions
 * via Squads, ou les convertir en constructeurs de transactions Squads), ils REFUSENT de tourner plutot que
 * d echouer en pleine ceremonie.
 */
function refuseIfAdminIsOffCurve(configAdmin: PublicKey, signer: PublicKey): void {
  if (configAdmin.equals(signer)) return;
  const onCurve = PublicKey.isOnCurve(configAdmin.toBytes());
  const why = onCurve
    ? "config.admin n est pas la cle passee: ce script ne peut signer que pour lui-meme."
    : "config.admin est OFF-CURVE (un PDA, typiquement un coffre Squads). Aucune cle privee n existe pour " +
      "lui, donc has_one = admin echouera quoi qu il arrive.";
  throw new Error(
    `REFUS: ${why}\n` +
      `  config.admin : ${configAdmin.toBase58()}${onCurve ? "" : "  (off-curve)"}\n` +
      `  cle fournie  : ${signer.toBase58()}\n` +
      `Passez par le panneau admin, qui construit ces instructions et les depose dans la transaction ` +
      `Squads. Voir ROUND 4 P0-03.`,
  );
}

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

  refuseIfAdminIsOffCurve((await cfg()).admin, admin.publicKey);
  const c0 = await cfg();
  console.log(`  float demande: ${floatUsdc} micro-USDC (${(floatUsdc / 1e6).toFixed(2)} USDC)`);
  console.log(`  nonce courant: ${c0.nextTimelockNonce}, propositions actives: ${c0.activeProposalCount}`);

  const jobs: Array<[string, unknown, unknown]> = [
    ["propose_set_public_mint(true)", c0.pendingPublicMintNonce, () => M.proposeSetPublicMint(true)],
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
  console.log(`  publicMint=${c.pendingPublicMintNonce} float=${c.pendingTreasuryFloatNonce} (redeem: FERME au lancement, par conception)`);
  // P0-04: the launch posture is redemptions CLOSED. Fail loudly if the chain or a stray proposal says
  // otherwise, rather than letting the ceremony hand over a state nobody chose.
  if (c.redemptionsEnabled !== false || c.pendingRedeemLimitsNonce != null) {
    console.error(
      `\n  REFUS: la posture de lancement est redemptions FERMEES.\n` +
        `    redemptionsEnabled       = ${c.redemptionsEnabled}\n` +
        `    pendingRedeemLimitsNonce = ${c.pendingRedeemLimitsNonce}\n` +
        `  Annulez la proposition (cancel_timelocked_action) avant de continuer, ou decidez ` +
        `explicitement d ouvrir le redeem au lancement et mettez a jour mainnet-authorities.json.`,
    );
    process.exit(1);
  }
  const eta = new Date(Date.now() + Number(c.adminTimelockSeconds) * 1000);
  console.log(`\n  LES DEUX EXECUTABLES A PARTIR DE: ${eta.toISOString()}`);
  console.log(`  Ensuite: etape 10, executer les trois, puis l E2E complet.`);
}
main().catch((e) => {
  console.error("etape 7 echouee:", e instanceof Error ? e.message : e);
  process.exit(1);
});
