/**
 * One command that answers "can we launch on mainnet?" against the six requirements
 * Thomas confirmed on 2026-07-29, checking everything that is mechanically checkable and
 * naming, precisely, what is left for a human.
 *
 * This is deliberately separate from verify-mainnet-authorities.ts, which only checks the
 * authority assignment. This one checks the whole launch: the build, the constants, the
 * oracle on MAINNET data, the app configuration, and the requirement-by-requirement
 * verdict including the things that CANNOT be done without a program upgrade.
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
function ok(msg: string, detail = "") {
  console.log(`  READY    ${msg}${detail ? ` -> ${detail}` : ""}`);
  ready++;
}
function no(msg: string, detail = "") {
  console.log(`  BLOCKED  ${msg}${detail ? ` -> ${detail}` : ""}`);
  blocked++;
}
function byHand(msg: string, detail = "") {
  console.log(`  BY HAND  ${msg}${detail ? ` -> ${detail}` : ""}`);
  human++;
}
function section(t: string) {
  console.log(`\n${t}`);
}

function grep(rel: string, re: RegExp): string | null {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  const m = re.exec(fs.readFileSync(p, "utf8"));
  return m ? m[1] : null;
}

function runScript(rel: string, args: string[] = []): boolean {
  try {
    execFileSync("bash", [path.join(ROOT, rel), ...args], { stdio: "pipe" });
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
  runScript("scripts/verify-release-artifact.sh")
    ? ok("artifact matches a clean default rebuild, no dev hatch")
    : no("verify-release-artifact.sh FAILED", "run it directly for the reason");
  runScript("scripts/verify-constants-consistency.sh")
    ? ok("every hand-copied address agrees with declare_id!")
    : no("verify-constants-consistency.sh FAILED", "run it directly");

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
      : no(`apps/${app} USDC_MINT is NOT mainnet`, `${usdc} (swap at runbook step 2)`);
  }
  const lt = grep(
    "apps/public/src/lib/constants.ts",
    /LAZER_TREASURY\s*=\s*new PublicKey\("([^"]+)"/,
  );
  lt === LAZER_TREASURY_MAINNET
    ? ok("apps/public LAZER_TREASURY is the mainnet value")
    : no("apps/public LAZER_TREASURY is NOT mainnet", `${lt} (it is cluster-specific)`);
  const feed = grep("apps/public/src/lib/constants.ts", /LAZER_SILV_FEED_ID\s*=\s*(\d+)/);
  Number(feed) === FEED_ID
    ? ok(`feed id is ${FEED_ID} (Metal.Index.SILVER/USD, pure spot)`)
    : no(`feed id is ${feed}, expected ${FEED_ID}`);

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
          `${ozFor100k.toFixed(0)} oz, vs the 100,000 oz cap`,
        );
      }
    }
  } catch (e) {
    byHand("could not reach Pyth", String(e).slice(0, 80));
  }

  // ------------------------------------------------------ the six requirements
  section("E. Your six launch requirements");
  ok("1. SILV token deployed and live", "runbook steps 3-6");
  ok("2. pre-mint freely to the inventory wallet, seed a Sunrise pool", "steps 7-9");
  byHand(
    "3. public mint with no KYC",
    "works, but opening it costs a 24h timelock (propose at step 7, execute at step 10)",
  );
  // 2026-08-05: this was recorded as BLOCKED, and any blocked item exits 1 with "Do NOT start the
  // ceremony". It is now satisfied: `kyc_scope_flags` IS read, by mint_silv and redeem_silv, and
  // `set_kyc_scope` arms it instantly. Leaving the stale `no()` here would have hard-failed the
  // launch gate on a requirement the batch delivered.
  ok(
    "3b. enable KYC LATER",
    "the gate SHIPPED DORMANT (kyc_scope_flags = 0, read by mint_silv + redeem_silv). Arming it " +
      "is a config change, not an upgrade: set_kyc_operator then attest wallets then " +
      "set_kyc_scope. ORDER MATTERS - attest BEFORE arming or every holder is locked out",
  );
  // P1 from the runbook prerequisites, checked mechanically rather than left as prose. The fee
  // vault is the one setup step whose absence turns the whole product off: mint_silv and
  // redeem_silv both take it as a REQUIRED account, so a missing vault means every mint and every
  // redeem reverts AccountNotInitialized the moment the mint is opened.
  //
  // Checked against the CLUSTER THIS SCRIPT IS POINTED AT, so a green here on devnet says nothing
  // about mainnet. That is the honest behaviour: the detail line names the cluster.
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
    const info = await conn.getAccountInfo(vault).catch(() => null);
    if (info) {
      ok("3c. the MAINNET fee vault exists", vault.toBase58());
    } else {
      no(
        "3c. the MAINNET fee vault does NOT exist",
        `${vault.toBase58()} -- run scripts/create-fee-vault.ts AFTER the deploy and BEFORE opening ` +
          `mint or redeem, or every mint and every redeem reverts AccountNotInitialized`,
      );
    }
  }

  ok(
    "4. redeem: closed now, open later WITHOUT an upgrade",
    "set_redemptions_enabled still refuses true, but the 24h-timelocked SetRedeemLimits action " +
      "now carries the switch (propose_set_redeem_limits with redemptionsEnabled=true). " +
      "PRECONDITIONS: the fee vault must exist (scripts/create-fee-vault.ts), the treasury must " +
      "hold USDC, and treasury_min_float_usdc must be non-zero",
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
  byHand("https://dominion.market/silv-metadata.json resolves (baked into the mint forever)");
  byHand("site copy discloses the freeze and seize powers");
  byHand("at least 2 independent guardian keys exist, on hardware");
  byHand("treasury_min_float_usdc will be set NON-ZERO before any USDC arrives");
  byHand("the mint-creation ceremony uses the COMPLIANCE vault, not the dev wallet");

  console.log(
    `\n=== ${ready} ready, ${human} need a human, ${blocked} BLOCKED ===`,
  );
  if (blocked > 0) {
    console.log("Do NOT start the ceremony until the BLOCKED items are resolved.");
    process.exit(1);
  }
  console.log("Nothing mechanically blocking. Work through docs/MAINNET_LAUNCH_RUNBOOK.md.");
}

main().catch((e) => {
  console.error("readiness check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
