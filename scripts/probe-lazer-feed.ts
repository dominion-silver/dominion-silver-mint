/**
 * Probe a live Pyth Lazer feed and evaluate it against the EXACT guards the program
 * applies, without touching the chain.
 *
 * Why this exists: the oracle path is dormant while public mint and redemptions are
 * both closed, so there is no on-chain way to find out whether the live feed would
 * actually satisfy the policy. That question has to be answered BEFORE opening the
 * mint, not after, because the guards fail CLOSED: a feed that does not satisfy them
 * makes every priced operation revert.
 *
 * It answers, with real data:
 *   - what is the price, and is it inside the configured band
 *   - HOW MANY PUBLISHERS is the aggregate actually backed by (the operational
 *     question, since MIN_PUBLISHERS_FLOOR_HARD = 2 is enforced in code and cannot
 *     be configured below 2)
 *   - is the confidence interval tight enough
 *   - is the print fresh, non-carried-forward, and not future-dated
 *
 * Run:
 *   npx tsx scripts/probe-lazer-feed.ts               # SILV (3304) with the live config's guards
 *   LAZER_FEED_ID=3154 npx tsx scripts/probe-lazer-feed.ts
 *
 * Reads PYTH_LAZER_API_KEY from apps/public/.env.local (server-only key, never
 * printed). Reads the live guard values from the deployed config so the verdict is
 * against what is actually deployed, not against defaults.
 */
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { PROGRAM_ID } from "./_program-id";

const LAZER_ENDPOINT = "https://pyth-lazer.dourolabs.app/v1/latest_price";
const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";

/** Mirrors lazer_price.rs. Enforced in code as max(config.min_publishers, this). */
const MIN_PUBLISHERS_FLOOR_HARD = 2;
/** Mirrors oracle.rs PRICE_SCALE. */
const PRICE_SCALE = 9;

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` -> ${detail}` : ""}`);
  cond ? pass++ : fail++;
}

function readApiKey(): string {
  if (process.env.PYTH_LAZER_API_KEY) return process.env.PYTH_LAZER_API_KEY;
  const envPath = path.join(__dirname, "..", "apps", "public", ".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `no PYTH_LAZER_API_KEY in the environment and ${envPath} does not exist`,
    );
  }
  const m = /PYTH_LAZER_API_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(envPath, "utf8"));
  if (!m) throw new Error(`PYTH_LAZER_API_KEY not found in ${envPath}`);
  return m[1];
}

async function main() {
  const feedId = Number(process.env.LAZER_FEED_ID || 0);
  const conn = new Connection(RPC, "confirmed");
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "dominion_silver_mint.json"),
      "utf8",
    ),
  ) as Idl;
  const program = new Program(
    idl,
    new AnchorProvider(conn, new Wallet(Keypair.generate()), {}),
  );
  const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const cfg: any = await (program.account as any).configAccount.fetch(cfgPda);

  const targetFeed = feedId || cfg.pythLazerFeedId;
  console.log("Pyth Lazer feed probe");
  console.log("  program:", PROGRAM_ID.toBase58());
  console.log("  feed id:", targetFeed, feedId ? "(override)" : "(from the live config)");
  console.log("  guards, read from the DEPLOYED config:");
  console.log("    min_publishers        ", cfg.minPublishers, `(code floor ${MIN_PUBLISHERS_FLOOR_HARD})`);
  console.log("    max_staleness_seconds ", cfg.maxStalenessSeconds);
  console.log("    max_confidence_bps    ", cfg.maxConfidenceBps);
  console.log(
    "    price band            ",
    `$${Number(cfg.minPriceUsdScaled) / 1e9} .. $${Number(cfg.maxPriceUsdScaled) / 1e9}`,
  );
  console.log();

  const resp = await fetch(LAZER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${readApiKey()}`,
    },
    body: JSON.stringify({
      priceFeedIds: [targetFeed],
      properties: [
        "price",
        "exponent",
        "publisherCount",
        "confidence",
        "feedUpdateTimestamp",
      ],
      chains: ["solana"],
      channel: "fixed_rate@1000ms",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.log(`  FAIL  Lazer returned HTTP ${resp.status}`);
    if (resp.status === 403) {
      console.log(
        "        403 usually means the key lacks feed-group access. Feed 3304 needs",
      );
      console.log("        the `pyth-indices` group on the Pyth plan.");
    }
    console.log("        body:", body.slice(0, 300));
    process.exit(1);
  }

  const data: any = await resp.json();
  const parsed = data?.parsed?.priceFeeds?.[0] ?? data?.parsed?.[0];
  const solanaMsg = data?.solana?.data;
  ok("Lazer returned a SOLANA-signed envelope", Boolean(solanaMsg));
  if (!parsed) {
    console.log("  FAIL  no parsed price feed in the response");
    console.log("        raw:", JSON.stringify(data).slice(0, 400));
    process.exit(1);
  }

  const price = BigInt(parsed.price);
  const exponent = Number(parsed.exponent);
  const publishers = Number(parsed.publisherCount);
  const confidence = BigInt(parsed.confidence ?? 0);
  const feedTsUs = BigInt(parsed.feedUpdateTimestamp ?? 0);
  const nowUs = BigInt(Date.now()) * 1000n;

  // Normalize to the program's 1e9 scale, the same way lazer_price.rs does.
  const combinedExp = PRICE_SCALE + exponent;
  const scaled =
    combinedExp >= 0
      ? price * 10n ** BigInt(combinedExp)
      : price / 10n ** BigInt(-combinedExp);
  const usd = Number(scaled) / 1e9;

  console.log("\n  LIVE FEED DATA");
  console.log("    price            ", `$${usd.toFixed(4)} / oz`, `(raw ${price}, exp ${exponent})`);
  console.log("    publisherCount   ", publishers);
  console.log("    confidence       ", confidence.toString());
  console.log(
    "    age              ",
    `${Number(nowUs - feedTsUs) / 1e6}s`,
  );
  console.log();

  console.log("  POLICY EVALUATION (the exact guards in lazer_price.rs)");
  ok("price is positive", price > 0n);

  // THE question: the code enforces max(config.min_publishers, HARD_FLOOR), so the
  // effective requirement can never drop below 2 without a program upgrade.
  const effectiveMin = Math.max(Number(cfg.minPublishers), MIN_PUBLISHERS_FLOOR_HARD);
  ok(
    `publisherCount >= the EFFECTIVE floor (${effectiveMin})`,
    publishers >= effectiveMin,
    `${publishers} publishers`,
  );
  if (publishers === effectiveMin) {
    console.log(
      "        NOTE: exactly at the floor. One publisher dropping out halts every",
    );
    console.log("        priced operation. No margin.");
  }

  const confBps =
    price > 0n ? Number((confidence * 10_000n) / price) : Number.MAX_SAFE_INTEGER;
  ok(
    `confidence within max_confidence_bps (${cfg.maxConfidenceBps})`,
    confBps <= Number(cfg.maxConfidenceBps),
    `${confBps} bps`,
  );

  const ageS = Number(nowUs - feedTsUs) / 1e6;
  ok(
    `fresher than max_staleness_seconds (${cfg.maxStalenessSeconds})`,
    ageS <= Number(cfg.maxStalenessSeconds),
    `${ageS.toFixed(2)}s old`,
  );
  ok("not future-dated", feedTsUs <= nowUs + 1_000_000n);

  const minP = BigInt(cfg.minPriceUsdScaled.toString());
  const maxP = BigInt(cfg.maxPriceUsdScaled.toString());
  ok(
    "price inside the configured band",
    scaled >= minP && scaled <= maxP,
    `$${usd.toFixed(2)} in $${Number(minP) / 1e9}..$${Number(maxP) / 1e9}`,
  );

  // What the user would actually pay / receive at this price.
  const mintPx = (usd * (10_000 + Number(cfg.premiumBpsMint))) / 10_000;
  const redeemPx = (usd * (10_000 - Number(cfg.premiumBpsRedeem))) / 10_000;
  console.log("\n  EFFECTIVE USER PRICING AT THIS ORACLE PRICE");
  console.log(`    mint   1 SILV costs  $${mintPx.toFixed(4)}  (oracle +${Number(cfg.premiumBpsMint) / 100}%)`);
  console.log(`    redeem 1 SILV pays   $${redeemPx.toFixed(4)}  (oracle -${Number(cfg.premiumBpsRedeem) / 100}%)`);
  console.log(`    round-trip spread    ${(((mintPx - redeemPx) / usd) * 100).toFixed(2)}%`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log("This feed would make every priced operation REVERT. Do not open the mint.");
    process.exit(1);
  }
  console.log("This feed currently satisfies every on-chain guard.");
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
