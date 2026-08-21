/**
 * The RedeemEvent / budget-consumption alarm. READ ONLY: it opens no keypair and sends no transaction.
 *
 * WHY IT EXISTS. D11 accepted a hot single-signer inventory wallet holding the pre-mint while
 * redemptions are open, and named two things as the compensating controls: an automatic alert on
 * RedeemEvent and on the rate the budget is consumed, tested end to end, and a reachable guardian able
 * to pause inside a measured SLA. As of 2026-08-11 neither existed anywhere in this repo. Nothing
 * watched the only lane USDC can leave through.
 *
 * WHAT IT WATCHES, and it deliberately uses TWO independent sources because each answers a question the
 * other cannot:
 *
 *  1. THE CONFIG ACCOUNT, one read, no history required: the rolling-window buckets. This answers "how
 *     much of the budget is gone right now" without depending on having seen every event. A log-only
 *     monitor that missed a batch would under-report exactly when it matters.
 *  2. THE RedeemEvent LOGS: who redeemed, how much, and at what premium. This answers "is this the
 *     inventory wallet draining, or ordinary users", which the budget number cannot distinguish and
 *     which is the entire D11 threat.
 *
 * THE TRAP, and the program's own source warns about it (events.rs on `amount_usdc`): you CANNOT
 * reconstruct the treasury's outflow from RedeemEvent alone. `amount_usdc` is what the user RECEIVED.
 * While fee routing is ON the treasury also paid the premium; while it is OFF the premium is retained
 * and the treasury paid only `amount_usdc`. A rule assuming `amount_usdc + fee_usdc` over-counts by the
 * premium during precisely the incident that turns routing off. So this reads `fee_routing_disabled`
 * from the config and says which basis it used, rather than deriving outflow from events alone.
 *
 *   DOMINION_RPC=... npx tsx scripts/redeem-monitor.ts
 *   DOMINION_RPC=... npx tsx scripts/redeem-monitor.ts --json      # for a scheduler
 *   REDEEM_MONITOR_WEBHOOK=https://... npx tsx scripts/redeem-monitor.ts
 *
 * THE EXIT CODE REPORTS ON THE CHECK, NOT ON THE CHAIN, and the original design here is what taught us
 * why. "A scheduler that treats non-zero as a failure gets paging for free" was true and it backfired:
 * exiting 1 on every alert made 100 of the last 100 scheduled runs red, and each red run mails everyone
 * watching the repository. With a condition that stays true, that is an email every ten minutes for days.
 * Alerts go to Telegram now, on a TRANSITION only (see scripts/_alert-state.ts). Exit 1 is reserved for
 * the monitor itself failing: it could not read the chain, or it could not deliver.
 *
 * REDEMPTIONS ARE JUDGED ONLY INSIDE A TIME WINDOW, for the same reason. The per-redemption rule compares
 * an outflow against the ROLLING budget, so applying it to a redemption from last week is meaningless
 * twice over: that outflow no longer sits in the window it is being measured against. Measured on
 * 2026-08-21, this alerted on a redemption from 14 August on every single run, seven days running.
 *
 * WHAT THIS CANNOT DO, stated here because a monitor that implies otherwise is dangerous: it does not
 * pause anything. `pause` accepts admin OR guardian, and on mainnet both are Squads vaults, so the
 * reaction carries multisig latency. Detection in 60 seconds buys nothing against a bound of ~40,000
 * USDC in 24h if collecting approvals takes half an hour. Closing that is an operational decision, not
 * code: max_guardian_count is 5 with 2 used, so a dedicated single-key pauser guardian held by whoever
 * is on call makes the reaction fast. A guardian can only pause and cancel, never move funds, so a hot
 * key there is a far smaller exposure than a hot key with admin rights.
 */
import { AnchorProvider, BorshCoder, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { diffAlerts } from "./_alert-state";
import { pingHeartbeat, sendTelegram, telegramFromEnv } from "./_telegram";
import { resolveCluster } from "./_cluster";
import { adversarialBound, rollWindow } from "./_redeem-window";
import { redactRpc } from "./_redact";

const CLUSTER = resolveCluster();
const RPC = CLUSTER.rpc;
const JSON_OUT = process.argv.includes("--json");

const RPC_SAFE = redactRpc(RPC);

/**
 * The alert body, shaped so the three channels anyone actually uses accept it as-is.
 *
 * THE COMMENT THIS REPLACES WAS WRONG, and confidently so: it said "whichever channel is chosen
 * (Telegram, Slack, a pager), it is a POST of this JSON". It is not. Slack reads `text` and answers 400
 * `invalid_payload` to anything else. Discord reads `content` and answers 400 with an embeds error.
 * Telegram's bot API wants `chat_id` and `text`. Posting the raw report to any of them produces a
 * channel that looks configured, exits 1 as if it alerted, and delivers nothing to a human. That is the
 * worst failure mode a monitor has: silence that looks like coverage.
 *
 * So the payload carries a human-readable one-liner under all three keys AND the full structured report
 * alongside. Slack picks up `text`, Discord picks up `content`, Telegram needs `chat_id` in the URL and
 * picks up `text`, and a generic receiver or a Vercel route gets everything. One shape, no per-provider
 * branching to get wrong at 3am.
 */
export function alertPayload(report: Record<string, unknown>): Record<string, unknown> {
  const findings = (report.findings as { level: string; what: string }[] | undefined) ?? [];
  const alerts = findings.filter((f) => f.level === "alert").map((f) => f.what);
  // CAPPED, because this is read on a phone. Measured on devnet: eleven redemptions tripping a low
  // threshold produced a fourteen-line message, and both Slack and Discord truncate. A page that gets
  // truncated loses its last line, which here is the one saying the alarm does not pause anything.
  const MAX_LINES = 5;
  const shown = alerts.slice(0, MAX_LINES).map((a) => `- ${a}`);
  if (alerts.length > MAX_LINES) shown.push(`- ...and ${alerts.length - MAX_LINES} more (see the full report)`);
  const summary =
    `DOMINION REDEEM ALERT (${report.cluster})\n` +
    `${report.usedPct}% of the ${report.budgetUsdc} USDC window used, ` +
    `${report.remainingUsdc} left. Treasury ${report.treasuryUsdc} USDC. ` +
    `paused=${report.paused}\n` +
    (shown.length ? shown.join("\n") : "(no named finding)") +
    `\nThis alarm does NOT pause anything. Pausing needs a guardian or admin signature.`;
  return { text: summary, content: summary, report };
}

/** How much of the budget may be gone before this is an alert rather than a note. */
const BUDGET_ALERT_PCT = Number(process.env.REDEEM_ALERT_BUDGET_PCT ?? 25);
/** A single redemption at or above this share of the budget is an alert on its own. */
const SINGLE_ALERT_PCT = Number(process.env.REDEEM_ALERT_SINGLE_PCT ?? 10);
/**
 * How many recent signatures to scan for events.
 *
 * 25 rather than 100, measured: the first version fetched one transaction per signature and the public
 * devnet RPC answered 429 partway through. It exited 2 rather than 0, which is the design working, but
 * a monitor that rate-limits itself into "could not tell" on a normal run is a monitor nobody trusts.
 * The fetch below is batched; this bound is the second half of the fix. Raise it on a paid RPC.
 */
const SCAN_LIMIT = Number(process.env.REDEEM_SCAN_LIMIT ?? 25);
/**
 * How far back a redemption may be and still be judged, in minutes. Defaults to 1440, one day, which is
 * the rolling budget window the per-redemption percentages are measured against. Older redemptions are
 * still LISTED, because the list is how an operator reads history, but they no longer raise anything.
 */
const LOOKBACK_MIN = Number(process.env.REDEEM_LOOKBACK_MIN ?? 1440);

const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];

type Finding = { level: "alert" | "note"; what: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch transactions in a way that survives a rate-limited endpoint.
 *
 * MEASURED, TWICE. The first version called getTransaction once per signature and the public devnet RPC
 * answered 429 partway through. Batching with getTransactions was better and STILL 429'd, because that
 * endpoint throttles per METHOD and a preceding run had already spent the budget. Both times the
 * monitor exited 2 rather than 0, which is the design working, but a monitor that cannot finish a
 * normal run is a monitor that gets muted.
 *
 * So: try the batch, and on failure fall back to one-at-a-time with a delay, with bounded retries. A
 * production deployment should point DOMINION_RPC at a paid endpoint; this makes a weak one survivable
 * rather than pretending the problem away.
 */
async function fetchTransactions(
  conn: Connection,
  signatures: string[],
): Promise<(Awaited<ReturnType<Connection["getTransaction"]>> | null)[]> {
  const opts = { commitment: "confirmed" as const, maxSupportedTransactionVersion: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out: (Awaited<ReturnType<Connection["getTransaction"]>> | null)[] = [];
      for (let i = 0; i < signatures.length; i += 10) {
        out.push(...(await conn.getTransactions(signatures.slice(i, i + 10), opts)));
        if (i + 10 < signatures.length) await sleep(400);
      }
      return out;
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  // Sequential, slowly. Slower than the batch but it is the difference between a report and an "I
  // could not tell", and a monitor's job is to have an answer.
  const out: (Awaited<ReturnType<Connection["getTransaction"]>> | null)[] = [];
  for (const sig of signatures) {
    let got: Awaited<ReturnType<Connection["getTransaction"]>> | null = null;
    for (let attempt = 0; attempt < 3 && got === null; attempt++) {
      try {
        got = await conn.getTransaction(sig, opts);
      } catch {
        await sleep(800 * (attempt + 1));
      }
    }
    out.push(got);
    await sleep(250);
  }
  return out;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  // A throwaway keypair: this script must never be able to sign anything. Anchor wants a wallet to
  // build a Program, and handing it the operator's real key would make a read-only tool capable of
  // sending if a future edit slipped.
  const program = new Program(
    loadIdl() as Idl,
    new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" }),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await (program.account as any).configAccount.fetch(pda("config"));

  const budget = BigInt(cfg.instantRedeemBudgetUsdc.toString());
  const windowSecs = BigInt(cfg.instantRedeemWindowSeconds.toString());
  const now = BigInt(Math.floor(Date.now() / 1000));
  const decision = rollWindow(
    now,
    BigInt(cfg.instantWindowStart.toString()),
    windowSecs,
    BigInt(cfg.instantUsedUsdc.toString()),
    BigInt(cfg.instantUsedPrevUsdc.toString()),
  );
  const usedPct = budget === 0n ? 0 : Number((decision.effectiveUsed * 10000n) / budget) / 100;
  const remaining = budget > decision.effectiveUsed ? budget - decision.effectiveUsed : 0n;

  const usdcMint = new PublicKey(cfg.usdcMint);
  const treasuryAta = getAssociatedTokenAddressSync(usdcMint, pda("treasury"), true, TOKEN_PROGRAM_ID);
  const treasury = await getAccount(conn, treasuryAta, "confirmed", TOKEN_PROGRAM_ID).then(
    (a) => a.amount,
    () => 0n,
  );

  // ---- the events, for WHO. The budget number cannot tell an inventory drain from ordinary users.
  const coder = new BorshCoder(loadIdl() as Idl);
  const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, { limit: SCAN_LIMIT }, "confirmed");
  type Redeem = { sig: string; user: string; amountSilv: bigint; amountUsdc: bigint; feeUsdc: bigint; premiumBps: number; blockTime: number | null };
  const redeems: Redeem[] = [];
  const wanted = sigs.filter((s) => !s.err);
  const txs = await fetchTransactions(conn, wanted.map((s) => s.signature));
  for (const [idx, s] of wanted.entries()) {
    const tx = txs[idx];
    for (const line of tx?.meta?.logMessages ?? []) {
      const m = /^Program data: (.+)$/.exec(line);
      if (!m) continue;
      let ev;
      try {
        ev = coder.events.decode(m[1]);
      } catch {
        continue;
      }
      if (ev?.name !== "RedeemEvent" && ev?.name !== "redeem_event") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = ev.data as any;
      redeems.push({
        sig: s.signature,
        user: new PublicKey(d.user).toBase58(),
        amountSilv: BigInt(d.amountSilv?.toString() ?? d.amount_silv?.toString() ?? 0),
        amountUsdc: BigInt(d.amountUsdc?.toString() ?? d.amount_usdc?.toString() ?? 0),
        feeUsdc: BigInt(d.feeUsdc?.toString() ?? d.fee_usdc?.toString() ?? 0),
        premiumBps: Number(d.premiumBpsUsed ?? d.premium_bps_used ?? 0),
        blockTime: s.blockTime ?? null,
      });
    }
  }

  const routingOn = cfg.feeRoutingDisabled === false;
  const outflow = (r: Redeem) => (routingOn ? r.amountUsdc + r.feeUsdc : r.amountUsdc);
  const inventory = new PublicKey(cfg.inventoryWallet).toBase58();

  // ---------------------------------------------------------------- findings
  const findings: Finding[] = [];
  if (usedPct >= BUDGET_ALERT_PCT) {
    findings.push({
      level: "alert",
      what: `${usedPct.toFixed(2)}% of the rolling redeem budget is consumed (threshold ${BUDGET_ALERT_PCT}%)`,
    });
  }
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_MIN * 60;
  const recent = redeems.filter((r) => (r.blockTime ?? 0) >= cutoff);
  const aged = redeems.length - recent.length;
  for (const r of recent) {
    const share = budget === 0n ? 0 : Number((outflow(r) * 10000n) / budget) / 100;
    if (share >= SINGLE_ALERT_PCT) {
      findings.push({
        level: "alert",
        what: `a single redemption moved ${Number(outflow(r)) / 1e6} USDC, ${share.toFixed(2)}% of the budget, by ${r.user}`,
      });
    }
    // THE D11 THREAT, named explicitly. The inventory wallet holds the pre-mint and can redeem it
    // itself with no admin instruction and no timelock. Any redemption from that address is the
    // scenario the whole decision rests on, at ANY size.
    if (r.user === inventory) {
      findings.push({
        level: "alert",
        what: `the INVENTORY WALLET redeemed (${Number(outflow(r)) / 1e6} USDC, tx ${r.sig}). This is the D11 scenario.`,
      });
    }
  }
  if (cfg.paused) {
    findings.push({ level: "note", what: "the protocol is PAUSED, so nothing can redeem right now" });
  }
  if (!routingOn) {
    findings.push({
      level: "note",
      what: "fee routing is DISABLED, so the treasury pays only the user's leg; outflow is computed on that basis",
    });
  }
  if (Number(cfg.treasuryMinFloatUsdc) === 0) {
    findings.push({
      level: "note",
      what: "treasury_min_float_usdc is 0 (decision D5), so no floor stops a withdrawal emptying the redemption buffer",
    });
  }

  const report = {
    cluster: RPC_SAFE,
    program: PROGRAM_ID.toBase58(),
    checkedAt: new Date().toISOString(),
    paused: cfg.paused,
    budgetUsdc: Number(budget) / 1e6,
    windowSeconds: Number(windowSecs),
    effectiveUsedUsdc: Number(decision.effectiveUsed) / 1e6,
    remainingUsdc: Number(remaining) / 1e6,
    usedPct,
    adversarialBoundUsdc: Number(adversarialBound(budget)) / 1e6,
    treasuryUsdc: Number(treasury) / 1e6,
    feeRoutingOn: routingOn,
    inventoryWallet: inventory,
    redeemsScanned: redeems.length,
    signaturesScanned: sigs.length,
    redeems: redeems.map((r) => ({
      sig: r.sig,
      user: r.user,
      oz: Number(r.amountSilv) / 1e6,
      usdcToUser: Number(r.amountUsdc) / 1e6,
      feeUsdc: Number(r.feeUsdc) / 1e6,
      treasuryOutflowUsdc: Number(outflow(r)) / 1e6,
      premiumBps: r.premiumBps,
      at: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null,
    })),
    findings,
    verdict: findings.some((f) => f.level === "alert") ? "ALERT" : "QUIET",
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("redeem monitor");
    console.log(`  cluster : ${RPC_SAFE}`);
    console.log(`  paused  : ${cfg.paused}`);
    console.log(
      `  budget  : ${report.effectiveUsedUsdc} / ${report.budgetUsdc} USDC used (${usedPct.toFixed(2)}%) over ${report.windowSeconds}s`,
    );
    console.log(
      `  the REAL bound on a drain over one window is ~${report.adversarialBoundUsdc} USDC, not ${report.budgetUsdc}: the` +
        ` sliding counter admits close to 2x across a boundary`,
    );
    console.log(`  treasury: ${report.treasuryUsdc} USDC | fee routing ${routingOn ? "ON" : "OFF"}`);
    console.log(
      `  scanned : ${sigs.length} signatures, found ${redeems.length} RedeemEvent(s), ` +
        `${recent.length} inside the ${LOOKBACK_MIN}-minute judging window` +
        (aged > 0 ? ` (${aged} older, listed but not judged)` : ""),
    );
    for (const r of report.redeems) {
      console.log(
        `    ${r.at ?? "?"}  ${r.oz} oz -> ${r.usdcToUser} USDC (fee ${r.feeUsdc}, ${r.premiumBps}bps) by ${r.user}`,
      );
    }
    console.log("");
    if (findings.length === 0) console.log("  nothing to report.");
    for (const f of findings) console.log(`  ${f.level === "alert" ? "ALERT" : "note "}: ${f.what}`);
    console.log(`\n  VERDICT: ${report.verdict}`);
  }

  const alertTexts = findings.filter((f) => f.level === "alert").map((f) => f.what);
  let deliveryFailed = false;

  // The webhook stays supported for Slack/Discord, but it is no longer the only channel: it was never
  // configured, so every alert this monitor raised for a week reached a human only as a red CI badge.
  const hook = process.env.REDEEM_MONITOR_WEBHOOK;
  if (hook && report.verdict === "ALERT") {
    try {
      const r = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertPayload(report)),
      });
      console.log(`  webhook: HTTP ${r.status}`);
      // A 2xx is the only thing that means delivered. Slack and Discord both answer 4xx with a body
      // explaining the rejection, and swallowing that would leave a channel that looks configured and
      // delivers nothing.
      if (!r.ok) {
        console.error(`  webhook REJECTED the payload: ${(await r.text()).slice(0, 200)}`);
        deliveryFailed = true;
      }
    } catch (e) {
      // A failed webhook must NOT turn an alert into a pass, and must not hide the alert either.
      console.error(`  webhook FAILED: ${String(e).slice(0, 140)}`);
      deliveryFailed = true;
    }
  }

  // Telegram, on transitions only. `--json` is for a machine, so it never sends.
  if (!JSON_OUT) {
    const tr = diffAlerts(alertTexts);
    console.log(
      `  transitions: ${tr.fresh.length} new, ${tr.reminders.length} reminder(s), ${tr.resolved.length} resolved`,
    );
    const tg = telegramFromEnv();
    const send = async (text: string): Promise<void> => {
      if (!tg) {
        console.error("  TELEGRAM NOT CONFIGURED: this message reached nobody.");
        deliveryFailed = true;
        return;
      }
      if (await sendTelegram(tg, text)) console.log("  telegram: delivered");
      else deliveryFailed = true;
    };
    const foot = `treasury ${report.treasuryUsdc} USDC | budget ${usedPct.toFixed(1)}% of ${report.budgetUsdc} used`;
    if (tr.fresh.length > 0 || tr.reminders.length > 0) {
      await send(
        [
          "DOMINION REDEEM ALERT",
          "",
          ...tr.fresh.map((a) => `- ${a}`),
          ...tr.reminders.map((r) => `- STILL OPEN ${r.hoursOpen.toFixed(0)}h: ${r.text}`),
          "",
          foot,
          "",
          "This alarm does not pause anything: pausing needs a guardian or admin signature.",
        ].join("\n"),
      );
    }
    if (tr.resolved.length > 0) {
      await send(["DOMINION REDEEM RESOLVED", "", ...tr.resolved.map((a) => `- no longer true: ${a}`), "", foot].join("\n"));
    }
    if (tr.quiet && alertTexts.length > 0) {
      console.log(`  nothing to send: ${alertTexts.length} alert(s) open but unchanged since the last run.`);
    }
    await pingHeartbeat();
  }

  if (deliveryFailed) {
    console.error("  EXIT 1: an alert could not be delivered.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  // Non-zero, never 0: "the monitor could not tell" must not read as "nothing is wrong". This is the one
  // remaining meaning of a red run, which is what makes a red run worth reading again.
  console.error("MONITOR ERROR (this is not an all-clear):", e.message || e);
  process.exit(1);
});
