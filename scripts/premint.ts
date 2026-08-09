/**
 * admin_premint against a LIVE cluster, in tranches, with a run record and a read-back after every
 * tranche.
 *
 * WHY IT EXISTS. Runbook step 9 says to run `admin_premint(<atomic>)` and, until this file, NOTHING
 * in the repo sent it. The only two senders were scripts/e2e-fixa-devnet.ts, a test pinned at
 * 1000 oz, and the admin panel. So the one ceremony step that mints the entire launch supply was the
 * step with no tooling, three days before mainnet. Found during the devnet rehearsal of 2026-08-10.
 *
 * WHY TRANCHES ARE THE INTERFACE, and not a single amount. D11 (2026-08-09) makes
 * pre-mint-the-operational-tranche-only a RULE: the inventory wallet is a single-signer key and, with
 * redemptions open at launch, whoever holds it can call redeem_silv directly with no timelock. The
 * bound is the rolling window and the REAL bound is ~2x the budget over one window. So the shape of
 * this script is the shape of the decision: a list, re-runnable, never one irreversible number.
 *
 * WHY THERE IS A RUN RECORD. Review pass on 818ba73, P0. Every abort path in the first version fired
 * AFTER a mint had landed, printed a stack trace, and named no remedy; the documented recovery was to
 * re-run the same command. The cap catches a re-run of a 106,115 oz plan. It does NOT catch a re-run
 * of D11's ~1,750 oz operational tranche against ~34,300 oz of headroom: that silently double-mints
 * into a hot single-signer wallet with redemptions open. So the plan is written down BEFORE the first
 * lamport, each landed tranche is recorded as it confirms, and a second run refuses to start while a
 * record exists unless it is told `--resume`.
 *
 *   npx tsx scripts/premint.ts --oz 1000                        # one tranche, ounces
 *   npx tsx scripts/premint.ts --atomic 106115340615            # one tranche, atomic (6dp)
 *   npx tsx scripts/premint.ts --atomic 1000000 --atomic 500000 # two
 *   npx tsx scripts/premint.ts --oz 1000 --dry-run              # resolve and print, send nothing
 *   npx tsx scripts/premint.ts --resume                         # finish an interrupted plan
 *
 * Size the tranches with scripts/premint-sizing.ts AT CEREMONY TIME: the budget is in dollars and the
 * cap is in ounces, so a fall in the silver price raises the ounces a fixed budget buys.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { assertReversible, intentFromEnv, requireSanctionedCluster } from "./_guard";
import { assertSendable } from "./_ceremony-emit";

const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";
const ROOT = path.join(__dirname, "..");
const STATE_PATH = path.join(ROOT, "ceremony-out", "premint-state.json");

/** 6 decimals, fixed at mint creation and not negotiable. An off-by-1e6 here is a 1,000,000x error. */
const DECIMALS = 6n;

const KNOWN_FLAGS = new Set(["--oz", "--atomic", "--dry-run", "--resume"]);

export type ParsedArgs = {
  tranches: bigint[];
  dryRun: boolean;
  resume: boolean;
};

/**
 * Tranches from argv, in order, as atomic amounts.
 *
 * EXPORTED AND STRICT because it converts operator keystrokes into the number this file calls a
 * 1,000,000x error if wrong, and because of the review finding that made strictness mandatory:
 * `--dry-runn` used to parse as an unknown token, be ignored, and PERFORM THE LIVE MINT. The runbook
 * shows the rehearsal and the irreversible send as two lines differing by exactly that token. So an
 * argv element that is neither a known flag nor a value consumed by one is now a hard error.
 *
 * scripts/test-premint-args.ts exercises this without a cluster.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const tranches: bigint[] = [];
  let dryRun = false;
  let resume = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--resume") {
      resume = true;
      continue;
    }
    if (flag !== "--oz" && flag !== "--atomic") {
      throw new Error(
        `unrecognised argument ${JSON.stringify(flag)}. Known: ${[...KNOWN_FLAGS].join(", ")}. ` +
          `Refusing rather than ignoring it: a mistyped --dry-run would otherwise MINT.`,
      );
    }
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`${flag} needs a value`);
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      throw new Error(`${flag} value must be a positive number, got ${JSON.stringify(raw)}`);
    }
    i++; // consume the value
    let atomic: bigint;
    if (flag === "--atomic") {
      if (raw.includes(".")) throw new Error(`--atomic must be an integer, got ${raw}`);
      atomic = BigInt(raw);
    } else {
      const [whole, frac = ""] = raw.split(".");
      // Trailing zeros are fine: 1.0000000 is exactly 1 oz. Only SIGNIFICANT digits beyond 6dp are
      // unrepresentable, and silently truncating them is the class of bug this file guards against.
      const trimmed = frac.replace(/0+$/, "");
      if (trimmed.length > Number(DECIMALS)) {
        throw new Error(
          `--oz has at most ${DECIMALS} significant decimal places (SILV is ${DECIMALS}dp), got ${raw}`,
        );
      }
      atomic = BigInt(whole) * 10n ** DECIMALS + BigInt(trimmed.padEnd(Number(DECIMALS), "0") || "0");
    }
    if (atomic === 0n) throw new Error(`${flag} ${raw} resolves to zero atomic units`);
    // u64 is what the instruction takes. Caught here it names the typo; caught by the cap check it
    // says "the plan exceeds the cap", which points the operator at the wrong thing.
    if (atomic > 2n ** 64n - 1n) throw new Error(`${flag} ${raw} exceeds u64`);
    tranches.push(atomic);
  }
  return { tranches, dryRun, resume };
}

export type RunRecord = {
  cluster: string;
  program: string;
  admin: string;
  silvMint: string;
  inventoryWallet: string;
  plan: string[];
  landed: { index: number; atomic: string; sig: string }[];
};

/**
 * What a pre-existing record means for the run being started. Pure, so the decision is testable
 * without a cluster: the whole reason _run-state.ts exists as its own module.
 */
export function decideResume(
  record: RunRecord | null,
  asked: { tranches: bigint[]; resume: boolean },
  now: { cluster: string; program: string; inventoryWallet: string },
): { kind: "fresh" | "resume" | "refuse"; remaining: bigint[]; message: string } {
  if (!record) {
    if (asked.resume) {
      return { kind: "refuse", remaining: [], message: `--resume but no run record at ${STATE_PATH}` };
    }
    return { kind: "fresh", remaining: asked.tranches, message: "" };
  }
  const done = record.landed.length;
  const remaining = record.plan.slice(done).map((s) => BigInt(s));
  if (!asked.resume) {
    return {
      kind: "refuse",
      remaining,
      message:
        `a run record already exists at ${STATE_PATH}: ${done}/${record.plan.length} tranche(s) landed.\n` +
        `Re-running would MINT AGAIN. The cap does not catch this for an operational-size tranche.\n` +
        `To finish it:   npx tsx scripts/premint.ts --resume\n` +
        `To abandon it:  delete the file, after checking the chain's supply yourself.`,
    };
  }
  // A resume must be against the same chain, the same program and the same destination. Anything
  // else and the remaining tranches would land somewhere the original plan never named.
  for (const [field, was, is] of [
    ["cluster", record.cluster, now.cluster],
    ["program", record.program, now.program],
    ["inventory wallet", record.inventoryWallet, now.inventoryWallet],
  ] as const) {
    if (was !== is) {
      return {
        kind: "refuse",
        remaining,
        message: `refusing to resume: ${field} drifted since the plan was written (${was} -> ${is}).`,
      };
    }
  }
  if (remaining.length === 0) {
    return { kind: "refuse", remaining, message: "the recorded plan is already complete; delete the record." };
  }
  return {
    kind: "resume",
    remaining,
    message: `resuming: ${done}/${record.plan.length} landed, ${remaining.length} to go.`,
  };
}

function readRecord(): RunRecord | null {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as RunRecord;
}

function writeRecord(r: RunRecord): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(r, null, 2));
}

function loadAdmin(): Keypair {
  // A SET-BUT-UNREADABLE DOMINION_KEYPAIR is an error, not a reason to fall back. The old
  // `candidates.find(existsSync)` skipped a typo'd path and silently signed with the dev key, and the
  // dry-run never touched the key at all, so the rehearsal was green for a command that could not work.
  const explicit = process.env.DOMINION_KEYPAIR;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`DOMINION_KEYPAIR is set to ${explicit}, which does not exist. Refusing to fall back.`);
    }
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(explicit, "utf8"))));
  }
  const fallback = path.join(os.homedir(), ".config", "solana", "dominion-dev.json");
  if (!fs.existsSync(fallback)) throw new Error("no admin keypair found; set DOMINION_KEYPAIR");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(fallback, "utf8"))));
}

function fmtOz(atomic: bigint): string {
  // Display only. Number() is exact below 2^53 atomic units and the cap is 150,000 oz, so this never
  // loses a digit in practice, and nothing DECIDES on this value.
  const oz = Number(atomic) / Number(10n ** DECIMALS);
  return oz.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** The manifest's declared destination, or null when the file cannot answer. */
function manifestInventoryWallet(): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "mainnet-authorities.json"), "utf8"));
    return m?.authorities?.inventory_wallet?.pubkey ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const { tranches, dryRun, resume } = parseArgs(process.argv.slice(2));
  if (tranches.length === 0 && !resume) {
    throw new Error("no tranche given. Use --oz <n> or --atomic <n>, repeatable.");
  }
  await requireSanctionedCluster(RPC, "premint");
  assertReversible("admin_premint", intentFromEnv());

  const kp = loadAdmin();
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);
  // loadIdl(), not the raw import: anchor 0.31 takes the program id from `idl.address`, so a shell
  // carrying DOMINION_PROGRAM_ID (the documented t1-hostile-bootstrap usage) would derive PDAs for one
  // program and send to another. loadIdl() overwrites the address with the resolved PROGRAM_ID.
  const program = new Program(loadIdl() as Idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    PROGRAM_ID,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await (program.account as any).configAccount.fetch(configPda);
  const silvMint = new PublicKey(cfg.silvMint);
  const inventoryWallet = new PublicKey(cfg.inventoryWallet);
  const cap = BigInt(cfg.maxSilvSupply.toString());

  console.log("premint");
  console.log("  cluster  :", RPC);
  console.log("  program  :", PROGRAM_ID.toBase58());
  console.log("  admin    :", kp.publicKey.toBase58());
  console.log("  silv mint:", silvMint.toBase58());
  console.log("  inventory:", inventoryWallet.toBase58());

  // ---- refusals that must fire BEFORE the ATA-creation transaction, which costs money and rent ----

  // THE SIGNER MUST BE config.admin, and this must fail HERE rather than at the instruction.
  //
  // On mainnet config.admin is planned to be the Ops Squads vault 65g5nNX…, which is OFF-CURVE: no
  // private key exists for it, so `has_one = admin` (premint.rs) can never be satisfied by ANY
  // keypair. A direct sender is structurally the wrong tool for that ceremony, and the devnet
  // rehearsal could not reveal it because devnet's admin is a single key. assertSendable is the
  // repo's existing refusal for exactly this, and its message names the emit-then-Squads path.
  //
  // Until premint has an emit mode, this is the honest failure: it stops before the ATA-creation
  // transaction instead of dying on an opaque ConstraintHasOne after spending mainnet SOL.
  assertSendable(new PublicKey(cfg.admin), kp.publicKey, "premint");
  // `admin_premint` requires !paused (premint.rs). Discovering that from a raw Anchor code AFTER
  // paying for an ATA is exactly the confusion the 2026-08-10 rehearsal hit.
  if (cfg.paused) {
    throw new Error(
      "config.paused is true and admin_premint reverts Paused. The unpause (runbook step 8) comes FIRST; " +
        "premint is step 9. Order: fee vault -> guardians + unpause -> premint.",
    );
  }
  if (inventoryWallet.equals(PublicKey.default)) {
    throw new Error("config.inventory_wallet is the zero pubkey; premint would revert");
  }
  // Cross-check the destination against the manifest, the same way ceremony-step8.ts refuses its whole
  // step on a mismatch. `initialize` is one-shot, so if it bound the wrong destination THIS is the step
  // that funds it, and the only repair is a 24h timelock.
  const declared = manifestInventoryWallet();
  if (declared && declared !== inventoryWallet.toBase58()) {
    throw new Error(
      `config.inventory_wallet does NOT match config/mainnet-authorities.json.\n` +
        `  on chain: ${inventoryWallet.toBase58()}\n  manifest: ${declared}\n` +
        `Refusing to fund a destination nobody in this ceremony chose.`,
    );
  }
  console.log(`  manifest : ${declared ? (declared === inventoryWallet.toBase58() ? "matches" : "MISMATCH") : "unreadable"}`);

  // ---- the plan, and what a pre-existing record says about it ----

  const decision = decideResume(readRecord(), { tranches, resume }, {
    cluster: RPC,
    program: PROGRAM_ID.toBase58(),
    inventoryWallet: inventoryWallet.toBase58(),
  });
  if (decision.kind === "refuse") throw new Error(decision.message);
  if (decision.message) console.log(`  ${decision.message}`);
  const plan = decision.remaining;

  const supply0 = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const total = plan.reduce((a, b) => a + b, 0n);
  console.log(`  cap      : ${cap} (${fmtOz(cap)} oz)`);
  console.log(`  minted   : ${supply0} (${fmtOz(supply0)} oz)`);
  console.log(`  planned  : ${total} (${fmtOz(total)} oz) in ${plan.length} tranche(s)`);

  // Refuse the WHOLE plan before sending the first tranche. Discovering the cap at tranche 3 leaves
  // the supply somewhere nobody chose, and there is no un-mint.
  if (supply0 + total > cap) {
    throw new Error(
      `the plan exceeds the cap: ${supply0} minted + ${total} planned = ${supply0 + total} > ${cap}. ` +
        `max_silv_supply is TIGHTEN-ONLY, so the cap cannot be raised to fit this.`,
    );
  }
  const headroomAfter = cap - supply0 - total;
  console.log(
    `  headroom after: ${headroomAfter} (${fmtOz(headroomAfter)} oz) left for PUBLIC MINT, ` +
      `which draws on the SAME cap`,
  );
  if (headroomAfter === 0n) {
    console.log(
      "  WARNING: zero headroom. mint_silv will revert SupplyCapExceeded until something is redeemed.",
    );
  }

  if (dryRun) {
    console.log("\n  --dry-run: nothing sent.");
    return;
  }

  const invAta = getAssociatedTokenAddressSync(silvMint, inventoryWallet, true, TOKEN_2022_PROGRAM_ID);
  // The 8th positional is allowOwnerOffCurve and it DEFAULTS TO FALSE. Passing it matters the first
  // time D11's own rule is honoured ("the reserve goes to a Squads vault"), because a vault is a PDA
  // and the helper would throw TokenOwnerOffCurveError before building anything.
  await createAssociatedTokenAccountIdempotent(
    conn,
    kp,
    silvMint,
    inventoryWallet,
    {},
    TOKEN_2022_PROGRAM_ID,
    undefined,
    true,
  );
  console.log("  inv ATA  :", invAta.toBase58());

  const record: RunRecord =
    decision.kind === "resume"
      ? (readRecord() as RunRecord)
      : {
          cluster: RPC,
          program: PROGRAM_ID.toBase58(),
          admin: kp.publicKey.toBase58(),
          silvMint: silvMint.toBase58(),
          inventoryWallet: inventoryWallet.toBase58(),
          plan: plan.map((t) => t.toString()),
          landed: [],
        };
  // WRITTEN BEFORE THE FIRST SEND. A record created after the fact cannot describe the failure that
  // stopped it from being created.
  writeRecord(record);

  try {
    for (const [i, amt] of plan.entries()) {
      const supplyBefore = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
      const balBefore = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const sig = await program.methods
        .adminPremint(new BN(amt.toString()))
        .accounts({
          config: configPda,
          admin: kp.publicKey,
          silvMint: silvMint,
          inventorySilvAta: invAta,
          silvMintAuthority: mintAuthPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      record.landed.push({ index: record.landed.length, atomic: amt.toString(), sig });
      writeRecord(record);

      const supplyAfter = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
      const balAfter = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      console.log(`\n  tranche ${i + 1}/${plan.length}: ${amt} (${fmtOz(amt)} oz)  tx ${sig}`);
      console.log(`    supply  ${supplyBefore} -> ${supplyAfter}`);
      console.log(`    inv ATA ${balBefore} -> ${balAfter}`);
      // ASYMMETRIC ON PURPOSE. Premint now runs AFTER the go-live unpause, with public_mint_enabled
      // true, so a stranger's mint_silv landing between these two reads legitimately makes the supply
      // delta LARGER than the tranche. Demanding equality there fails a correct tranche and sends the
      // operator into the re-run path. The ATA delta is the concurrency-safe half: public mints credit
      // the buyer and fees go to the fee vault, so nothing else touches this account.
      if (balAfter - balBefore !== amt) {
        throw new Error(
          `tranche ${i + 1} did not credit the inventory ATA by exactly ${amt} ` +
            `(delta=${balAfter - balBefore}). STOPPING.`,
        );
      }
      if (supplyAfter - supplyBefore < amt) {
        throw new Error(
          `tranche ${i + 1} moved supply by ${supplyAfter - supplyBefore}, less than the ${amt} minted. ` +
            `A burn or a stale read; either way STOPPING.`,
        );
      }
      if (supplyAfter - supplyBefore > amt) {
        console.log(
          `    note: supply moved ${supplyAfter - supplyBefore}, more than this tranche. Concurrent ` +
            `mint_silv activity, which is expected once public mint is open.`,
        );
      }
      console.log("    OK: the inventory ATA moved by exactly the tranche");
    }
  } catch (e) {
    const done = record.landed.length;
    const left = record.plan.slice(done);
    console.error(`\n  STOPPED after ${done}/${record.plan.length} tranche(s).`);
    console.error(`  Landed: ${record.landed.map((l) => l.atomic).join(", ") || "none"}`);
    console.error(`  NOT sent: ${left.join(", ") || "none"}`);
    console.error(`  The run record is KEPT at ${STATE_PATH}.`);
    console.error(`  Check the chain, then finish with:  npx tsx scripts/premint.ts --resume`);
    throw e;
  }

  fs.rmSync(STATE_PATH, { force: true });
  const finalSupply = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  console.log(`\n  final supply : ${finalSupply} (${fmtOz(finalSupply)} oz)`);
  console.log(`  headroom left: ${cap - finalSupply} (${fmtOz(cap - finalSupply)} oz)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
