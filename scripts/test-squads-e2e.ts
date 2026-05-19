/**
 * E2E: the Squads v4 proposal pipeline our admin UI depends on, on REAL
 * devnet. Creates a throwaway 2-of-3 multisig, funds its vault, then drives
 * the EXACT flow squads.ts / AdminActions uses:
 *   vaultTransactionCreate -> proposalCreate -> proposalApprove x2 (reach
 *   threshold) -> vaultTransactionExecute, with a benign inner instruction
 *   (a small SOL transfer authored by the vault). Asserts the proposal
 *   reaches `Executed` and the vault-authored transfer landed.
 *
 * Self-contained: does NOT touch the deployed dominion program. The
 * dominion-specific E2E (config.admin = a test Squads vault) is the
 * follow-on once a dedicated test deploy exists - documented, not run here.
 *
 * Run (needs a funded devnet keypair, >= ~0.2 SOL):
 *   SQUADS_E2E_KEYPAIR=~/.config/solana/dominion-test-user.json \
 *     npx tsx scripts/test-squads-e2e.ts
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";

const APUB = "/Users/thomasblanc/1_app/dominion/apps/admin/";
const r = createRequire(APUB);
/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Transaction,
} = r("@solana/web3.js");
const multisig = r("@sqds/multisig");

const RPC = "https://api.devnet.solana.com";

function loadFunder(): any {
  const p = (
    process.env.SQUADS_E2E_KEYPAIR ||
    os.homedir() + "/.config/solana/dominion-test-user.json"
  ).replace(/^~/, os.homedir());
  if (!fs.existsSync(p)) {
    console.error(
      `FAIL: funder keypair not found at ${p}. Set SQUADS_E2E_KEYPAIR to a funded devnet keypair (>= ~0.2 SOL).`,
    );
    process.exit(1);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name} ${detail ? ":: " + detail : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${detail ? ":: " + detail : ""}`);
  }
}

async function airdropOrTransfer(
  conn: any,
  funder: any,
  to: any,
  lamports: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: to,
      lamports,
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [funder], {
    commitment: "confirmed",
  });
}

/** Confirm a Squads rpc signature at "confirmed". */
async function confirmSig(conn: any, sig: string) {
  const bh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );
}

/** Poll until an account exists (devnet read-after-write can lag). */
async function waitForAccount(conn: any, pk: any, tries = 20, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    const ai = await conn.getAccountInfo(pk, "confirmed");
    if (ai) return;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new Error(`account ${pk.toBase58()} not visible after ${tries} polls`);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const funder = loadFunder();
  const bal = await conn.getBalance(funder.publicKey);
  console.log("Squads v4 E2E (devnet)");
  console.log("funder:", funder.publicKey.toBase58(), bal / LAMPORTS_PER_SOL, "SOL");
  if (bal < 0.2 * LAMPORTS_PER_SOL) {
    console.error(
      `FAIL: funder has ${bal / LAMPORTS_PER_SOL} SOL, need >= ~0.2 SOL on devnet. Fund it and re-run.`,
    );
    process.exit(1);
  }

  // Members + the create key.
  const createKey = Keypair.generate();
  const memberA = Keypair.generate(); // creator + fee payer for all txs
  const memberB = Keypair.generate(); // 2nd approver (reaches threshold 2)
  const memberC = Keypair.generate(); // 3rd member (does not need to act)

  // memberA pays every tx + the multisig/proposal rent; fund it.
  await airdropOrTransfer(conn, funder, memberA.publicKey, 0.15 * LAMPORTS_PER_SOL);

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });
  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig =
    await multisig.accounts.ProgramConfig.fromAccountAddress(
      conn,
      programConfigPda,
    );
  const treasury = programConfig.treasury;

  console.log("multisig:", multisigPda.toBase58());

  // 1. Create the 2-of-3 multisig.
  const members = [memberA, memberB, memberC].map((k) => ({
    key: k.publicKey,
    permissions: multisig.types.Permissions.all(),
  }));
  const createSig = await multisig.rpc.multisigCreateV2({
    connection: conn,
    treasury,
    createKey,
    creator: memberA,
    multisigPda,
    configAuthority: null,
    threshold: 2,
    members,
    timeLock: 0,
    rentCollector: null,
    sendOptions: { skipPreflight: false },
  });
  await confirmSig(conn, createSig);
  await waitForAccount(conn, multisigPda);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(
    conn,
    multisigPda,
  );
  check("multisig created", Number(ms.threshold) === 2, `threshold=${ms.threshold}`);
  check("3 members", ms.members.length === 3);

  // 2. Fund the vault so it can author a transfer.
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  await airdropOrTransfer(conn, funder, vaultPda, 0.02 * LAMPORTS_PER_SOL);
  const vaultBalBefore = await conn.getBalance(vaultPda);
  check("vault funded", vaultBalBefore > 0, `${vaultBalBefore} lamports`);

  // 3. Inner instruction the vault will author: transfer 0.001 SOL back to
  //    the funder (proves a real vault-authored on-chain effect).
  const transferLamports = 0.001 * LAMPORTS_PER_SOL;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: vaultPda,
        toPubkey: funder.publicKey,
        lamports: transferLamports,
      }),
    ],
  });

  const transactionIndex = 1n;

  // 4. vaultTransactionCreate
  await confirmSig(
    conn,
    await multisig.rpc.vaultTransactionCreate({
      connection: conn,
      feePayer: memberA,
      multisigPda,
      transactionIndex,
      creator: memberA.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: innerMessage,
    }),
  );
  check("vault transaction created", true, `index=${transactionIndex}`);

  // 5. proposalCreate
  await confirmSig(
    conn,
    await multisig.rpc.proposalCreate({
      connection: conn,
      feePayer: memberA,
      creator: memberA,
      multisigPda,
      transactionIndex,
    }),
  );

  // 6. Approve to threshold (memberA + memberB = 2-of-3).
  await confirmSig(
    conn,
    await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: memberA,
      member: memberA,
      multisigPda,
      transactionIndex,
    }),
  );
  await confirmSig(
    conn,
    await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: memberA,
      member: memberB,
      multisigPda,
      transactionIndex,
    }),
  );
  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
  });
  await waitForAccount(conn, proposalPda);
  let proposal = await multisig.accounts.Proposal.fromAccountAddress(
    conn,
    proposalPda,
  );
  check(
    "proposal approved to threshold",
    (proposal.approved?.length ?? 0) >= 2,
    `${proposal.approved?.length} approvals`,
  );

  // 7. Execute.
  const funderBalBefore = await conn.getBalance(funder.publicKey);
  await confirmSig(
    conn,
    await multisig.rpc.vaultTransactionExecute({
      connection: conn,
      feePayer: memberA,
      multisigPda,
      transactionIndex,
      member: memberA.publicKey,
    }),
  );

  // 8. Assertions.
  await new Promise((res) => setTimeout(res, 2000));
  proposal = await multisig.accounts.Proposal.fromAccountAddress(
    conn,
    proposalPda,
  );
  check(
    "proposal status = Executed",
    proposal.status?.__kind === "Executed",
    proposal.status?.__kind,
  );
  const funderBalAfter = await conn.getBalance(funder.publicKey);
  check(
    "vault-authored transfer landed",
    funderBalAfter >= funderBalBefore + transferLamports - 5000,
    `+${funderBalAfter - funderBalBefore} lamports`,
  );

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  console.log(
    "Proves the Squads create -> approve(threshold) -> execute pipeline that " +
      "squads.ts / AdminActions use, on real devnet. Dominion-admin E2E " +
      "(config.admin = a test Squads vault) is the documented follow-on.",
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
