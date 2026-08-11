/**
 * Is every button in the admin panel actually wired?
 *
 * WHY THIS EXISTS. The admin panel had no test that drove its instruction builders, and the launch
 * question it answers is a real one: a dead button, or a button that builds a transaction the program
 * cannot even parse, is only discoverable by pressing it. Pressing them for real is not an option here,
 * because a third of them start a 24-hour timelock and several are one-way. Closing the public mint
 * needs a 24h proposal to reopen it. Tightening the cap cannot be undone. There is no admin burn, so a
 * premint cannot be taken back.
 *
 * SO IT SIMULATES. `apps/admin/src/lib/admin-actions.ts` returns INSTRUCTIONS and never signs, which is
 * exactly the seam this needs: build what the UI would build, put it in a transaction, and hand it to
 * `simulateTransaction`. The runtime executes it against real account state and throws the result away.
 * Nothing is committed, no timelock nonce is consumed, no lamport moves, no keypair is opened.
 *
 * HOW A RESULT IS JUDGED, and this is the part the first version got wrong. It declared, per action, the
 * exact error each one had to fail with. Nine of those declarations were wrong, because they encoded my
 * assumptions about devnet's state rather than anything about the panel: the test wallet turned out to
 * already be a guardian, several proposals were no-ops against the live config, and two builders take a
 * `number` where I passed a `bigint`. A test that has to be right about live state to be green is a test
 * that goes red for reasons that are not defects.
 *
 * So the judgement is on the QUESTION BEING ASKED instead:
 *
 *   BUILD THREW                        -> RED. The button cannot assemble a transaction. Always a defect.
 *   program accepted                   -> GREEN. Wired, and current state allows it.
 *   program REJECTED IT ITSELF         -> GREEN. The instruction reached our program, was parsed, and a
 *                                        named guard spoke. That is "wired" too, and the error is printed
 *                                        so a human can see which guard.
 *   rejected by anything else          -> RED. A malformed instruction, an account that does not resolve,
 *                                        a missing signer: the button is broken, not guarded.
 *
 * A short list of LAUNCH-DAY LEVERS is held to the stricter bar of "must be accepted right now", because
 * for those, "a guard spoke" is not good enough.
 *
 * WHAT A GREEN RUN DOES NOT PROVE: that the effect is correct. That lives in tools/state-harness and the
 * on-chain tests. This proves the panel and the program agree on the wire format and the accounts.
 *
 *   DOMINION_RPC=... npx tsx scripts/test-admin-panel-simulate.ts
 */
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as A from "../apps/admin/src/lib/admin-actions";
import { resolveCluster } from "./_cluster";
import { redactRpc } from "./_redact";

const CLUSTER = resolveCluster();
const conn = new Connection(CLUSTER.rpc, "confirmed");
const PROGRAM = "3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ";

let pass = 0;
let fail = 0;
const failures: string[] = [];
const guarded: string[] = [];

/** A wallet that is not the admin, for builders that need "some other pubkey". */
const OTHER = new PublicKey("7QZSz5KRma7wFS3qnbXkaHsCr5xKJ8cRqsoAJNpxRg4V");

/**
 * Did OUR program reject this, or did it never get there?
 *
 * An AnchorError log names the code and the file. Anchor's own account constraints (3xxx) also come from
 * our program's generated `try_accounts`, so they count: `AccountNotInitialized` on a timelock PDA is the
 * program telling us there is no matured proposal, which is a guard, not a broken button. A CPI failure
 * inside a program we called on purpose (the token program refusing a transfer for insufficient funds) is
 * also a guard speaking about state.
 */
function rejectedByProgram(logs: string): boolean {
  return (
    logs.includes("AnchorError") ||
    logs.includes("Error Code:") ||
    logs.includes(`Program ${PROGRAM} failed: custom program error`) ||
    logs.includes("Program log: Error: insufficient funds")
  );
}

/** Pull the human-readable guard name out of the logs, for the summary. */
function guardName(logs: string): string {
  const m = logs.match(/Error Code: (\w+)/) ?? logs.match(/Program log: Error: (.+)/);
  return m ? m[1] : "rejected";
}

async function sim(
  name: string,
  build: () => Promise<TransactionInstruction[]>,
  signer: PublicKey,
  mustBeAccepted = false,
): Promise<void> {
  let ixs: TransactionInstruction[];
  try {
    ixs = await build();
  } catch (e) {
    fail += 1;
    const why = (e as Error).message.slice(0, 150);
    failures.push(`${name}: BUILD THREW -> ${why}`);
    console.log(`  DEAD  ${name}\n          build threw: ${why}`);
    return;
  }

  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = signer;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  const res = await conn.simulateTransaction(tx, undefined, undefined);
  const logs = (res.value.logs ?? []).join("\n");

  if (!res.value.err) {
    pass += 1;
    console.log(`  ok    ${name}  (${ixs.length} ix, ${res.value.unitsConsumed ?? "?"} CU, accepted)`);
    return;
  }

  if (mustBeAccepted) {
    fail += 1;
    failures.push(`${name}: a LAUNCH LEVER was rejected -> ${guardName(logs)}`);
    console.log(
      `  FAIL  ${name}  (launch lever, must be accepted)\n` +
        `          ${logs.split("\n").slice(-4).join("\n          ")}`,
    );
    return;
  }

  if (rejectedByProgram(logs)) {
    pass += 1;
    guarded.push(`${name}: ${guardName(logs)}`);
    console.log(`  ok    ${name}  (wired; guard spoke: ${guardName(logs)})`);
    return;
  }

  fail += 1;
  failures.push(`${name}: rejected BEFORE our program -> ${JSON.stringify(res.value.err)}`);
  console.log(
    `  FAIL  ${name}  (never reached the program)\n          ${JSON.stringify(res.value.err)}\n` +
      `          ${logs.split("\n").slice(-5).join("\n          ")}`,
  );
}

async function main(): Promise<void> {
  console.log("admin panel: every builder simulated. NOTHING IS COMMITTED.");
  console.log(`  cluster : ${redactRpc(CLUSTER.rpc)} (${CLUSTER.cluster})`);

  const cfg = (await A.fetchConfig(conn)) as any;
  const onchainAdmin = await A.fetchOnchainAdmin(conn);
  if (!cfg || !onchainAdmin) throw new Error("no config account on this cluster: nothing to simulate against");
  const admin = new PublicKey(onchainAdmin.toString());

  console.log(`  admin   : ${admin.toBase58()}`);
  console.log(`  state   : paused=${cfg.paused} publicMint=${cfg.publicMintEnabled} redeem=${cfg.redemptionsEnabled}`);
  console.log(`  cap     : ${Number(cfg.maxSilvSupply) / 1e6} oz | guardians: ${cfg.guardianCount}`);
  console.log("");

  // The panel passes `admin` when the connected wallet IS config.admin: the devnet shape, and the shape a
  // direct-signing ceremony uses. Omitted, builders target the Ops vault PDA. Both are exercised.
  const c: A.BuildCtx = { connection: conn, admin };
  const usdcAta = getAssociatedTokenAddressSync(CLUSTER.usdcMint, admin, true, TOKEN_PROGRAM_ID);
  // A valid future expiry, because zero is explicitly NOT "indefinite" and the program says so.
  const inAYear = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);

  console.log("A. INSTANT actions, no timelock. These are the launch-day levers.");
  // pause and unpause MUST work: pause is the brake, and unpause IS the go-live.
  await sim("pauseAsAdmin", () => A.pauseAsAdmin(c), admin, true);
  await sim("unpause", () => A.unpause(c), admin, true);
  await sim("setFeeExempt (mint+redeem, +1 year)", () => A.setFeeExempt(c, OTHER, 3, inAYear), admin, true);
  await sim("removeFeeExempt", () => A.removeFeeExempt(c, OTHER), admin);
  await sim("addGuardian", () => A.addGuardian(c, OTHER), admin);
  await sim("setMaxSilvSupply (current value, no tighten)", () => A.setMaxSilvSupply(c, BigInt(cfg.maxSilvSupply.toString())), admin);
  await sim("depositUsdc (1 USDC)", () => A.depositUsdc(c, 1_000_000n, usdcAta), admin);
  await sim("withdrawFees (0.1 USDC)", () => A.withdrawFees(c, admin, 100_000n), admin, true);
  await sim("adminPremint (1 oz to config.inventoryWallet)", () => A.adminPremint(c, 1_000_000n, new PublicKey(cfg.inventoryWallet)), admin);

  console.log("");
  console.log("B. GUARDIAN-side actions");
  await sim("pauseAsGuardian", () => A.pauseAsGuardian(c, admin), admin);
  await sim("removeGuardian", () => A.removeGuardian(c, OTHER), admin);
  await sim("finalizeGuardianRemoval", () => A.finalizeGuardianRemoval(c, OTHER), admin);
  await sim("cancelGuardianRemoval", () => A.cancelGuardianRemoval(c, OTHER, admin), admin);

  console.log("");
  console.log("C. KYC actions");
  await sim("attestKyc", () => A.attestKyc(c, admin, OTHER, new Uint8Array(32)), admin);
  await sim("revokeKyc", () => A.revokeKyc(c, admin, OTHER), admin);

  console.log("");
  console.log("D. PROPOSE actions. Each opens a 24h timelock IF SENT. Simulated only.");
  // Values chosen to DIFFER from the live config where the program refuses a no-op, so that the guard
  // being exercised is the real one rather than ProposalNoOp every time.
  const proposals: [string, () => Promise<TransactionInstruction[]>][] = [
    ["proposeSetPremiumMint(120bps)", () => A.proposeSetPremiumMint(c, 120)],
    ["proposeSetPremiumRedeem(170bps)", () => A.proposeSetPremiumRedeem(c, 170)],
    ["proposeSetPublicMint(toggle)", () => A.proposeSetPublicMint(c, !cfg.publicMintEnabled)],
    ["proposeSetTreasuryMinFloat(1 USDC)", () => A.proposeSetTreasuryMinFloat(c, 1_000_000n)],
    ["proposeSetAdminTimelock(90000s)", () => A.proposeSetAdminTimelock(c, 90_000)],
    ["proposeSetPythFeed(3155)", () => A.proposeSetPythFeed(c, 3155)],
    ["proposeSetInventoryWallet", () => A.proposeSetInventoryWallet(c, OTHER)],
    ["proposeSetComplianceMode(toggle)", () => A.proposeSetComplianceMode(c, !cfg.complianceMode)],
    ["proposeWithdrawUsdc(0.1)", () => A.proposeWithdrawUsdc(c, 100_000n, admin)],
    ["proposeAdminTransfer", () => A.proposeAdminTransfer(c, OTHER)],
    ["proposeUpdateMetadata", () => A.proposeUpdateMetadata(c, "Dominion Silver", null, null)],
    // confBps 50 rather than a staleness change: isolating the fields showed `stalenessSeconds: 90` is
    // refused with AboveMaximum, so the staleness has a hard CEILING and cannot be loosened past it.
    // Worth knowing before launch day, and it means this case has to pick a field it is allowed to move
    // or it would prove nothing but the guard.
    ["proposeSetOracleGuards(confBps 50)", () => A.proposeSetOracleGuards(c, { confBps: 50 })],
    ["proposeSetRedeemLimits", () => A.proposeSetRedeemLimits(c, { instantRedeemBudgetUsdc: 25_000_000_000n, instantRedeemWindowSeconds: 86_400 })],
  ];
  for (const [name, build] of proposals) await sim(name, build, admin);

  console.log("");
  console.log("E. EXECUTE and CANCEL. All need a matured proposal, so a guard is the expected answer.");
  for (const m of A.EXEC_METHODS) {
    await sim(`executeTimelocked(${m})`, () => A.executeTimelocked(c, m, 0n, admin), admin);
  }
  await sim("executeUpdateMetadata", () => A.executeUpdateMetadata(c, 0n, admin), admin);
  await sim("executeWithdrawUsdc", () => A.executeWithdrawUsdc(c, 0n, admin, usdcAta), admin);
  await sim("cancelTimelockedAction", () => A.cancelTimelockedAction(c, 0n, admin, admin), admin);
  await sim("acceptAdminTransfer", () => A.acceptAdminTransfer(c), admin);
  await sim("cancelAdminTransfer", () => A.cancelAdminTransfer(c), admin);

  console.log("");
  console.log("F. The SQUADS shape: no `admin` in the context, so builders must target the Ops vault PDA.");
  // Deliberately NOT simulated: the vault is not a signer here, so it could only fail. What matters is
  // that the builders RESOLVE against a PDA admin at all. On mainnet `config.admin` IS the Ops vault, so
  // a builder that silently only works with a plain-wallet admin would be dead on arrival at the
  // ceremony, and that is exactly the failure this section exists to catch early.
  const cVault: A.BuildCtx = { connection: conn };
  const vault = A.adminAuthority().toBase58();
  for (const [name, build] of [
    ["pauseAsAdmin via vault", () => A.pauseAsAdmin(cVault)],
    ["unpause via vault", () => A.unpause(cVault)],
    ["addGuardian via vault", () => A.addGuardian(cVault, OTHER)],
    ["adminPremint via vault", () => A.adminPremint(cVault, 1_000_000n, new PublicKey(cfg.inventoryWallet))],
    ["proposeSetPremiumMint via vault", () => A.proposeSetPremiumMint(cVault, 120)],
  ] as [string, () => Promise<TransactionInstruction[]>][]) {
    try {
      const ixs = await build();
      const signers = ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()));
      if (signers.includes(vault)) {
        pass += 1;
        console.log(`  ok    ${name}  (asks ${vault.slice(0, 8)}… to sign)`);
      } else {
        fail += 1;
        failures.push(`${name}: does not ask the Ops vault to sign, signers are ${signers.join(", ")}`);
        console.log(`  FAIL  ${name}\n          signers: ${signers.join(", ")}`);
      }
    } catch (e) {
      fail += 1;
      failures.push(`${name}: BUILD THREW -> ${(e as Error).message.slice(0, 120)}`);
      console.log(`  DEAD  ${name}  build threw: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  console.log("");
  if (guarded.length) {
    console.log(`Guards that spoke (wired, refused by current state) -- ${guarded.length}:`);
    for (const g of guarded) console.log(`  ${g}`);
    console.log("");
  }
  console.log(`=== ${pass} wired, ${fail} broken ===`);
  if (fail > 0) {
    console.log("");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("Every admin builder assembles a transaction our program parses. No dead buttons.");
  console.log("NOTHING WAS COMMITTED: simulation only. No signature, no timelock started, no lamport moved.");
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
