/**
 * Assert that the DEPLOYED frontend, the LOCAL source and the ON-CHAIN config all
 * agree on which Pyth Lazer feed to price from.
 *
 * WHY THIS EXISTS. `oracle.rs` calls `extract_feed_price(payload,
 * config.pyth_lazer_feed_id, LAZER_CHANNEL_ID)`, which SEARCHES the signed envelope
 * for that exact feed id. If the frontend fetches an envelope for feed A while the
 * config expects feed B, the feed is simply not found in the payload and EVERY priced
 * operation reverts. Mint and redeem both die, and the error says nothing about a feed
 * mismatch.
 *
 * That makes a feed migration a two-sided change with an ordering hazard: the on-chain
 * switch is 24h-timelocked, but a Vercel deploy is instant. Ship the frontend early and
 * you break mint for the whole timelock window; ship it late and you break mint from the
 * moment the switch executes until you deploy.
 *
 * The safe sequence, which `execute_set_pyth_feed`'s auto-pause is designed for:
 *   1. execute_set_pyth_feed  (the program AUTO-PAUSES, so nothing can mint in the gap)
 *   2. verify the config with scripts/read-config.ts
 *   3. deploy the frontend
 *   4. run THIS script: all three sources must agree
 *   5. unpause
 *
 * Run:
 *   npx tsx scripts/verify-oracle-sync.ts
 *   FRONTEND_URL=http://localhost:3101 npx tsx scripts/verify-oracle-sync.ts
 */
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { PROGRAM_ID } from "./_program-id";

const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";
const FRONTEND = process.env.FRONTEND_URL || "https://dominion-silver.vercel.app";
// Mirrors lazer.rs. The envelope framing is documented in lazer-assembly.ts:
//   magic u32 (SOLANA_FORMAT_MAGIC) | signature 64 | pubkey 32 | payload_len u16 | payload
// and the payload itself is:
//   magic u32 (PAYLOAD_FORMAT_MAGIC) | timestamp u64 | channel u8 | num_feeds u8 | feed_id u32
const SOLANA_FORMAT_MAGIC = 2_182_742_457;
const PAYLOAD_FORMAT_MAGIC = 2_479_346_549;
const PAYLOAD_OFFSET = 4 + 64 + 32 + 2;

let fail = 0;
function ok(cond: boolean, msg: string, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? ` -> ${detail}` : ""}`);
  if (!cond) fail++;
}

/**
 * Recover the feed id from a signed Lazer envelope by locating the payload magic and
 * reading the first feed id after it.
 *
 * Done by scanning for the magic rather than assuming a fixed signature/pubkey prefix
 * length, so this keeps working if Lazer changes the envelope framing. Returns null if
 * the magic is absent, in which case the caller falls back to price comparison.
 */
function feedIdFromEnvelope(b64: string): number | null {
  const buf = Buffer.from(b64, "base64");

  // Preferred: walk the documented framing exactly.
  if (buf.length >= PAYLOAD_OFFSET + 18 && buf.readUInt32LE(0) === SOLANA_FORMAT_MAGIC) {
    const p = PAYLOAD_OFFSET;
    if (buf.readUInt32LE(p) === PAYLOAD_FORMAT_MAGIC) {
      // magic u32 | timestamp u64 | channel u8 | num_feeds u8 | feed_id u32
      return buf.readUInt32LE(p + 4 + 8 + 1 + 1);
    }
  }

  // Fallback: scan for the payload magic, in case Lazer changes the outer framing.
  for (let i = 0; i + 18 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== PAYLOAD_FORMAT_MAGIC) continue;
    return buf.readUInt32LE(i + 4 + 8 + 1 + 1);
  }
  return null;
}

/**
 * Last-resort identification: compare the served price against each candidate feed's
 * live price and pick the closest.
 *
 * This exists because the FIRST version of this script skipped its own most important
 * check when the envelope parse failed, which is precisely the fail-open class this
 * repo has been stamping out. The deployed-vs-chain comparison must always produce a
 * verdict, so if the bytes cannot be parsed the price is used instead. The two silver
 * feeds differ by a structural 5%, so at that spread this is unambiguous.
 */
async function feedIdFromPrice(
  servedUsd: number,
  candidates: number[],
): Promise<{ feed: number; deltaPct: number } | null> {
  const envPath = path.join(__dirname, "..", "apps", "public", ".env.local");
  const key =
    process.env.PYTH_LAZER_API_KEY ||
    (fs.existsSync(envPath)
      ? (/PYTH_LAZER_API_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(envPath, "utf8")) ?? [])[1]
      : undefined);
  if (!key) return null;
  let best: { feed: number; deltaPct: number } | null = null;
  for (const feed of candidates) {
    try {
      const r = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          priceFeedIds: [feed],
          properties: ["price", "exponent"],
          chains: ["solana"],
          channel: "fixed_rate@1000ms",
        }),
      });
      if (!r.ok) continue;
      const d: any = await r.json();
      const f = d?.parsed?.priceFeeds?.[0];
      if (!f) continue;
      const px = Number(f.price) * Math.pow(10, Number(f.exponent));
      const deltaPct = Math.abs((servedUsd - px) / px) * 100;
      if (!best || deltaPct < best.deltaPct) best = { feed, deltaPct };
    } catch {
      /* try the next candidate */
    }
  }
  return best;
}

async function main() {
  console.log("Oracle feed sync check");
  console.log("  rpc:      ", RPC);
  console.log("  frontend: ", FRONTEND);
  console.log("  program:  ", PROGRAM_ID.toBase58(), "\n");

  // --- 1. ON-CHAIN: the authority. This is what the program will demand.
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
  const onChain = Number(cfg.pythLazerFeedId);
  const pendingFeed = cfg.pendingPythFeedNonce;
  console.log(`  ON-CHAIN config.pyth_lazer_feed_id = ${onChain}`);
  if (pendingFeed) {
    console.log(
      `  NOTE: a feed change is PENDING (timelock nonce ${pendingFeed.toString()}).`,
    );
    console.log("        Until it executes, the frontend must keep serving the OLD feed.");
  }

  // --- 2. LOCAL SOURCE: what the next deploy would ship.
  const constants = fs.readFileSync(
    path.join(__dirname, "..", "apps", "public", "src", "lib", "constants.ts"),
    "utf8",
  );
  const mConst = /LAZER_SILV_FEED_ID\s*=\s*(\d+)/.exec(constants);
  const route = fs.readFileSync(
    path.join(__dirname, "..", "apps", "public", "src", "app", "api", "lazer", "route.ts"),
    "utf8",
  );
  const mRoute = /const SILV_FEED_ID\s*=\s*(\d+)/.exec(route);
  const localConst = mConst ? Number(mConst[1]) : null;
  const localRoute = mRoute ? Number(mRoute[1]) : null;
  console.log(`  LOCAL  constants.ts LAZER_SILV_FEED_ID = ${localConst}`);
  console.log(`  LOCAL  api/lazer route SILV_FEED_ID    = ${localRoute}`);

  // --- 3. DEPLOYED FRONTEND: what users are actually getting right now.
  let deployed: number | null = null;
  let deployedPrice: number | null = null;
  try {
    const r = await fetch(`${FRONTEND}/api/lazer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      ok(false, `the deployed frontend's /api/lazer returned HTTP ${r.status}`, body.slice(0, 160));
      if (r.status === 503) {
        console.log("        503 = PYTH_LAZER_API_KEY is not set in that deployment.");
      }
      if (r.status === 403 || /not entitled/i.test(body)) {
        console.log(
          "        403 / not entitled = the PRODUCTION key lacks the feed's entitlement",
        );
        console.log("        group. Feed 3154 needs `pyth-indices`.");
      }
    } else {
      const d: any = await r.json();
      deployedPrice = d?.price?.priceUsd ?? null;
      deployed = d?.envelopeBase64 ? feedIdFromEnvelope(d.envelopeBase64) : null;
      console.log(
        `  DEPLOYED frontend serves feed ${deployed ?? "unknown"}` +
          (deployedPrice !== null ? ` at $${deployedPrice.toFixed(4)}/oz` : ""),
      );
    }
  } catch (e) {
    ok(false, "could not reach the deployed frontend", String(e).slice(0, 120));
  }

  console.log("\n  VERDICT");
  // The check that matters: the DEPLOYED frontend must match the CHAIN. A mismatch
  // means every priced operation reverts, with an error that does not mention feeds.
  let identifiedBy = "envelope bytes";
  if (deployed === null && deployedPrice !== null) {
    // Never skip this check. See feedIdFromPrice.
    const candidates = Array.from(
      new Set([onChain, localConst, localRoute].filter((n): n is number => !!n)),
    );
    const guess = await feedIdFromPrice(deployedPrice, candidates);
    if (guess) {
      deployed = guess.feed;
      identifiedBy = `price match, ${guess.deltaPct.toFixed(3)}% off feed ${guess.feed}`;
    }
  }
  if (deployed !== null) {
    ok(
      deployed === onChain,
      `the DEPLOYED frontend and the ON-CHAIN config agree (via ${identifiedBy})`,
      `frontend ${deployed} vs chain ${onChain}`,
    );
    if (deployed !== onChain) {
      console.log("        Every mint and redeem would REVERT: extract_feed_price cannot");
      console.log("        find the chain's feed id inside the frontend's envelope.");
    }
  } else {
    ok(false, "could NOT determine which feed the deployed frontend serves");
    console.log("        Refusing to report OK on an unknown state.");
  }

  // Local source vs chain: a MISMATCH here is expected and correct while a feed change
  // is pending, and a problem once it has executed.
  if (localConst !== null && localRoute !== null) {
    ok(localConst === localRoute, "both local frontend sources agree with each other");
    if (localConst !== onChain) {
      if (pendingFeed) {
        console.log(
          `  ok    local source (${localConst}) differs from chain (${onChain}), which is`,
        );
        console.log("        CORRECT: the switch is timelocked and not executed yet.");
        console.log("        DO NOT DEPLOY the frontend until it has.");
      } else {
        ok(
          false,
          "local source differs from the chain and NO feed change is pending",
          `local ${localConst} vs chain ${onChain}`,
        );
        console.log("        Either deploy the frontend, or propose the on-chain change.");
      }
    } else {
      ok(true, "local source matches the chain", String(onChain));
    }
  }

  console.log();
  if (fail > 0) {
    console.log(`ORACLE SYNC BROKEN: ${fail} problem(s). Priced operations may revert.`);
    process.exit(1);
  }
  console.log("ORACLE SYNC OK.");
}

main().catch((e) => {
  console.error("sync check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
