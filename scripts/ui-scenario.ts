/**
 * SUPERSEDED. Do not use.
 *
 * AUDIT review of daac4ac (P2): this script calls instructions that no longer exist
 * in the program ABI:
 *   set_large_redeem_threshold / set_redeem_queue_delay (replaced by FIX A)
 * It also held a program id retired one or two generations ago. It cannot work, and
 * it fails deep inside with an opaque error that reads like a protocol fault rather
 * than a stale script. Kept for its historical assertions only.
 *
 * Current equivalents:
  scripts/e2e-fixa-devnet.ts        launch posture + FIX A, on the live program
  scripts/e2e-guardian-devnet.ts    the guardian removal lifecycle (DOM-007)
  scripts/t1-hostile-bootstrap.ts   the initialize authentication (DOM-001, P0)
  scripts/read-config.ts            dump the live config
 */
if (!process.env.DOMINION_RUN_SUPERSEDED) {
  console.error(
    "scripts/ui-scenario.ts is SUPERSEDED: it calls instructions removed from the ABI.\n" +
      "See the header for current equivalents. Set DOMINION_RUN_SUPERSEDED=1 to " +
      "run it anyway (it will fail).",
  );
  process.exit(2);
}

/**
 * UI test scenario controller (devnet, admin-keyed). Flips on-chain params so
 * Thomas can manually exercise V2-specific UI paths, then restores §6.
 *
 * Usage (from dominion root):
 *   PATH="<solana-bin>:$PATH" node_modules/.bin/tsx scripts/ui-scenario.ts <cmd>
 *
 * cmd:
 *   state            print current relevant config + live SILV supply
 *   roundA-setup     supply cap barely above supply (mint-too-big fails) +
 *                    large_redeem_threshold $0.10 + redeem_queue_delay 0
 *                    (queued-redeem + claim testable instantly)
 *   roundA-restore   restore cap 712M / threshold $5000 / delay T+3
 *   redemptions-off  set redemptions_enabled = false
 *   redemptions-on   set redemptions_enabled = true
 *   pause            set paused = true
 *   unpause          set paused = false
 *   restore-all      §6 defaults for every param above + redemptions on + unpaused
 *
 * Deps resolved from apps/public/node_modules (single web3 instance).
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
import { requireSanctionedCluster } from "./_guard";
import { resolveCluster, describeCluster } from "./_cluster";

// ROUND 3 P2. This script calls `conn.sendRawTransaction(...)` and had NO cluster guard. The structural
// assertion in verify-cluster-resolution.ts missed it because its send detector recognised only
// `sendAndConfirmTransaction` and an exact `.rpc()`, so the gate printed a clean 30/30 over an incomplete
// set. Both are fixed: the detector is wider, and this script now resolves its cluster from the environment
// and passes through the one guard.
const CLUSTER = resolveCluster();

const APUB = "/Users/thomasblanc/1_app/dominion/apps/public/";
const r = createRequire(APUB);
/* eslint-disable @typescript-eslint/no-explicit-any */
const { Connection, Keypair, PublicKey, Transaction } = r("@solana/web3.js");
const anchor = r("@coral-xyz/anchor");
const { BN } = anchor;

const RPC = "https://api.devnet.solana.com";
const PID = SHARED_PROGRAM_ID;
const SILV = new PublicKey("4bNYnE1d8XV1W4iJuWVqmxVi5qqvAopvxekifDVvB4Ew");
const CFG = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PID,
)[0];

// §6 defaults.
const DEF_MAX_SUPPLY = "712000000"; // 712 oz * 1e6
const DEF_THRESHOLD = "5000000000"; // $5000
const DEF_QUEUE_DELAY = 259_200; // T+3

async function main() {
  await requireSanctionedCluster(CLUSTER.rpc, "ui-scenario.ts");
  console.log("  " + describeCluster(CLUSTER));
  const cmd = process.argv[2] ?? "state";
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          os.homedir() + "/.config/solana/dominion-dev.json",
          "utf8",
        ),
      ),
    ),
  );
  const conn = new Connection(RPC, "confirmed");
  const program = new anchor.Program(
    JSON.parse(
      fs.readFileSync(APUB + "src/lib/idl/dominion_silver_mint.json", "utf8"),
    ),
    new anchor.AnchorProvider(conn, new anchor.Wallet(admin), {
      commitment: "confirmed",
    }),
  );
  const m = program.methods as any;
  const cfg = () => (program.account as any).configAccount.fetch(CFG);
  const A = { config: CFG, admin: admin.publicKey };

  const supply = async () =>
    BigInt((await conn.getTokenSupply(SILV)).value.amount);

  async function send(ix: any, signers: any[]) {
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  }

  async function printState(tag: string) {
    const c = await cfg();
    const s = await supply();
    console.log(
      `[${tag}] supply=${s} maxSilvSupply=${c.maxSilvSupply} largeRedeemThresholdUsdc=${c.largeRedeemThresholdUsdc} redeemQueueDelaySeconds=${c.redeemQueueDelaySeconds} redemptionsEnabled=${c.redemptionsEnabled} paused=${c.paused} nextRedeemRequestNonce=${c.nextRedeemRequestNonce}`,
    );
  }

  await printState("BEFORE " + cmd);

  if (cmd === "state") {
    return;
  } else if (cmd === "roundA-setup") {
    const s = await supply();
    const cap = (s + 1000n).toString(); // +0.001 SILV: any normal mint exceeds
    await send(
      await m.setMaxSilvSupply(new BN(cap)).accounts(A).instruction(),
      [admin],
    );
    await send(
      await m
        .setLargeRedeemThreshold(new BN(100_000))
        .accounts(A)
        .instruction(),
      [admin],
    );
    await send(
      await m.setRedeemQueueDelay(0).accounts(A).instruction(),
      [admin],
    );
  } else if (cmd === "roundA-restore") {
    await send(
      await m
        .setMaxSilvSupply(new BN(DEF_MAX_SUPPLY))
        .accounts(A)
        .instruction(),
      [admin],
    );
    await send(
      await m
        .setLargeRedeemThreshold(new BN(DEF_THRESHOLD))
        .accounts(A)
        .instruction(),
      [admin],
    );
    await send(
      await m
        .setRedeemQueueDelay(DEF_QUEUE_DELAY)
        .accounts(A)
        .instruction(),
      [admin],
    );
  } else if (cmd === "redemptions-off") {
    await send(
      await m.setRedemptionsEnabled(false).accounts(A).instruction(),
      [admin],
    );
  } else if (cmd === "redemptions-on") {
    await send(
      await m.setRedemptionsEnabled(true).accounts(A).instruction(),
      [admin],
    );
  } else if (cmd === "pause") {
    await send(
      await m
        .pause()
        .accounts({
          config: CFG,
          signer: admin.publicKey,
          guardian: PID, // Anchor None sentinel for the optional guardian
        })
        .instruction(),
      [admin],
    );
  } else if (cmd === "unpause") {
    await send(
      await m
        .unpause()
        .accounts({ config: CFG, admin: admin.publicKey })
        .instruction(),
      [admin],
    );
  } else if (cmd === "restore-all") {
    await send(
      await m
        .setMaxSilvSupply(new BN(DEF_MAX_SUPPLY))
        .accounts(A)
        .instruction(),
      [admin],
    );
    await send(
      await m
        .setLargeRedeemThreshold(new BN(DEF_THRESHOLD))
        .accounts(A)
        .instruction(),
      [admin],
    );
    await send(
      await m
        .setRedeemQueueDelay(DEF_QUEUE_DELAY)
        .accounts(A)
        .instruction(),
      [admin],
    );
    const c = await cfg();
    if (!c.redemptionsEnabled)
      await send(
        await m.setRedemptionsEnabled(true).accounts(A).instruction(),
        [admin],
      );
    if (c.paused)
      await send(
        await m
          .unpause()
          .accounts({ config: CFG, admin: admin.publicKey })
          .instruction(),
        [admin],
      );
  } else {
    console.error("unknown cmd:", cmd);
    process.exit(1);
  }

  await printState("AFTER " + cmd);
  console.log("OK");
}

main().catch((e) => {
  console.error("FATAL", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
