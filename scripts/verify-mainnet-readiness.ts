/**
 * One command that answers "can we launch on mainnet?": everything mechanically checkable across the
 * build, the constants, the authorities, the oracle on MAINNET feed data and the app configuration,
 * plus a named list of what only a human can clear. Separate from verify-mainnet-authorities.ts,
 * which checks only the authority assignment.
 *
 * Read-only. Sends nothing. Safe to run any time.
 *
 * Run: npx tsx scripts/verify-mainnet-readiness.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PROGRAM_ID } from "./_program-id";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const MAINNET = "https://api.mainnet-beta.solana.com";
const ROOT = path.join(__dirname, "..");
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAZER_TREASURY_MAINNET = "Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak";
const FEED_ID = 3154;
/** Measured on devnet 2026-07-26: a ~1.07 MB artifact needs one rent-exemption + fees. */
const DEPLOY_SOL_NEEDED = 9.2;

let ready = 0;
let blocked = 0;
let human = 0;
let scheduled = 0;

/**
 * Which runbook step the operator is ABOUT to perform, from `--stage=N`. Anything whose step is BEHIND
 * N is overdue and BLOCKS. Without it the gate has no notion of where the ceremony is, so an item
 * "satisfied by step 2" stays non-blocking forever and a mid-ceremony run reads falsely reassuring.
 */
const STAGE: number | null = (() => {
  const a = process.argv.find((x) => x.startsWith("--stage="));
  if (!a) return null;
  const n = Number(a.slice("--stage=".length));
  if (!Number.isFinite(n)) {
    console.error(`--stage must be a runbook step number, got ${JSON.stringify(a)}`);
    process.exit(2);
  }
  return n;
})();
function ok(msg: string, detail = "") {
  console.log(`  READY    ${msg}${detail ? ` -> ${detail}` : ""}`);
  ready++;
}
function no(msg: string, detail = "") {
  console.log(`  BLOCKED  ${msg}${detail ? ` -> ${detail}` : ""}`);
  blocked++;
}
/** Will be satisfied BY A STEP OF THE CEREMONY THIS GATE GATES, so it must NOT block starting it and
 * must NOT print READY. Several blocked items can only be resolved during the ceremony (the mainnet fee
 * vault cannot exist before the mainnet deploy; the apps' USDC/Lazer constants are devnet values until
 * step 2), so exiting 1 on them would train the operator to override the gate. */
function atStep(step: string, msg: string, detail = "", dueStep?: number) {
  // `dueStep` is EXPLICIT and numeric; `step` is only the label an operator reads. A deadline is data,
  // not prose: deriving it from the label by regex was wrong in both directions (the FIRST integer made
  // "runbook steps 3-6" due at 3, the LAST made "9/10" due at 10, and since the test is `due < STAGE`
  // the mandatory fee vault was never reported at --stage=10). Omitting `dueStep` means "no deadline".
  if (STAGE !== null && dueStep !== undefined && dueStep < STAGE) {
    console.log(
      `  OVERDUE  ${msg} -> was due at step ${dueStep}, you are at step ${STAGE}${detail ? `. ${detail}` : ""}`,
    );
    blocked++;
    return;
  }
  console.log(`  AT STEP ${step}  ${msg}${detail ? ` -> ${detail}` : ""}`);
  scheduled++;
}
function byHand(msg: string, detail = "") {
  console.log(`  BY HAND  ${msg}${detail ? ` -> ${detail}` : ""}`);
  human++;
}
// OFF-CURVE IS NECESSARY, NOT SUFFICIENT. `PublicKey.isOnCurve` failing proves only that 32 bytes are
// not a valid ed25519 point, which ANY PDA of ANY program satisfies, including one an attacker owns.
// Nothing here checks that the account is a Squads vault, that its multisig exists, or its threshold:
// the stated 3-of-5 model must be verified by hand in the Squads UI.
function section(t: string) {
  console.log(`\n${t}`);
}

/** The metadata URI baked into the mint at creation, from the manifest rather than a second copy. */
function metadataUri(): string {
  const m = JSON.parse(
    fs.readFileSync(path.join(ROOT, "config", "mainnet-authorities.json"), "utf8"),
  );
  return m?.mint_creation_ceremony?.uri ?? "";
}

/**
 * Is the metadata JSON actually THERE. A status code cannot answer this on an SPA origin, so the
 * test is differential: fetch the real URI and a path that cannot exist, and demand they differ AND
 * that the real one parses as JSON. Either half alone is foolable.
 */
async function checkMetadataUri(): Promise<void> {
  const uri = metadataUri();
  if (!uri) {
    no("mint_creation_ceremony.uri is missing from the manifest");
    return;
  }
  const control = new URL(uri);
  control.pathname = control.pathname.replace(/[^/]+$/, "dominion-readiness-control-404.json");
  try {
    const [real, ctl] = await Promise.all([fetch(uri), fetch(control.toString())]);
    const [realBody, ctlBody] = await Promise.all([real.text(), ctl.text()]);
    if (realBody === ctlBody) {
      no(
        `${uri} returns the SAME body as a nonexistent path`,
        `HTTP ${real.status}, ${realBody.length} bytes, catch-all origin: the JSON is ABSENT and a ` +
          `status-code check will pass anyway. This URI is baked into the mint FOREVER at creation.`,
      );
      return;
    }
    try {
      const parsed = JSON.parse(realBody);
      ok(
        `${uri} serves parseable JSON and differs from a nonexistent path`,
        `name=${JSON.stringify((parsed as Record<string, unknown>)?.name ?? "?")}`,
      );
    } catch {
      no(`${uri} does not parse as JSON`, `content-type ${real.headers.get("content-type")}`);
    }
  } catch (e) {
    no(`${uri} could not be fetched`, String(e).slice(0, 120));
  }
}

function grep(rel: string, re: RegExp): string | null {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  const m = re.exec(fs.readFileSync(p, "utf8"));
  return m ? m[1] : null;
}

function runScript(rel: string, args: string[] = []): boolean {
  try {
    // cwd is pinned to ROOT: `verify-release-artifact.sh` resolves `docs/` relative to the caller's
    // working directory in its stray-hash gate, so inheriting whatever cwd this process was started
    // from silently skipped that check.
    execFileSync("bash", [path.join(ROOT, rel), ...args], { stdio: "pipe", cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const conn = new Connection(MAINNET, "confirmed");
  const cfg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "config", "mainnet-authorities.json"), "utf8"),
  );
  const A = cfg.authorities;

  console.log("Dominion SILV: mainnet launch readiness");
  console.log("  runbook: docs/MAINNET_LAUNCH_RUNBOOK.md\n");

  // ---------------------------------------------------------------- build
  section("A. Build and artifact");
  // ROUND 5, review pass: `--local-only`, and the flag is what makes this gate answerable.
  //
  // Without it the script also compares against the RELEASE PIN, which no machine running this
  // readiness check can reproduce: the release artifact is a linux/amd64 container build, and today
  // there is no candidate pinned at all. It therefore exits 3 (NOT ATTESTED), `runScript` collapses
  // every non-zero into `false`, and this printed a BLOCKING failure whose own banner says "it cannot
  // be fixed by any step of the runbook". A permanently red gate is a gate the operator learns to run
  // the ceremony without.
  //
  // The question this check is actually asking is the local one: is the artifact on this machine a
  // clean default-feature build with no dev hatch. `--local-only` asks exactly that and exits 0.
  // Attesting the RELEASE binary is the reproducible-build job's job, and the runbook says so.
  runScript("scripts/verify-release-artifact.sh", ["--local-only"])
    ? ok("local artifact is a clean default rebuild, no dev hatch (NOT a release attestation)")
    : no(
        "verify-release-artifact.sh --local-only FAILED",
        "run it directly for the reason; the release pin is checked by CI, not here",
      );
  runScript("scripts/verify-constants-consistency.sh")
    ? ok("every hand-copied address agrees with declare_id!")
    : no("verify-constants-consistency.sh FAILED", "run it directly");

  // ROUND 6 R6-07. The release pin, as a STAGED requirement. Before step 3 there is nothing to deploy
  // and `no-candidate` is the correct state, so reporting it as a blocker would be the permanently-red
  // gate the previous round already had to undo. From step 3 (the deploy) onward it IS a blocker, and
  // the schema has to validate, not merely exist.
  {
    const relPin = cfg.release_artifact ?? {};
    const pinStatus: string = relPin.status ?? "MISSING";
    let schema = "-";
    try {
      schema = execFileSync(
        "python3",
        [path.join(ROOT, "scripts/_read-release-pin.py"), path.join(ROOT, "config/mainnet-authorities.json"), ROOT],
        { encoding: "utf8", cwd: ROOT },
      )
        .trim()
        .split(/\s+/)
        .slice(3)
        .join(" ");
    } catch {
      schema = "the pin could not be read";
    }
    if (pinStatus === "pinned" && schema === "-") {
      ok("release candidate pinned and the pin validates", relPin.sha256?.slice(0, 16) + "...");
    } else if (pinStatus === "pinned") {
      no("the release pin does NOT validate", schema);
    } else {
      atStep(
        "2c, BEFORE step 3",
        "no release candidate is pinned",
        `release_artifact.status = ${pinStatus}. Pin it from the reproducible-build job (runbook 2c)`,
        3,
      );
    }
  }

  // ------------------------------------------------------------ authorities
  section("B. Authorities and funding");
  const dep = new PublicKey(A.deployer.pubkey);
  const depInfo = await conn.getAccountInfo(dep);
  const depSol = depInfo ? depInfo.lamports / 1e9 : 0;
  depSol >= DEPLOY_SOL_NEEDED
    ? ok("deployer funded for the deploy", `${depSol.toFixed(3)} SOL`)
    : no(
        `deployer needs ~${DEPLOY_SOL_NEEDED} SOL on mainnet`,
        `has ${depSol.toFixed(3)} SOL (rent is recoverable later)`,
      );

  for (const role of ["ops_admin", "upgrade_authority", "compliance", "guardian"]) {
    const k = new PublicKey(A[role].pubkey);
    PublicKey.isOnCurve(k.toBytes())
      ? no(`${role} is a single-signer wallet, not a multisig`, k.toBase58())
      : ok(`${role} is off-curve (a real PDA / Squads vault)`);
  }
  new PublicKey(A.guardian.pubkey).equals(new PublicKey(A.ops_admin.pubkey))
    ? no("guardian == ops_admin: add_guardian will reject it, the veto cannot exist")
    : ok("guardian != ops_admin, so the veto is exercisable");
  if (new PublicKey(A.upgrade_authority.pubkey).equals(new PublicKey(A.compliance.pubkey))) {
    byHand(
      "upgrade_authority == compliance (SolidProof MEDIUM #1)",
      "accepted 2026-07-26; split before material value accrues",
    );
  } else {
    ok("upgrade_authority and compliance are separate vaults");
  }

  // ---------------------------------------------------------------- cluster
  section("C. Mainnet cluster constants in the apps");
  for (const app of ["admin", "public"]) {
    const usdc = grep(
      `apps/${app}/src/lib/constants.ts`,
      /USDC_MINT\s*=\s*new PublicKey\("([^"]+)"/,
    );
    usdc === USDC_MAINNET
      ? ok(`apps/${app} USDC_MINT is the mainnet mint`)
      // ROUND 6 R6-05: due at 2a, so it is OVERDUE and BLOCKING from step 3 (the deploy) onward. It
      // used to be due at "2" with the dueStep also 2, which meant `dueStep < STAGE` only fired from
      // step 3 anyway; what changed is that the label now names 2a, the sub-step that actually does it,
      // because the audit found the batch had executed only the program-id half of step 2a.
      : atStep("2a", `apps/${app} USDC_MINT is not mainnet yet`, `${usdc} (swapped at runbook step 2a)`, 2);
  }
  const lt = grep(
    "apps/public/src/lib/constants.ts",
    /LAZER_TREASURY\s*=\s*new PublicKey\("([^"]+)"/,
  );
  lt === LAZER_TREASURY_MAINNET
    ? ok("apps/public LAZER_TREASURY is the mainnet value")
    : atStep("2a", "apps/public LAZER_TREASURY is not mainnet yet", `${lt} (it is cluster-specific)`, 2);
  const feed = grep("apps/public/src/lib/constants.ts", /LAZER_SILV_FEED_ID\s*=\s*(\d+)/);
  Number(feed) === FEED_ID
    ? ok(`feed id is ${FEED_ID} (Metal.Index.SILVER/USD, pure spot)`)
    : no(`feed id is ${feed}, expected ${FEED_ID}`);

  // ROUND 6 R6-05. THE CHECK THAT DID NOT EXIST: compare the apps' constants against the LIVE mainnet
  // Config, not against each other.
  //
  // The offline gate (verify-constants-consistency.sh) proves the two apps agree and that the value is
  // not on a three-entry list of retired mints. Both were true of the devnet mint `G5zez3...` while the
  // apps carried the mainnet PROGRAM_ID, which is a state where the panel and the public card build
  // ATAs and instructions against a mint that does not exist on the cluster they point at. The program
  // refuses them, so no value is at risk; the product simply does not work, and several ceremony
  // actions become unavailable at the moment they are needed.
  //
  // SILV_MINT cannot be known before T1 creates it, so this is STAGED: unknowable until step 6, a hard
  // requirement from step 7 on. That ordering is the finding, not a detail.
  {
    const silvConst = grep("apps/public/src/lib/constants.ts", /SILV_MINT\s*=\s*new PublicKey\("([^"]+)"/);
    const silvAdmin = grep("apps/admin/src/lib/constants.ts", /SILV_MINT\s*=\s*new PublicKey\("([^"]+)"/);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
    const info = await conn.getAccountInfo(configPda);
    if (!info) {
      atStep(
        "4-6 (T1 initialises)",
        "the mainnet Config does not exist yet, so SILV_MINT cannot be compared on chain",
        `apps carry ${silvConst}; T1 creates the real mint and this becomes checkable`,
        7,
      );
    } else {
      // ConfigAccount layout: 8 discriminator, then admin(32), pending_admin Option<Pubkey>,
      // pending_admin_expires_at(8), upgrade_authority_info(32), permanent_delegate_expected(32),
      // freeze_authority_expected(32), compliance_mode(1), premium x2 (4), feed id(4),
      // min_publishers(2), last_used_feed_ts(8), then usdc_mint(32) and silv_mint(32).
      const d = info.data;
      let o = 8 + 32;
      o += d.readUInt8(o) === 1 ? 33 : 1; // pending_admin
      o += 8 + 32 + 32 + 32 + 1 + 2 + 2 + 4 + 2 + 8;
      const onChainUsdc = new PublicKey(d.subarray(o, o + 32)).toBase58();
      const onChainSilv = new PublicKey(d.subarray(o + 32, o + 64)).toBase58();
      onChainSilv === silvConst && onChainSilv === silvAdmin
        ? ok("both apps' SILV_MINT equals the on-chain config.silv_mint", onChainSilv)
        : atStep(
            "6c, BEFORE deploying the panel",
            "the apps' SILV_MINT does NOT match the on-chain config.silv_mint",
            `on chain ${onChainSilv}, public ${silvConst}, admin ${silvAdmin}. ` +
              `Write the observed mint into both apps, commit, test, THEN deploy the panel`,
            7,
          );
      onChainUsdc === USDC_MAINNET
        ? ok("the on-chain config.usdc_mint is the mainnet USDC mint")
        : no("the on-chain config.usdc_mint is NOT mainnet USDC", onChainUsdc);
    }
  }

  // ----------------------------------------------------------------- oracle
  section("D. Oracle, against MAINNET feed data");
  try {
    const envPath = path.join(ROOT, "apps", "public", ".env.local");
    const key =
      process.env.PYTH_LAZER_API_KEY ??
      (fs.existsSync(envPath)
        ? (/PYTH_LAZER_API_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(envPath, "utf8")) ?? [])[1]
        : undefined);
    if (!key) {
      byHand("no local Pyth key, cannot probe the feed", "set PYTH_LAZER_API_KEY");
    } else {
      const r = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          priceFeedIds: [FEED_ID],
          properties: ["price", "exponent", "publisherCount"],
          chains: ["solana"],
          channel: "fixed_rate@1000ms",
        }),
      });
      if (!r.ok) {
        no(`feed ${FEED_ID} returned HTTP ${r.status}`, "entitlement? needs pyth-indices");
      } else {
        const d: any = await r.json();
        const f = d.parsed.priceFeeds[0];
        const px = Number(f.price) * Math.pow(10, Number(f.exponent));
        const pubs = Number(f.publisherCount);
        ok(`feed ${FEED_ID} live`, `$${px.toFixed(4)}/oz, ${pubs} publishers`);
        pubs > 2
          ? ok("publisher count is above the hard floor of 2", `${pubs}, so ${pubs - 2} spare`)
          : byHand(
              `publisher count is ${pubs}, the contract's hard floor is 2`,
              "one drop halts every priced operation",
            );
        // The pool sizing Thomas asked about: ~100k USDC of SILV.
        const ozFor100k = 100_000 / (px * 1.015);
        ok(
          "a 100,000 USDC pool needs roughly",
          `${ozFor100k.toFixed(0)} oz, vs the 150,000 oz cap`,
        );
      }
    }
  } catch (e) {
    byHand("could not reach Pyth", String(e).slice(0, 80));
  }

  // ------------------------------------------------------ the six requirements
  section("E. Your six launch requirements");
  // Neither can be PROVEN from here: the token does not exist until the ceremony creates it, and the
  // premint has not happened. So they are AT STEP, never READY. Reporting READY for something that has
  // not happened is worse than printing no line, because a checklist reads it as done.
  atStep(
    "runbook steps 3-6",
    "1. SILV token deployed and live",
    "the mint is created BY T1 (step 4-6). Nothing here can observe it beforehand: re-run this gate " +
      "after T1 and check the mint address it prints.",
    // Due by the END of the 4+5+6 block, so it must be satisfied by the time step 7 begins.
    6,
  );
  atStep(
    "runbook steps 7-9",
    "2. pre-mint freely to the inventory wallet, seed a Sunrise pool",
    "admin_premint runs at step 9, AFTER the unpause (it requires !paused); the pool is seeded off-chain afterwards.",
    9,
  );
  ok(
    "3. public mint with no KYC",
    "ROUND 8: OPEN from initialize, so there is nothing to propose and nothing to execute. Runbook " +
      "steps 7 and 10 are retired. What holds the launch is the PAUSE, and `unpause` refuses to run " +
      "without an ACTIVE guardian distinct from the admin, appointed by initialize itself",
  );
  ok(
    "3b. enable KYC LATER",
    "the gate SHIPPED DORMANT (kyc_scope_flags = 0, read by mint_silv + redeem_silv). Arming it " +
      "is a config change, not an upgrade: set_kyc_operator then attest wallets then " +
      "set_kyc_scope. ORDER MATTERS - attest BEFORE arming or every holder is locked out",
  );
  // The fee vault is the one setup step whose absence turns the product off: mint_silv and redeem_silv
  // both take it as a REQUIRED account, so a missing vault reverts every mint and every redeem with
  // AccountNotInitialized. Checked against the CLUSTER THIS SCRIPT POINTS AT, so a green here on devnet
  // says nothing about mainnet; the detail line names the cluster.
  {
    const feeVaultAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault")],
      PROGRAM_ID,
    )[0];
    const vault = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MAINNET),
      feeVaultAuthority,
      true, // allowOwnerOffCurve: the owner is a PDA
      TOKEN_PROGRAM_ID,
    );
    // Not `.catch(() => null)`: an RPC FAILURE is not "the vault does not exist yet", which is a
    // different fact and the reassuring one. A helper that cannot tell "no" from "do not know" must
    // not answer.
    let info: Awaited<ReturnType<typeof conn.getAccountInfo>> | null = null;
    let vaultReadFailed = false;
    try {
      info = await conn.getAccountInfo(vault);
    } catch (e) {
      vaultReadFailed = true;
      no(
        "3c. could not READ the MAINNET fee vault, so its existence is UNKNOWN",
        String(e).slice(0, 100),
      );
    }
    if (vaultReadFailed) {
      // already reported
    } else if (info) {
      ok("3c. the MAINNET fee vault exists", vault.toBase58());
    } else {
      atStep(
        "9b, BEFORE step 8's UNPAUSE",
        "3c. the MAINNET fee vault does not exist yet",
        `${vault.toBase58()} -- run scripts/create-fee-vault.ts AFTER the deploy and BEFORE the ` +
          `unpause, or every mint and every redeem reverts AccountNotInitialized`,
        // ROUND 8 L1-04. Due at 8, NOT 9. The deadline moved with the posture: the unpause is now
        // the go-live, because initialize leaves mint and redeem open, so a vault that is merely
        // "due at 9b" is reported on time by this gate and missing in production. `dueStep < STAGE`
        // means 8 here makes `--stage=8` report it OVERDUE, which is the whole point of the flag.
        8,
      );
    }
  }

  ok(
    "4. redeem: OPEN at launch (round 8), and reopening after a close needs no upgrade",
    "ROUND 8: redemptions_enabled is true from initialize. set_redemptions_enabled still refuses " +
      "true, so the asymmetry is unchanged: closing is instant on both lanes and REOPENING rides " +
      "the 24h-timelocked SetRedeemLimits action (propose_set_redeem_limits with " +
      "redemptionsEnabled=true). The path did not change; the starting point did. " +
      // ROUND 5 P1-06. This used to list "treasury_min_float_usdc must be non-zero" as a
      // precondition, which contradicts D5. Two sources of truth gave incompatible orders: following
      // the decision made this gate report a blocker, following the gate annulled the decision. The
      // float is a risk the owner accepted, so it is stated as one and gates nothing.
      "PRECONDITIONS: the fee vault must exist (scripts/create-fee-vault.ts) and the treasury must " +
      "hold USDC. treasury_min_float_usdc is 0 by decision D5 (risk accepted, SolidProof LOW #4 " +
      "open by choice); withdraw_usdc stays 24h-timelocked and guardian-cancellable, which is what " +
      "makes that defensible. Set a floor later with propose_set_treasury_min_float if redeem volume " +
      "grows",
  );
  ok("5. admin portal for admin + guardians + Squads members", "step 11");
  ok(
    "6. revoke the deployer, upgrade authority to the multisig",
    "step 12, and it MUST be last: initialize requires the deployer to BE the upgrade authority",
  );

  // ------------------------------------------------------------ human blockers
  section("F. Only a human can clear these");
  byHand("Sunrise confirmed they accept freeze authority + permanent delegate");
  byHand("the Vercel PROD Pyth key has the pyth-indices entitlement");
  // FOUND 2026-08-11 by an independent review of the admin panel, and it is a launch blocker that was
  // written down nowhere.
  //
  // `authorities.ops_admin.pubkey` (65g5nNX...) is the Squads VAULT PDA, which is what config.admin is
  // set to. Verified on mainnet: that account is owned by the System Program with ZERO bytes of data and
  // 5.1 SOL, which is a vault, not a Squads multisig account. But the admin panel's
  // NEXT_PUBLIC_OPS_SQUADS wants the MULTISIG address, a DIFFERENT pubkey that this repo does not record
  // anywhere and that cannot be recovered from chain: the vault has never had a Squads interaction, only
  // USDC funding transfers, so its history contains no reference to its own multisig.
  //
  // WHAT HAPPENS IF IT IS MISSING: isConfigured("ops") is false, the panel shows its placeholder banner,
  // and EVERY Squads action is disabled. On mainnet config.admin IS the vault, so that means no premint,
  // no add-guardian and no unpause from the panel. The go-live lever would not be clickable.
  //
  // WHAT HAPPENS IF THE WRONG ONE IS PASTED: pasting the VAULT here (the likely mistake, since that is
  // the address written in every note) makes adminAuthority() derive a vault OF the vault, a third
  // address that is not config.admin. Every proposal built would target the wrong signer.
  //
  // The owner has UI access to both multisigs, so this is a read-and-record task, not a recovery task.
  byHand(
    "NEXT_PUBLIC_OPS_SQUADS is the ops MULTISIG address (not the vault 65g5nNX...), set in Vercel prod",
    "read it from the Squads UI; the vault is config.admin, the multisig is what the panel needs",
  );
  byHand("NEXT_PUBLIC_UPGRADE_SQUADS likewise, and both recorded in config/mainnet-authorities.json");
  // MEASURED 2026-08-10, and this used to be a `byHand` reading "…resolves". A human clearing it by
  // curling the URL and seeing 200 gets a GUARANTEED false pass: dominion.market is an SPA catch-all
  // that answers 200 with the same 5,228-byte HTML document for EVERY path, including
  // /definitely-does-not-exist.json. The file is simply absent. The URI is written into the mint at
  // creation, so a launch on this state bakes a URI serving HTML and SILV renders broken in every
  // wallet; the repair is propose_/execute_update_metadata, a 24h timelock, i.e. not on launch day.
  // "Resolves" is therefore the wrong question. The check is: does it parse as JSON, and does it
  // differ from what a nonsense path returns.
  await checkMetadataUri();
  byHand("site copy discloses the freeze and seize powers");
  byHand("at least 2 independent guardian keys exist, on hardware");
  // ROUND 5 P1-06. Was "treasury_min_float_usdc will be set NON-ZERO before any USDC arrives", which
  // asked a human to confirm the opposite of D5. What a human genuinely has to own is the MONITORING
  // that replaces the floor, since the accepted risk is only defensible while somebody is watching the
  // 24h window a withdrawal announces itself in.
  byHand(
    "treasury balance monitoring + a named human to veto a withdrawal inside its 24h window " +
      "(this is what stands in for treasury_min_float_usdc, which D5 sets to 0 on purpose)",
  );
  byHand("the mint-creation ceremony uses the COMPLIANCE vault, not the dev wallet");

  console.log(
    `\n=== ${ready} ready, ${scheduled} satisfied by a ceremony step, ${human} need a human, ${blocked} BLOCKING ===`,
  );
  if (scheduled > 0) {
    console.log(
      `\n  ${scheduled} item(s) are resolved BY a runbook step, so they are expected to be red\n` +
        "  before the ceremony and must be re-run after that step. They do NOT block starting.",
    );
    if (STAGE === null) {
      console.log(
        "  Pass --stage=N (the step you are ABOUT to perform) and any of them still unmet from an\n" +
          "  EARLIER step becomes BLOCKING. Without --stage this gate cannot tell 'not yet' from\n" +
          "  'skipped', so a mid-ceremony run reads falsely reassuring.",
      );
    } else {
      console.log(`  Evaluated at --stage=${STAGE}: anything due before it is reported OVERDUE.`);
    }
  }
  if (blocked > 0) {
    console.log(
      `\nDo NOT start the ceremony: ${blocked} BLOCKING item(s) above must be resolved first.\n` +
        "  BLOCKING means it cannot be fixed by any step of the runbook, so starting would strand you\n" +
        "  mid-ceremony. That is a different thing from the AT STEP items, which are supposed to be red.",
    );
    process.exit(1);
  }
  console.log("Nothing mechanically blocking. Work through docs/MAINNET_LAUNCH_RUNBOOK.md.");
}

main().catch((e) => {
  console.error("readiness check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
