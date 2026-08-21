/**
 * The operational alarm: is someone attacking us, and can we still honour redemptions.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, because the first version got it wrong. It does NOT alert on
 * treasury coverage of SILV held by third parties. That metric assumed holders would come and redeem at
 * the protocol, but the pre-minted SILV went into liquidity pools where partners post the USDC side, so
 * the float is not a redemption claim. An alert that maps to no real risk is worse than no alert: it is
 * exactly what teaches people to ignore the channel. Removed, not kept "just in case".
 *
 * WHAT IT WATCHES INSTEAD.
 *
 *  1. AM I BEING ATTACKED. The signal is not a ratio, it is the INVARIANCE of what must never change.
 *     Control of this protocol lives in a handful of fields and every takeover has to move one: the
 *     admin, a pending admin transfer, the guardian count, the SILV mint's own mint/freeze/delegate
 *     authorities, the inventory and treasury destinations, the program's upgrade authority, and the slot
 *     of the last deploy. They are PINNED below as literals. Drift is the alarm, and changing one
 *     deliberately means editing a constant in a commit, which is a better audit trail than a database.
 *
 *     The deploy slot earns its own sentence: an upgrade replaces the program's logic wholesale and
 *     cannot avoid changing that slot. It is the cheapest exact detector of the worst event.
 *
 *  2. UNEXPECTED INSTRUCTIONS. Normal traffic is mint, redeem, and our own deposits and pre-mints.
 *     Anything else running, a pause, an authority change, a withdrawal, is either us and we know, or
 *     someone else and we need to know now. Allow-listing the normal and alerting on the rest catches a
 *     class of attack no balance check can see.
 *
 *  3. CAN WE STILL PAY REDEMPTIONS. Not coverage of the float: whether the treasury can serve the
 *     redemptions actually arriving. An absolute floor under which redeems start reverting, plus the
 *     rolling 24h budget approaching or hitting its cap, since that cap stops redeems outright.
 *
 *  4. VOLUME, both directions. A lot of mints or a lot of redeems in a short window is worth knowing
 *     even when nothing is broken.
 *
 *  5. THE ORACLE. Kept because it is not noise: it fires only when priced operations are actually
 *     reverting for everyone, which is invisible from every balance in the system.
 *
 * Supply against the cap is a TREND, not an incident, so it lives in the weekly digest (--weekly) rather
 * than in a ten-minute alarm.
 *
 * THE EXIT CODE ANSWERS "DID THE CHECK RUN", NOT "IS THERE A PROBLEM", and the first version had this
 * backwards with a measurable cost. It exited 1 on every alert, a non-zero exit fails the workflow, and a
 * failed workflow mails everyone watching the repository. So a single true-and-unchanging condition sent
 * a Telegram message AND an email every ten minutes: 100 of the last 100 runs were red on 2026-08-21.
 * The alert channel is Telegram. CI status is reserved for the monitor itself being broken.
 *   0  the check ran, whatever it found
 *   1  the check could not be completed, or an alert could not be delivered. Investigate the monitor.
 *
 * TELEGRAM ONLY ON A TRANSITION, in English, via `_alert-state.ts`. A condition that is still true is
 * silent until `MONITOR_RENOTIFY_HOURS` has passed. A channel that says "all good" every ten minutes gets
 * muted, and a channel that repeats the same true alarm every ten minutes gets muted faster, because it
 * teaches the reader that nothing in it is new.
 *
 * IT DOES NOT PAUSE ANYTHING. `pause` needs admin or a guardian, both Squads vaults, so every reaction
 * carries 3-of-5 latency. The rolling budget is the brake; this is only the sensor.
 *
 * Run: DOMINION_RPC=<mainnet> npx tsx scripts/health-monitor.ts [--weekly]
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { getMint, getPermanentDelegate, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { redactRpc } from "./_redact";
import { pingHeartbeat, sendTelegram, telegramFromEnv } from "./_telegram";
import { diffAlerts } from "./_alert-state";

const RPC = process.env.DOMINION_RPC;
const PUBLIC_URL = process.env.PUBLIC_URL || "https://app.dominion.market";
const WEEKLY = process.argv.slice(2).includes("--weekly");

/** Thresholds, tunable by environment because one that needs a deploy gets left wrong. */
const T = {
  budgetWarnPct: Number(process.env.HEALTH_BUDGET_WARN_PCT ?? 70),
  treasuryFloorUsdc: Number(process.env.HEALTH_TREASURY_FLOOR_USDC ?? 2_000),
  mintSpikeOz: Number(process.env.HEALTH_MINT_SPIKE_OZ ?? 2_000),
  redeemSpikeOz: Number(process.env.HEALTH_REDEEM_SPIKE_OZ ?? 500),
  maxRevertPct: Number(process.env.HEALTH_MAX_REVERT_PCT ?? 30),
  /**
   * The smallest sample a revert PERCENTAGE may be computed over. Without this, one reverted transaction
   * in a quiet hour reads as "100% of program traffic is failing", which is arithmetically true and
   * operationally meaningless. It fired exactly that way on a window containing a single transaction.
   */
  minRevertSample: Number(process.env.HEALTH_MIN_REVERT_SAMPLE ?? 5),
  scanLimit: Number(process.env.HEALTH_SCAN_LIMIT ?? 200),
  /** How many successful transactions to open for instruction and volume tallying. */
  deepScan: Number(process.env.HEALTH_DEEP_SCAN ?? 60),
  /**
   * How far back to look, in minutes. WITHOUT THIS the first run alerted on the entire launch history:
   * `Initialize`, `Unpause`, the IDL writes, and a "+92,881 oz mint spike" that was the pre-mint from an
   * hour earlier. A ten-minute alarm must judge a recent window, or every past event fires forever.
   * 60 minutes gives a 10-minute cron six-fold overlap, so nothing falls between runs.
   */
  lookbackMin: Number(process.env.HEALTH_LOOKBACK_MIN ?? 60),
};

/**
 * PINNED CONTROL SURFACE, read from mainnet on 2026-08-13. Every takeover has to move one of these.
 * Changing one deliberately means editing this literal in a commit.
 */
const PINNED = {
  admin: "65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS",
  inventoryWallet: "65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS",
  usdcTreasury: "5ssUsHbD8gvTdPgbQqAPz2r6iuWnkrCJaLnCW4Sdi2zK",
  silvMint: "SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L",
  guardianCount: 1,
  mintAuthority: "6FtT3CBaXVArhd2C4egCsQb1f1NF3FAfA6xhXJXD8chR",
  freezeAuthority: "FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3",
  permanentDelegate: "FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3",
  /**
   * STILL THE DEPLOYER, a single hot key, not the upgrade Squads vault. Whoever holds it can replace the
   * entire program with no multisig and no timelock. Pinned as-is so the alarm reflects reality rather
   * than the intention. UPDATE THIS LITERAL when the authority is handed to the multisig, otherwise the
   * handover itself pages.
   */
  upgradeAuthority: "2Lp91FyJUb8MQ1yteFLKh345Umb5f1RgCCwwDFNCYEcD",
  deploySlot: 438841839,
  /**
   * 5 bps since 2026-08-21, down from 100. Applied through the 24h timelock as proposal #36
   * (`execute_set_premium_mint`), and pinned the same day. Left at 100 for a few hours after the change
   * landed, which made the monitor page on our own deliberate act every ten minutes: pinning a value
   * means updating it in the SAME change that alters the chain, not afterwards.
   */
  premiumBpsMint: 5,
  premiumBpsRedeem: 150,
  maxSilvSupplyAtomic: "150000000000",
  pythLazerFeedId: 3154,
  minPublishers: 2,
  instantRedeemBudgetAtomic: "20000000000",
  instantRedeemWindowSeconds: 86_400,
  minOperationUsdcAtomic: "10000000",
  adminTimelockSeconds: 86_400,
  paused: false,
  publicMintEnabled: true,
  redemptionsEnabled: true,
  mintPaused: false,
  redeemPaused: false,
};

/**
 * Instructions that are NORMAL traffic ON OUR PROGRAM. Anything else is either us and we know, or
 * someone else and this is how we find out. Deliberately short: adding a name here is a decision.
 *
 * ONLY OUR PROGRAM'S OWN INSTRUCTIONS ARE JUDGED, and the first version got this wrong too. A
 * transaction's logs contain the Anchor line for every CPI as well, so allow-listing against raw log
 * names alerted on `VerifyMessage` (Pyth Lazer), `MintTo` and `Burn` and `InitializeAccount3`
 * (Token-2022) and `VaultTransactionExecute` (Squads). Those are inner steps of a perfectly normal mint.
 * Intersecting with the names declared in our IDL removes every foreign CPI without maintaining a second
 * list that would drift.
 */
const EXPECTED_INSTRUCTIONS = new Set(["MintSilv", "RedeemSilv", "DepositUsdc", "AdminPremint"]);

/** Our program's instruction names, PascalCase as Anchor logs them. Derived, never hand-listed. */
function ourInstructionNames(idl: Record<string, unknown>): Set<string> {
  const names = ((idl.instructions as { name: string }[] | undefined) ?? []).map((i) =>
    i.name.replace(/(^|_)([a-z])/g, (_m, _p, c: string) => c.toUpperCase()),
  );
  return new Set(names);
}

const alerts: string[] = [];
const info: string[] = [];
let couldNotTell = false;

const alert = (w: string): void => {
  alerts.push(w);
  console.log(`  ALERT  ${w}`);
};
const okLine = (w: string): void => console.log(`  ok     ${w}`);
const unknown = (w: string): void => {
  couldNotTell = true;
  alerts.push(`COULD NOT CHECK: ${w}`);
  console.log(`  ????   COULD NOT CHECK: ${w}`);
};

/** Compare a live value against its pinned literal. Any drift is the alarm. */
function pin(label: string, got: unknown, want: unknown): void {
  if (String(got) !== String(want)) alert(`${label} CHANGED: now ${got}, pinned ${want}`);
}

/** Fetch a JSON route from the public site. Anonymous: the pre-launch password gate is gone, so a
 *  non-ok answer here is a real fault and never a missing credential. */
async function fetchJson(path: string, init?: RequestInit): Promise<unknown | null> {
  const res = await fetch(`${PUBLIC_URL}${path}`, init).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("DOMINION_RPC must be set");
  const conn = new Connection(RPC, "confirmed");
  console.log(`health monitor${WEEKLY ? " (weekly digest)" : ""}`);
  console.log(`  cluster : ${redactRpc(RPC)}`);
  console.log("");

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const idl = loadIdl();
  const OURS = ourInstructionNames(idl);
  const program = new Program(
    idl as Idl,
    new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" }),
  );
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
  const cfg: any = await (program.account as any).configAccount.fetch(configPda);

  // ---- 1. the control surface, which IS the hack detector --------------------------------
  console.log("== control surface ==");
  pin("config.admin", cfg.admin, PINNED.admin);
  pin("config.inventory_wallet", cfg.inventoryWallet, PINNED.inventoryWallet);
  pin("config.usdc_treasury", cfg.usdcTreasury, PINNED.usdcTreasury);
  pin("config.silv_mint", cfg.silvMint, PINNED.silvMint);
  pin("guardian_count", Number(cfg.guardianCount), PINNED.guardianCount);
  // A pending admin transfer is the loudest possible signal: someone is taking the protocol.
  if (cfg.pendingAdmin !== null) {
    alert(`ADMIN TRANSFER PENDING to ${String(cfg.pendingAdmin)}. Cancel it now if this is not us.`);
  }
  pin("premium_bps_mint", Number(cfg.premiumBpsMint), PINNED.premiumBpsMint);
  pin("premium_bps_redeem", Number(cfg.premiumBpsRedeem), PINNED.premiumBpsRedeem);
  pin("max_silv_supply", cfg.maxSilvSupply.toString(), PINNED.maxSilvSupplyAtomic);
  pin("pyth_lazer_feed_id", Number(cfg.pythLazerFeedId), PINNED.pythLazerFeedId);
  pin("min_publishers", Number(cfg.minPublishers), PINNED.minPublishers);
  pin("instant_redeem_budget", cfg.instantRedeemBudgetUsdc.toString(), PINNED.instantRedeemBudgetAtomic);
  pin("instant_redeem_window", Number(cfg.instantRedeemWindowSeconds), PINNED.instantRedeemWindowSeconds);
  pin("min_operation_usdc", cfg.minOperationUsdc.toString(), PINNED.minOperationUsdcAtomic);
  pin("admin_timelock_seconds", Number(cfg.adminTimelockSeconds), PINNED.adminTimelockSeconds);
  pin("paused", cfg.paused, PINNED.paused);
  pin("public_mint_enabled", cfg.publicMintEnabled, PINNED.publicMintEnabled);
  pin("redemptions_enabled", cfg.redemptionsEnabled, PINNED.redemptionsEnabled);
  pin("mint_paused", cfg.mintPaused, PINNED.mintPaused);
  pin("redeem_paused", cfg.redeemPaused, PINNED.redeemPaused);

  // The mint's own authorities. If mint authority leaves the PDA, someone can print SILV at will.
  const silvMint = new PublicKey(String(cfg.silvMint));
  const mintAcc = await getMint(conn, silvMint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
  if (!mintAcc) unknown("the SILV mint account is unreadable, so its authorities are unverified");
  else {
    pin("SILV mint authority", mintAcc.mintAuthority?.toBase58(), PINNED.mintAuthority);
    pin("SILV freeze authority", mintAcc.freezeAuthority?.toBase58(), PINNED.freezeAuthority);
    pin("SILV permanent delegate", getPermanentDelegate(mintAcc)?.delegate?.toBase58(), PINNED.permanentDelegate);
  }

  // The program binary. UpgradeableLoaderState::ProgramData is
  // 4-byte discriminator | slot u64 | Option<Pubkey> upgrade authority.
  const [pdAddr] = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  );
  const pdInfo = await conn.getAccountInfo(pdAddr, "confirmed").catch(() => null);
  if (!pdInfo || pdInfo.data.length < 45) {
    unknown("ProgramData is unreadable, so a program upgrade would go unnoticed");
  } else {
    const slot = Number(pdInfo.data.readBigUInt64LE(4));
    const auth = pdInfo.data[12] === 1 ? new PublicKey(pdInfo.data.subarray(13, 45)).toBase58() : "NONE";
    if (slot !== PINNED.deploySlot) {
      alert(
        `THE PROGRAM WAS UPGRADED: deploy slot ${slot}, pinned ${PINNED.deploySlot}. All logic may have ` +
          `been replaced. Treat as a compromise until proven otherwise.`,
      );
    }
    pin("program upgrade authority", auth, PINNED.upgradeAuthority);
  }
  if (alerts.length === 0) okLine("every pinned control and economic field is unchanged");

  // ---- 2. queued timelocked actions ------------------------------------------------------
  const pending = Object.entries(cfg)
    .filter(([k, v]) => /^pending[A-Z]/.test(k) && k.endsWith("Nonce") && v !== null)
    .map(([k]) => k);
  if (pending.length > 0) alert(`timelocked change QUEUED: ${pending.join(", ")}. Cancel now if unexpected.`);
  else okLine("no timelocked change queued");

  // ---- 3. can we still pay redemptions ---------------------------------------------------
  console.log("");
  console.log("== redemptions ==");
  const treasuryUsdc = await conn
    .getTokenAccountBalance(new PublicKey(String(cfg.usdcTreasury)), "confirmed")
    .then((b) => Number(b.value.amount) / 1e6)
    .catch(() => NaN);
  const minOp = Number(cfg.minOperationUsdc) / 1e6;
  if (Number.isNaN(treasuryUsdc)) unknown("treasury balance unreadable");
  else {
    console.log(`  treasury ${treasuryUsdc.toLocaleString("en-US")} USDC`);
    if (treasuryUsdc < minOp) {
      alert(
        `treasury ${treasuryUsdc.toFixed(2)} USDC is below the ${minOp.toFixed(2)} minimum operation: ` +
          `EVERY redeem now reverts on funds.`,
      );
    } else if (treasuryUsdc < T.treasuryFloorUsdc) {
      alert(
        `treasury ${treasuryUsdc.toFixed(0)} USDC is below the ${T.treasuryFloorUsdc} floor: redeems ` +
          `above roughly ${(treasuryUsdc / 65).toFixed(0)} oz are already reverting. Top it up.`,
      );
    } else okLine(`treasury above the ${T.treasuryFloorUsdc} USDC floor`);
  }

  // The rolling 24h budget. This is the brake, so it filling matters as much as the balance, and hitting
  // it stops redemptions outright until the window rolls.
  const budget = Number(cfg.instantRedeemBudgetUsdc) / 1e6;
  const windowSecs = Number(cfg.instantRedeemWindowSeconds);
  const windowStart = Number(cfg.instantWindowStart);
  const inWindow = Math.floor(Date.now() / 1000) - windowStart < windowSecs;
  const used = inWindow ? Number(cfg.instantUsedUsdc) / 1e6 : 0;
  const usedPct = budget > 0 ? (used / budget) * 100 : 0;
  console.log(
    `  24h budget ${used.toFixed(2)} / ${budget.toLocaleString("en-US")} USDC used (${usedPct.toFixed(1)}%)` +
      `${inWindow ? "" : ", window expired so the counter resets on the next redeem"}`,
  );
  if (usedPct >= 100) {
    alert(`the 24h redemption cap is REACHED (${used.toFixed(0)} / ${budget} USDC). Redeems revert until the window rolls.`);
  } else if (usedPct >= T.budgetWarnPct) {
    alert(`the 24h redemption budget is ${usedPct.toFixed(0)}% consumed (${used.toFixed(0)} / ${budget} USDC).`);
  } else okLine(`24h budget under the ${T.budgetWarnPct}% warning line`);

  // ---- 4. volume, and instructions that should not be running ----------------------------
  console.log("");
  console.log("== activity ==");
  let mintOz = 0;
  let redeemOz = 0;
  const cutoff = Math.floor(Date.now() / 1000) - T.lookbackMin * 60;
  const allSigs = await conn
    .getSignaturesForAddress(PROGRAM_ID, { limit: T.scanLimit }, "confirmed")
    .catch(() => null);
  // Time-bound BEFORE judging anything: a signature list is ordered but unbounded in age, and the whole
  // launch ceremony sits a few hundred entries back.
  const sigs = allSigs?.filter((s) => (s.blockTime ?? 0) >= cutoff) ?? null;
  if (!sigs) unknown("could not list program signatures, so activity is unknown");
  else if (sigs.length === 0) okLine(`no program activity in the last ${T.lookbackMin} min`);
  else {
    const failed = sigs.filter((s) => s.err !== null).length;
    const revertPct = (failed / sigs.length) * 100;
    const seen = new Map<string, number>();
    for (const s of sigs.filter((x) => x.err === null).slice(0, T.deepScan)) {
      const tx = await conn
        .getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .catch(() => null);
      if (!tx) continue;
      for (const l of tx.meta?.logMessages ?? []) {
        const m = /^Program log: Instruction: (\w+)$/.exec(l);
        if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
      }
      // Volume straight from the SILV balance deltas: exact, and it needs no event decoding.
      const pre = (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === PINNED.silvMint);
      const post = (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === PINNED.silvMint);
      let delta = 0;
      for (const p of post) {
        const b = pre.find((x) => x.accountIndex === p.accountIndex);
        delta += Number(p.uiTokenAmount.uiAmount ?? 0) - Number(b?.uiTokenAmount.uiAmount ?? 0);
      }
      if (delta > 1e-9) mintOz += delta;
      else if (delta < -1e-9) redeemOz += -delta;
    }
    const ourSeen = [...seen.entries()].filter(([k]) => OURS.has(k));
    console.log(`  window           : last ${T.lookbackMin} min, ${sigs.length} transaction(s)`);
    console.log(`  our instructions : ${ourSeen.map(([k, v]) => `${k} x${v}`).join(", ") || "none"}`);
    console.log(`  volume in window : +${mintOz.toFixed(3)} oz minted, -${redeemOz.toFixed(3)} oz redeemed`);
    console.log(`  revert rate      : ${revertPct.toFixed(0)}% of ${sigs.length}`);

    for (const [name, n] of seen) {
      // Only OUR instructions are judged. A foreign CPI in the logs is not our surface.
      if (OURS.has(name) && !EXPECTED_INSTRUCTIONS.has(name)) {
        alert(`UNEXPECTED INSTRUCTION executed: ${name} x${n}. If this is not us, act now.`);
      }
    }
    if (mintOz > T.mintSpikeOz) alert(`mint volume spike: +${mintOz.toFixed(0)} oz in the scanned window.`);
    if (redeemOz > T.redeemSpikeOz) alert(`redeem volume spike: -${redeemOz.toFixed(0)} oz in the scanned window.`);
    if (revertPct > T.maxRevertPct && sigs.length >= T.minRevertSample) {
      alert(`${failed} of ${sigs.length} program transactions REVERTED (${revertPct.toFixed(0)}%): broken for users, or probing.`);
    } else if (revertPct > T.maxRevertPct) {
      // Reported, not alerted: the ratio is real but the sample cannot support it.
      okLine(`${failed} of ${sigs.length} reverted, below the ${T.minRevertSample}-transaction sample floor for a rate alert`);
    }
    info.push(`+${mintOz.toFixed(1)} oz minted, -${redeemOz.toFixed(1)} oz redeemed, ${revertPct.toFixed(0)}% reverts`);
  }

  // ---- 5. the oracle, through the user's own path ----------------------------------------
  console.log("");
  console.log("== oracle ==");
  const before = alerts.length;
  const lazer = (await fetchJson("/api/lazer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })) as { envelopeBase64?: string; price?: Record<string, number> } | null;
  if (!lazer?.envelopeBase64 || !lazer.price) {
    alert("/api/lazer returns no signed envelope: every mint and redeem reverts until this recovers.");
  } else {
    const p = lazer.price;
    const ageSec = Math.floor(Date.now() / 1000) - Number(p.publishTimeSec);
    const maxStale = Number(cfg.maxStalenessSeconds ?? 15);
    console.log(`  price $${Number(p.priceUsd).toFixed(4)}/oz | ${p.publisherCount} publishers | age ${ageSec}s`);
    if (Number(p.publisherCount) < Number(cfg.minPublishers)) {
      alert(`only ${p.publisherCount} publishers against a floor of ${cfg.minPublishers}: priced operations revert.`);
    }
    if (ageSec > maxStale) {
      alert(`the price envelope is ${ageSec}s old against max_staleness ${maxStale}s: priced operations revert.`);
    }
    if (alerts.length === before) okLine("oracle healthy");
  }

  // ---- verdict, then delivery ------------------------------------------------------------
  const mintInfo = await conn.getParsedAccountInfo(silvMint, "confirmed");
  const supplyOz = Number((mintInfo.value as any)?.data?.parsed?.info?.supply ?? 0) / 1e6;
  const capOz = Number(cfg.maxSilvSupply) / 1e6;

  console.log("");
  console.log(`  VERDICT: ${alerts.length === 0 ? "QUIET" : `${alerts.length} ALERT(S)`}`);
  await pingHeartbeat();

  const tg = telegramFromEnv();

  if (WEEKLY) {
    // A trend, kept separate from the alarm because it is something to read, not to react to.
    const lines = [
      "DOMINION weekly digest",
      "",
      `circulating supply  ${supplyOz.toLocaleString("en-US")} oz`,
      `cap                 ${capOz.toLocaleString("en-US")} oz`,
      `cap used            ${((supplyOz / capOz) * 100).toFixed(2)}%`,
      `headroom            ${(capOz - supplyOz).toLocaleString("en-US")} oz`,
      "",
      `treasury            ${Number.isNaN(treasuryUsdc) ? "?" : treasuryUsdc.toLocaleString("en-US")} USDC`,
      `24h redeem budget   ${used.toFixed(0)} / ${budget.toLocaleString("en-US")} USDC used`,
      ...(info.length ? ["", `recent activity     ${info[0]}`] : []),
      "",
      alerts.length === 0 ? "No open alerts." : `${alerts.length} open alert(s), see the alert messages.`,
    ];
    if (tg) await sendTelegram(tg, lines.join("\n"));
    else console.error("  TELEGRAM NOT CONFIGURED: the weekly digest reached nobody.");
  }

  // Only TRANSITIONS are sent. `diffAlerts` persists the open set, so a condition that is still true
  // stays silent until MONITOR_RENOTIFY_HOURS has elapsed. See scripts/_alert-state.ts for why.
  const tr = diffAlerts(alerts);
  const footer = `supply ${supplyOz.toLocaleString("en-US")} oz | treasury ${
    Number.isNaN(treasuryUsdc) ? "?" : treasuryUsdc.toLocaleString("en-US")
  } USDC | 24h budget ${usedPct.toFixed(0)}% used`;

  console.log(
    `  transitions: ${tr.fresh.length} new, ${tr.reminders.length} still-open reminder(s), ` +
      `${tr.resolved.length} resolved${tr.hadStateFile ? "" : " (no previous state: treating open alerts as new)"}`,
  );

  let deliveryFailed = false;
  const send = async (text: string): Promise<void> => {
    if (!tg) {
      console.error("  TELEGRAM NOT CONFIGURED: this message reached nobody.");
      deliveryFailed = true;
      return;
    }
    if (await sendTelegram(tg, text)) console.log("  telegram: delivered");
    else deliveryFailed = true;
  };

  if (tr.fresh.length > 0 || tr.reminders.length > 0) {
    const lines = [
      tr.fresh.length > 0 ? "DOMINION ALERT" : "DOMINION ALERT still open",
      "",
      ...tr.fresh.slice(0, 8).map((a) => `- ${a}`),
      ...(tr.fresh.length > 8 ? [`- ...and ${tr.fresh.length - 8} more`] : []),
      ...(tr.reminders.length > 0 ? [""] : []),
      ...tr.reminders
        .slice(0, 6)
        .map((r) => `- STILL OPEN ${r.hoursOpen.toFixed(0)}h: ${r.text}`),
      "",
      footer,
      "",
      "This monitor does not pause anything. `pause` needs admin or a guardian, both Squads vaults,",
      "so every reaction carries 3-of-5 latency. The rolling redeem budget is the real brake.",
    ];
    await send(lines.join("\n"));
  }

  // Recovery is news. Sent separately so it can never be mistaken for a new problem.
  if (tr.resolved.length > 0) {
    await send(["DOMINION RESOLVED", "", ...tr.resolved.map((a) => `- no longer true: ${a}`), "", footer].join("\n"));
  }

  if (tr.quiet) {
    console.log(
      alerts.length === 0
        ? "  nothing to send: no alerts."
        : `  nothing to send: ${alerts.length} alert(s) open but unchanged since the last run.`,
    );
  }

  // The exit code reports on the CHECK, not on the chain. `couldNotTell` means a probe failed and the
  // answer is unknown, which is a monitor fault. A delivered alert is a working monitor.
  if (couldNotTell || deliveryFailed) {
    console.error("  EXIT 1: the check was incomplete or an alert could not be delivered.");
    process.exit(1);
  }
  process.exit(0);
}


main().catch((e) => {
  // A crash is a monitor fault: the one thing the exit code still reports.
  console.error(`health-monitor CRASHED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
