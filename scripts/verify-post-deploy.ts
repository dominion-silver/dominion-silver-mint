/**
 * Assert that the DEPLOYED frontends read MAINNET, by comparing them against the chain.
 *
 * WHY IT EXISTS. On 2026-08-13 both frontends displayed devnet figures on production, and nothing
 * anywhere said so. The public app showed "Max instant now: $0.2" and the admin console showed
 * `TREASURY USDC $20.00`, `SILV SUPPLY 8,000.3463 oz`, `MAX 100,000 oz`, `MINT PREMIUM 1.50%`. Every
 * one of those is a real number, correctly rendered, read from the devnet deployment: the program id
 * is the SAME on both clusters, so a wrong RPC produces a page that looks healthy and lies.
 *
 * Two independent causes, both configuration and neither visible in a diff:
 *   public project  NEXT_PUBLIC_HELIUS_RPC absent            -> APP_RPC falls back to DEVNET_RPC
 *   admin project   NEXT_PUBLIC_HELIUS_RPC = devnet.helius…  -> devnet, explicitly
 * `NEXT_PUBLIC_*` is inlined at BUILD time, so fixing the variable changes nothing until a rebuild.
 *
 * So the check that matters is not "does the page render" but "does the deployed bundle resolve to the
 * same cluster and the same accounts the chain has". This reads BOTH and compares. It sends nothing.
 *
 * It is deliberately mechanical: the expectations live in code, not in an operator's judgement, so a
 * deploy that is still wrong cannot be waved through by someone reading a screenshot at 14:55.
 *
 * Run: DOMINION_RPC=<mainnet> npx tsx scripts/verify-post-deploy.ts
 *      SITE_PASSWORD=... to also exercise the gated /api/lazer price route.
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { redactRpc } from "./_redact";

const RPC = process.env.DOMINION_RPC;
const PUBLIC_URL = process.env.PUBLIC_URL || "https://app.dominion.market";
const ADMIN_URL = process.env.ADMIN_URL || "https://admin-iota-roan.vercel.app";

/** The MAINNET identities. Hardcoded on purpose: a check that derives its expectations from the same
 *  place as the thing under test cannot fail. */
const EXPECT = {
  cluster: "mainnet-beta",
  silvMint: "SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  lazerTreasury: "Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak",
  programId: "3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ",
  /** The devnet values, which must be ABSENT from a mainnet bundle. */
  devnetSilvMints: [
    "CebhMovXRM5hEhFDTyq7Y1ez8h11UzFSGjELbyQeJExv",
    "G5zez3JWETJMfG3hnCQbdPm7usXMnmKUpajdGJYB5JFF",
  ],
  devnetUsdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` -> ${detail}` : ""}`);
  cond ? pass++ : fail++;
}

/** Fetch every JS chunk the page references, plus the HTML, so an inlined constant cannot hide in a
 *  lazily-loaded chunk. That is how the original bug was found and how it must be confirmed gone. */
async function fetchBundle(url: string, cookie?: string): Promise<string | null> {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const html = await res.text();
  const paths = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9._/-]+\.js/g)].map((m) => m[0]))];
  const chunks = await Promise.all(
    paths.map((p) => fetch(new URL(p, url).toString(), { headers }).then((r) => (r.ok ? r.text() : "")).catch(() => "")),
  );
  return html + chunks.join("");
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("DOMINION_RPC must be set to the MAINNET endpoint");
  console.log("post-deploy verification");
  console.log(`  chain  : ${redactRpc(RPC)}`);
  console.log(`  public : ${PUBLIC_URL}`);
  console.log(`  admin  : ${ADMIN_URL}`);
  console.log("");

  // ---- 1. THE CHAIN, which is the reference every UI figure is checked against -------------
  const conn = new Connection(RPC, "finalized");
  const program = new Program(
    loadIdl() as Idl,
    new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "finalized" }),
  );
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cfg: any = await (program.account as any).configAccount.fetch(configPda);
  const mintInfo = await conn.getParsedAccountInfo(new PublicKey(String(cfg.silvMint)), "finalized");
  const supplyOz = Number((mintInfo.value as any).data.parsed.info.supply) / 1e6;
  const treasuryUsdc =
    Number((await conn.getTokenAccountBalance(new PublicKey(String(cfg.usdcTreasury)), "finalized")).value.amount) / 1e6;

  console.log("== 1. the chain ==");
  ok("config.silv_mint is the mainnet mint", String(cfg.silvMint) === EXPECT.silvMint, String(cfg.silvMint));
  ok("not paused", cfg.paused === false);
  ok("redemptions enabled", cfg.redemptionsEnabled === true);
  console.log(`  supply ${supplyOz.toLocaleString("en-US")} oz | cap ${(Number(cfg.maxSilvSupply) / 1e6).toLocaleString("en-US")} oz`);
  console.log(`  treasury ${treasuryUsdc} USDC | premiums ${Number(cfg.premiumBpsMint)}/${Number(cfg.premiumBpsRedeem)} bps`);

  // ---- 2. /api/health, the whole reason that route exists ----------------------------------
  console.log("\n== 2. the deployed configuration, via /api/health ==");
  const health = await fetch(`${PUBLIC_URL}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!health || (health as any).error) {
    ok(
      "/api/health answers",
      false,
      `got ${JSON.stringify(health)}. A 401 here means the deployed build predates the route, i.e. the ` +
        `merge has not reached production yet.`,
    );
  } else {
    const h = health as Record<string, unknown>;
    ok("cluster is mainnet-beta", h.cluster === EXPECT.cluster, String(h.cluster));
    ok("NOT on a public fallback RPC", h.onPublicFallbackRpc === false, String(h.rpcHost));
    ok("the RPC carries a credential", h.rpcHasCredential === true);
    ok("programId matches", h.programId === EXPECT.programId, String(h.programId));
    ok("silvMint is the mainnet mint", h.silvMint === EXPECT.silvMint, String(h.silvMint));
    ok("usdcMint is mainnet Circle USDC", h.usdcMint === EXPECT.usdcMint, String(h.usdcMint));
    ok("lazerTreasury is the mainnet treasury", h.lazerTreasury === EXPECT.lazerTreasury, String(h.lazerTreasury));
  }

  // ---- 3. THE BUNDLES. /api/health speaks for the server; this speaks for what the browser runs.
  // They can disagree: the route reads the same constants, but a stale CDN copy of a chunk would not.
  console.log("\n== 3. the bundles the browser actually downloads ==");
  const gateCookie = process.env.SITE_PASSWORD
    ? await fetch(`${PUBLIC_URL}/api/gate`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `password=${encodeURIComponent(process.env.SITE_PASSWORD)}`,
        redirect: "manual",
      })
        .then((r) => (r.headers.get("set-cookie") ?? "").match(/dominion_gate=[a-f0-9]+/)?.[0])
        .catch(() => undefined)
    : undefined;

  for (const [label, url, cookie] of [
    ["public", PUBLIC_URL, gateCookie],
    ["admin", ADMIN_URL, undefined],
  ] as Array<[string, string, string | undefined]>) {
    const bundle = await fetchBundle(url, cookie);
    if (!bundle) {
      ok(`${label}: bundle fetched`, false, "page did not load (gated without SITE_PASSWORD?)");
      continue;
    }
    ok(`${label}: carries the mainnet SILV mint`, bundle.includes(EXPECT.silvMint));
    ok(`${label}: carries mainnet USDC`, bundle.includes(EXPECT.usdcMint));
    for (const dm of EXPECT.devnetSilvMints) {
      ok(`${label}: no devnet SILV mint ${dm.slice(0, 8)}...`, !bundle.includes(dm));
    }
    ok(`${label}: no devnet USDC`, !bundle.includes(EXPECT.devnetUsdc));
    // NOT a check on `?cluster=devnet`, and the first version of this file had one. It failed on a
    // CORRECT mainnet deploy, because the string survives minification as the UNUSED branch of a
    // runtime ternary:
    //
    //     f = "devnet" === x ? "?cluster=devnet" : ""
    //
    // `x` is the resolved cluster and it is "mainnet-beta", so the suffix evaluates to "". Grepping a
    // bundle for a string proves the string is present, never that the branch containing it is taken.
    // The resolved cluster is a RUNTIME value and /api/health above is what reads it, so that is where
    // the assertion belongs. Left here as a comment so nobody re-adds the grep and then explains away
    // its red.
  }

  // ---- 4. the price route, which every priced operation depends on -------------------------
  console.log("\n== 4. the price proxy ==");
  if (!gateCookie) {
    console.log("  skipped: set SITE_PASSWORD to exercise the gated /api/lazer route");
  } else {
    const lz = await fetch(`${PUBLIC_URL}/api/lazer`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: gateCookie },
      body: "{}",
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const p = (lz as any)?.price;
    ok("/api/lazer returns a signed envelope", Boolean((lz as any)?.envelopeBase64));
    ok(
      "the publisher count meets the on-chain floor",
      Boolean(p) && Number(p.publisherCount) >= Number(cfg.minPublishers),
      p ? `${p.publisherCount} publishers, floor ${Number(cfg.minPublishers)}` : "no price",
    );
    if (p) console.log(`  price $${Number(p.priceUsd).toFixed(4)}/oz`);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail > 0) {
    console.log("A failure here means the deployed frontends do NOT agree with the chain.");
    console.log("Do NOT remove SITE_PASSWORD while this is red: every user mint would revert.");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nverify-post-deploy FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
