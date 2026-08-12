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

const KNOWN_FLAGS = new Set(["--oz", "--atomic", "--dry-run", "--resume", "--again"]);
/** How recently an identical completed plan counts as a double-submit rather than a new decision. */
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

export type ParsedArgs = {
  tranches: bigint[];
  dryRun: boolean;
  resume: boolean;
  again: boolean;
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
  let again = false;
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
    if (flag === "--again") {
      again = true;
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
  // A resume mints what the RECORD says, so tranches typed alongside it are silently discarded and
  // the operator believes they controlled the amount. Refuse rather than ignore.
  if (resume && tranches.length > 0) {
    throw new Error(
      "--resume mints the tranches recorded in the run file, so --oz/--atomic alongside it would be " +
        "IGNORED. Pass --resume alone, or delete the record and start a fresh plan.",
    );
  }
  return { tranches, dryRun, resume, again };
}

export type RunRecord = {
  cluster: string;
  program: string;
  admin: string;
  silvMint: string;
  inventoryWallet: string;
  plan: string[];
  landed: { index: number; atomic: string; sig: string }[];
  /**
   * THE CRASH WINDOW. Writing the record only AFTER `.rpc()` returns leaves a gap: kill the process
   * in between (SIGKILL, a closed laptop, a dropped connection after the transaction was already
   * accepted) and the record UNDERCOUNTS. `--resume` would then re-send a tranche that landed, which
   * is the exact double-mint the record exists to prevent, just moved.
   *
   * So the intent is written BEFORE the send, with the inventory ATA balance measured at that moment,
   * and cleared after. A resume that finds this present reconciles against the chain.
   */
  inFlight?: { index: number; atomic: string; ataBefore: string };
};

/**
 * Did the in-flight tranche land? Decided on the inventory ATA balance, NOT on the supply: supply
 * moves for other reasons once public mint is open, the ATA is credited only by premint.
 *
 * The two exact matches are unambiguous. ANYTHING ELSE REFUSES, because the balance can also move by
 * an inbound SILV transfer or a permanent-delegate action, and guessing wrong here either
 * double-mints or silently skips a tranche.
 */
export function reconcileInFlight(
  inFlight: { atomic: string; ataBefore: string },
  ataNow: bigint,
): { kind: "landed" | "not-landed" | "ambiguous"; message: string } {
  const before = BigInt(inFlight.ataBefore);
  const amt = BigInt(inFlight.atomic);
  if (ataNow === before + amt) {
    return { kind: "landed", message: `the in-flight tranche ${amt} LANDED (ATA ${before} -> ${ataNow})` };
  }
  if (ataNow === before) {
    return { kind: "not-landed", message: `the in-flight tranche ${amt} did NOT land (ATA still ${before})` };
  }
  return {
    kind: "ambiguous",
    message:
      `cannot tell whether the in-flight tranche of ${amt} landed.\n` +
      `  inventory ATA was ${before} before the send, and is ${ataNow} now.\n` +
      `  Expected ${before + amt} if it landed, ${before} if it did not. Neither matches, so something\n` +
      `  else moved this account (an inbound transfer, or the permanent delegate).\n` +
      `  Find the transaction by hand, then edit ${STATE_PATH}: move the tranche into "landed" if it\n` +
      `  landed, or delete "inFlight" if it did not. REFUSING to guess: one way double-mints.`,
  };
}

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
  const raw = fs.readFileSync(STATE_PATH, "utf8");
  try {
    return JSON.parse(raw) as RunRecord;
  } catch {
    // A bare `Unexpected end of JSON input` names nothing. The operator is standing at the step with
    // no undo, holding the only file that says what landed.
    throw new Error(
      `the run record at ${STATE_PATH} is not valid JSON (${raw.length} bytes). It was probably\n` +
        `truncated by a kill mid-write. Read it, compare it to the chain's inventory ATA balance, and\n` +
        `either repair it by hand or delete it once you know what landed. Do NOT just re-run.`,
    );
  }
}

/**
 * ATOMIC. The plain writeFileSync it replaces was called twice per tranche, both times INSIDE the
 * crash window it exists to close, so a kill during either left a truncated file and the next run
 * died on a parse error instead of resuming.
 */
function writeRecord(r: RunRecord): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

/** Completed runs are ARCHIVED, never deleted. See archiveRecord's caller for why. */
function doneRecords(): { file: string; record: RunRecord; mtimeMs: number }[] {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^premint-.*\.done\.json$/.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      try {
        return {
          file: full,
          record: JSON.parse(fs.readFileSync(full, "utf8")) as RunRecord,
          mtimeMs: fs.statSync(full).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; record: RunRecord; mtimeMs: number } => x !== null);
}

/**
 * THE UP-ARROW GUARD, and the reason the record is archived rather than removed.
 *
 * Review-of-fixes finding. Deleting the record on success restored the exact reflex the run record
 * was added to stop: a completed run leaves nothing behind, so up-arrow-enter mints the same plan a
 * second time, unrefused. The cap catches a duplicated 106,115 oz plan and does NOT catch a
 * duplicated ~1,750 oz operational tranche, which is the size D11 mandates.
 *
 * It cannot refuse unconditionally: D11 makes repeated premints legitimate, "re-run admin_premint
 * later when there is a new use". So it refuses only an IDENTICAL plan seen recently, which is what
 * a double-submit looks like and what a deliberate second tranche does not.
 */
export function decideDuplicate(
  plan: bigint[],
  archives: { file: string; record: RunRecord; mtimeMs: number }[],
  nowMs: number,
  windowMs: number,
): { refuse: boolean; message: string } {
  const wanted = plan.map((t) => t.toString()).join(",");
  for (const a of archives) {
    if (nowMs - a.mtimeMs > windowMs) continue;
    if (a.record.plan.join(",") !== wanted) continue;
    const mins = Math.round((nowMs - a.mtimeMs) / 60000);
    return {
      refuse: true,
      message:
        `this EXACT plan (${wanted}) completed ${mins} minute(s) ago: ${a.file}\n` +
        `Re-running it now mints it AGAIN, and the cap does not catch that for an operational-size\n` +
        `tranche. If this is a deliberate second pre-mint, pass --again.`,
    };
  }
  return { refuse: false, message: "" };
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
  const { tranches, dryRun, resume, again } = parseArgs(process.argv.slice(2));
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
  //
  // MOVED BEHIND `dryRun` ON 2026-08-12, and that is the whole point. The refusal was unconditional and
  // sat 107 lines ABOVE the `if (dryRun) return`, so `--dry-run` threw too. On the mainnet shape that
  // made this script completely unusable, and with it every guardrail it carries: the cap-and-headroom
  // refusal below, the manifest destination cross-check, the ounce/atomic conversion and the plan
  // printout. The replacement is the admin panel, whose pre-mint card is two free-text fields with no
  // cap check and no read-back, on the one irreversible instruction in the protocol (there is no admin
  // burn). A dry run SENDS NOTHING, so refusing it bought nothing and cost the operator the only tool
  // that computes the numbers they are about to type into that form. The refusal still stands for a
  // real run, where it is correct and load-bearing.
  if (!dryRun) {
    try {
      assertSendable(new PublicKey(cfg.admin), kp.publicKey, "premint");
    } catch (e) {
      // assertSendable's message ends with "run without --send to EMIT the instructions". That is true
      // of the ceremony steps it was written for and FALSE here: premint has no --send and no emit
      // mode, so an operator following that sentence gets "unrecognised argument --send".
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
          `  NOTE, specific to premint: this script has NO --send and NO emit mode. If config.admin is\n` +
          `  a Squads vault, the pre-mint must be built and executed through the admin panel, which is\n` +
          `  the only thing that wraps a dominion instruction in a vault transaction. See runbook step 9.\n` +
          `  RUN THIS SAME COMMAND WITH --dry-run to get the cap, the headroom and the exact atomic\n` +
          `  amount to type into that form. The dry run sends nothing and no longer refuses.`,
      );
    }
  }
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

  // ---- the crash window: settle any in-flight tranche BEFORE deciding what is left ----

  const ataAddr = getAssociatedTokenAddressSync(silvMint, inventoryWallet, true, TOKEN_2022_PROGRAM_ID);
  let existing = readRecord();
  if (existing?.inFlight && resume) {
    const bal = (await getAccount(conn, ataAddr, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const verdict = reconcileInFlight(existing.inFlight, bal);
    console.log(`  in-flight: ${verdict.message}`);
    if (verdict.kind === "ambiguous") throw new Error(verdict.message);
    if (verdict.kind === "landed") {
      // Recorded WITHOUT a signature: the process died before it could learn one. The tranche is
      // still counted, which is the only thing that keeps --resume from sending it again.
      existing.landed.push({
        index: existing.landed.length,
        atomic: existing.inFlight.atomic,
        sig: "recovered-from-chain (the run died before recording the signature)",
      });
    }
    delete existing.inFlight;
    writeRecord(existing);
  } else if (existing?.inFlight && !resume) {
    throw new Error(
      `a run record at ${STATE_PATH} has an IN-FLIGHT tranche: the process died between sending and ` +
        `recording, so whether it landed is unknown.\nRun with --resume, which reconciles it against ` +
        `the inventory ATA balance before doing anything.`,
    );
  }

  // ---- the plan, and what a pre-existing record says about it ----

  const decision = decideResume(existing, { tranches, resume }, {
    cluster: RPC,
    program: PROGRAM_ID.toBase58(),
    inventoryWallet: inventoryWallet.toBase58(),
  });
  if (decision.kind === "refuse") throw new Error(decision.message);
  if (decision.message) console.log(`  ${decision.message}`);
  const plan = decision.remaining;

  // The up-arrow guard for the SUCCESS path: a completed run leaves an archive, and an identical
  // plan repeated within the window is a double-submit until the operator says otherwise.
  if (decision.kind === "fresh" && !again) {
    const dup = decideDuplicate(plan, doneRecords(), Date.now(), DUPLICATE_WINDOW_MS);
    if (dup.refuse) throw new Error(dup.message);
  }

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

  const reread = decision.kind === "resume" ? readRecord() : null;
  if (decision.kind === "resume" && !reread) {
    // The file existed a moment ago. Something deleted or replaced it: a second premint process, or
    // the hand-edit the ambiguous verdict asks for, done while this run was already deciding.
    throw new Error(
      `the run record at ${STATE_PATH} disappeared between reading the plan and starting to send. ` +
        `Another premint process, or an edit mid-run. Re-check the chain and start again.`,
    );
  }
  const record: RunRecord = reread ?? {
    cluster: RPC,
    program: PROGRAM_ID.toBase58(),
    admin: kp.publicKey.toBase58(),
    silvMint: silvMint.toBase58(),
    inventoryWallet: inventoryWallet.toBase58(),
    plan: plan.map((t) => t.toString()),
    landed: [],
  };
  // WRITTEN BEFORE THE FIRST admin_premint. Not before the first lamport: the ATA-creation
  // transaction above already spent, and it is idempotent and cheap, which is why it sits outside.
  writeRecord(record);

  try {
    for (const [i, amt] of plan.entries()) {
      const supplyBefore = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
      const balBefore = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      // THE INTENT, WRITTEN BEFORE THE SEND. If the process dies at any point from here until the
      // signature is recorded, this is what tells the next run that a tranche may already be on chain.
      record.inFlight = { index: record.landed.length, atomic: amt.toString(), ataBefore: balBefore.toString() };
      writeRecord(record);
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
      delete record.inFlight;
      writeRecord(record);

      const supplyAfter = (await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
      const balAfter = (await getAccount(conn, invAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      // Numbered against the WHOLE recorded plan, not the remaining slice: on a resume the two
      // differ, and the operator is holding a checklist that counts from the original.
      const n = record.landed.length;
      console.log(`\n  tranche ${n}/${record.plan.length}: ${amt} (${fmtOz(amt)} oz)  tx ${sig}`);
      console.log(`    supply  ${supplyBefore} -> ${supplyAfter}`);
      console.log(`    inv ATA ${balBefore} -> ${balAfter}`);
      // ASYMMETRIC ON PURPOSE. Premint now runs AFTER the go-live unpause, with public_mint_enabled
      // true, so a stranger's mint_silv landing between these two reads legitimately makes the supply
      // delta LARGER than the tranche. Demanding equality there fails a correct tranche and sends the
      // operator into the re-run path. The ATA delta is the concurrency-safe half: public mints credit
      // the buyer and fees go to the fee vault, so nothing else touches this account.
      if (balAfter - balBefore !== amt) {
        throw new Error(
          `tranche ${n} did not credit the inventory ATA by exactly ${amt} ` +
            `(delta=${balAfter - balBefore}). STOPPING.`,
        );
      }
      // The supply delta is REPORTED, never asserted. Both directions have a legitimate cause at
      // this exact moment: public mint is open, so a stranger's mint_silv enlarges it, and
      // redemptions are open too, so a redeem_silv burn shrinks it. Asserting either way stops a
      // correct tranche and routes the operator into the resume path for nothing. The ATA check
      // above already detects wrong destination, wrong amount and wrong mint.
      const supplyDelta = supplyAfter - supplyBefore;
      if (supplyDelta !== amt) {
        console.log(
          `    note: supply moved ${supplyDelta}, not ${amt}. Expected once mint and redeem are open ` +
            `(a concurrent mint_silv enlarges it, a redeem_silv burn shrinks it). The inventory ATA ` +
            `delta is the check that binds, and it passed.`,
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
    if (record.inFlight) {
      console.error(
        `  One tranche was IN FLIGHT when this stopped, so whether it landed is unknown. --resume\n` +
          `  reconciles it against the inventory ATA balance before sending anything.`,
      );
    }
    console.error(`  Check the chain, then finish with:  npx tsx scripts/premint.ts --resume`);
    throw e;
  }

  // ARCHIVED, NOT DELETED. Deleting it restored the up-arrow-enter double-mint on the success path,
  // which is the common path: a completed run left nothing behind to refuse against.
  const archive = path.join(
    path.dirname(STATE_PATH),
    `premint-${new Date().toISOString().replace(/[:.]/g, "-")}.done.json`,
  );
  fs.renameSync(STATE_PATH, archive);
  console.log(`\n  run archived: ${archive}`);
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
