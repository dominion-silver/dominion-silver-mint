import { NextResponse } from "next/server";
import { APP_RPC, CLUSTER, PROGRAM_ID, SILV_MINT, USDC_MINT, LAZER_SILV_FEED_ID, LAZER_TREASURY } from "@/lib/constants";

/**
 * What is this deployment actually pointed at?
 *
 * WHY IT EXISTS, and it is not a generic health check. An independent review found that production
 * `app.dominion.market` was reading the chain from `api.devnet.solana.com`, the hardcoded fallback,
 * because `NEXT_PUBLIC_HELIUS_RPC` is not set in Vercel. Confirmed by loading the live page and tallying
 * its requests: three to the public devnet endpoint. Nothing anywhere said so, and nothing could: the
 * value is inlined into a lazily-loaded client chunk, so it is not greppable from outside, and the
 * symptom on a devnet preview is that everything looks fine because the accounts exist and traffic is nil.
 *
 * TWO WAYS THAT BITES, the second being the launch-breaker:
 *  1. The public endpoint rate-limits. Under launch traffic the reads 429, and because anchor-client
 *     throws rather than returning null, the Reserves panel flips to "Offline" and the mint/redeem card
 *     disables.
 *  2. `CLUSTER` is DERIVED from the APP_RPC host (lib/constants.ts). So after runbook step 6c swaps
 *     PROGRAM_ID and SILV_MINT to mainnet, an unset Vercel variable means the app reads MAINNET accounts
 *     through a DEVNET endpoint: an empty panel, plus every explorer link stamped `?cluster=devnet`. It
 *     fails silently and looks like a deploy that simply has no data yet.
 *
 * So this route makes the resolved configuration READABLE from outside, which turns a silent
 * misconfiguration into one line of curl and one mechanical check in
 *
 * IT IS DELIBERATELY PUBLIC (added to the middleware's PUBLIC_PATHS) and leaks nothing: every value here
 * is already inlined into the client bundle that any visitor downloads. The RPC credential is the one
 * thing that must not appear, so the endpoint is reduced to its host and the query string is dropped
 * wholesale rather than by allow-listing parameter names.
 */
function rpcHostOnly(rpc: string): { host: string; hasCredential: boolean } {
  try {
    const u = new URL(rpc);
    return { host: u.host, hasCredential: [...u.searchParams.keys()].length > 0 };
  } catch {
    return { host: "unparseable", hasCredential: false };
  }
}

/** The endpoints that are fine for a preview and NOT fine for a launch: unauthenticated and shared. */
const PUBLIC_FALLBACK_HOSTS = ["api.devnet.solana.com", "api.mainnet-beta.solana.com", "api.testnet.solana.com"];

export function GET() {
  const rpc = rpcHostOnly(APP_RPC);
  const onPublicFallback = PUBLIC_FALLBACK_HOSTS.includes(rpc.host);
  return NextResponse.json(
    {
      cluster: CLUSTER,
      rpcHost: rpc.host,
      rpcHasCredential: rpc.hasCredential,
      // The whole point of the route. A launch on `true` is the failure described above.
      onPublicFallbackRpc: onPublicFallback,
      programId: PROGRAM_ID.toBase58(),
      silvMint: SILV_MINT.toBase58(),
      usdcMint: USDC_MINT.toBase58(),
      // ADDED 2026-08-12. This is the cutover constant with NO offline gate and, until now, no external
      // signal: verify-constants-consistency.sh never reads it, and it is consumed on the mint path
      // (lazer-tx.ts) where the program validates it against the Lazer Storage's own treasury field.
      // Left on the devnet value after a cutover, the panel looks healthy, the price banner works, and
      // EVERY user mint reverts. Exposing it here is the only way to check the deployed state from
      // outside, which is the argument this whole route was created on.
      lazerTreasury: LAZER_TREASURY.toBase58(),
      lazerFeedId: LAZER_SILV_FEED_ID,
    },
    // Never cached: the answer changes with a redeploy, and a cached answer would be worse than none.
    { headers: { "cache-control": "no-store" } },
  );
}
