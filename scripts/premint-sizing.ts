/**
 * Convert a DOLLAR pre-mint budget into the exact ounce figure `admin_premint` takes, at the
 * live oracle price, and check it against the live cap. Read-only: it sends no transaction.
 *
 * The budget is denominated in DOLLARS while the cap and `admin_premint` are denominated in
 * OUNCES, so the ounce figure moves with the silver price. Decide it days in advance and you
 * end up either short of the target or over the cap: run this immediately before pre-minting.
 * It prints the atomic figure too, because `admin_premint` takes oz * 1e6 and an off-by-1e6
 * there is a 1,000,000x error that only surfaces as a failed transaction.
 *
 * Run: npx tsx scripts/premint-sizing.ts   (PREMINT_USD and DOMINION_RPC override the defaults)
 */
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { PROGRAM_ID } from "./_program-id";

const RPC = process.env.DOMINION_RPC || "https://api.devnet.solana.com";
// USD. The default is the launch plan: $6.75M pre-minted against a 150,000 oz cap.
const BUDGET_USD = Number(process.env.PREMINT_USD || 6_750_000);
// Metal.Index.SILVER/USD. Used only if the live config carries no feed id.
const FEED_FALLBACK = 3154;

function readApiKey(): string | null {
  if (process.env.PYTH_LAZER_API_KEY) return process.env.PYTH_LAZER_API_KEY;
  const p = path.join(__dirname, "..", "apps", "public", ".env.local");
  if (!fs.existsSync(p)) return null;
  return (/PYTH_LAZER_API_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(p, "utf8")) ?? [])[1] ?? null;
}

async function main() {
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

  const capOz = Number(cfg.maxSilvSupply) / 1e6;
  const premiumMintBps = Number(cfg.premiumBpsMint);
  const mintInfo = await getMint(
    conn,
    cfg.silvMint as PublicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  const supplyOz = Number(mintInfo.supply) / 1e6;

  const key = readApiKey();
  if (!key) throw new Error("no PYTH_LAZER_API_KEY: cannot price the budget");
  const r = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      priceFeedIds: [Number(cfg.pythLazerFeedId) || FEED_FALLBACK],
      properties: ["price", "exponent", "publisherCount"],
      chains: ["solana"],
      channel: "fixed_rate@1000ms",
    }),
  });
  if (!r.ok) throw new Error(`Lazer HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d: any = await r.json();
  const f = d.parsed.priceFeeds[0];
  const spot = Number(f.price) * Math.pow(10, Number(f.exponent));
  const mintPx = spot * (1 + premiumMintBps / 10_000);

  const ozAtSpot = BUDGET_USD / spot;
  const atomicAtSpot = Math.floor(ozAtSpot * 1e6);
  const ozAtMint = BUDGET_USD / mintPx;

  console.log("Pre-mint sizing");
  console.log("  cluster :", RPC.includes("mainnet") ? "MAINNET" : "devnet");
  console.log("  feed    :", Number(cfg.pythLazerFeedId), `(${f.publisherCount} publishers)`);
  console.log("  spot    :", `$${spot.toFixed(4)}/oz`);
  console.log("  mint px :", `$${mintPx.toFixed(4)}/oz  (spot +${premiumMintBps / 100}%)`);
  console.log();
  console.log(`  BUDGET $${BUDGET_USD.toLocaleString("en-US")}`);
  console.log(`    at SPOT      ${ozAtSpot.toFixed(4)} oz`);
  console.log(`      -> admin_premint(${atomicAtSpot})`);
  console.log(`    at MINT px   ${ozAtMint.toFixed(4)} oz`);
  console.log(`      -> admin_premint(${Math.floor(ozAtMint * 1e6)})`);
  console.log();

  // Cap arithmetic, which is the part that actually blocks a transaction.
  const headroomOz = capOz - supplyOz;
  const afterOz = supplyOz + ozAtSpot;
  console.log("  CAP CHECK");
  console.log(`    cap            ${capOz.toLocaleString("en-US")} oz`);
  console.log(`    already minted ${supplyOz.toLocaleString("en-US")} oz`);
  console.log(`    headroom now   ${headroomOz.toLocaleString("en-US")} oz`);
  if (afterOz > capOz) {
    console.log(
      `    FAIL: this pre-mint needs ${ozAtSpot.toFixed(0)} oz but only ` +
        `${headroomOz.toFixed(0)} oz remain. admin_premint would revert SupplyCapExceeded.`,
    );
    process.exitCode = 1;
  } else {
    const leftOz = capOz - afterOz;
    console.log(
      `    after this     ${afterOz.toLocaleString("en-US")} oz ` +
        `(${((afterOz / capOz) * 100).toFixed(1)}% of the cap)`,
    );
    console.log(
      `    LEFT for PUBLIC MINTS: ${leftOz.toFixed(0)} oz = ` +
        `$${(leftOz * mintPx).toLocaleString("en-US", { maximumFractionDigits: 0 })} of site sales`,
    );
    console.log(
      "    (mint_silv draws on the SAME cap, so this is a hard ceiling on site volume)",
    );
  }

  // The budget is in dollars and the cap is in ounces, so a price fall costs headroom.
  console.log("\n  IF SILVER MOVES BEFORE YOU PRE-MINT (same dollar budget)");
  for (const mv of [-30, -20, -10, 0, 10, 20]) {
    const p = spot * (1 + mv / 100);
    const oz = BUDGET_USD / p;
    const pct = ((supplyOz + oz) / capOz) * 100;
    const flag = supplyOz + oz > capOz ? "  <-- OVER THE CAP" : "";
    console.log(
      `    ${String(mv > 0 ? "+" + mv : mv).padStart(4)}%  $${p.toFixed(2)}/oz  ` +
        `${oz.toFixed(0)} oz  ${pct.toFixed(0)}% of cap${flag}`,
    );
  }
  console.log(
    "\n  Decide an OUNCE figure at ceremony time from this run, not a dollar figure",
  );
  console.log("  agreed days earlier: the cap is denominated in ounces.");
}

main().catch((e) => {
  console.error("sizing failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
