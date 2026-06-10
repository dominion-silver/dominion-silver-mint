// Server-side Pyth Lazer proxy. Holds the Pyth Starter API key (PYTH_LAZER_API_
// KEY, server-only env var) so it is NEVER shipped to the browser, fetches the
// latest SOLANA-targeted signed price message for the requested feed, and
// returns the raw envelope (hex) to the client, which assembles the ed25519 +
// dominion instructions (see src/lib/lazer-assembly.ts).
//
// STATUS: scaffold. The key-from-env + same-origin-proxy + never-expose-the-key
// shape is final; the exact Lazer request/response field mapping is marked
// VERIFY-AGAINST-LIVE and must be confirmed once Mark provisions the key (the
// service cannot be exercised without it). Until the key is set this returns
// 503 so the client can detect "Lazer not configured yet".
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAZER_ENDPOINT = "https://pyth-lazer.dourolabs.app/v1/latest_price";
const SILV_FEED_ID = 3304;

export async function POST(req: NextRequest) {
  const apiKey = process.env.PYTH_LAZER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "lazer_not_configured", message: "Pyth Lazer API key not set." },
      { status: 503 },
    );
  }

  let feedId = SILV_FEED_ID;
  try {
    const body = await req.json().catch(() => ({}));
    // Validate: a positive integer feed id only (prevents using this same-origin
    // route to spend the server-held key's quota on junk/float/negative feeds).
    if (
      typeof body?.feedId === "number" &&
      Number.isInteger(body.feedId) &&
      body.feedId > 0
    ) {
      feedId = body.feedId;
    }
  } catch {
    /* default feed */
  }

  // VERIFY-AGAINST-LIVE: request shape per the Pyth Lazer latest_price API. The
  // dominion parser needs Price + Exponent + PublisherCount + Confidence +
  // FeedUpdateTimestamp on the SOLANA chain at the fixed_rate@1000ms channel.
  const lazerReq = {
    priceFeedIds: [feedId],
    properties: [
      "price",
      "exponent",
      "publisherCount",
      "confidence",
      "feedUpdateTimestamp",
    ],
    chains: ["solana"],
    channel: "fixed_rate@1000ms",
  };

  let resp: Response;
  try {
    resp = await fetch(LAZER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(lazerReq),
      // The key never leaves this server route.
      cache: "no-store",
    });
  } catch (e) {
    return NextResponse.json(
      { error: "lazer_unreachable", message: String(e) },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return NextResponse.json(
      { error: "lazer_error", status: resp.status, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  const data = await resp.json().catch(() => null);
  // VERIFY-AGAINST-LIVE: extract the Solana signed-message envelope (hex). The
  // exact JSON path depends on the live response; the known shape is an array
  // of per-chain updates carrying a hex `data` for the `solana` evm/ed25519
  // encoding. Adjust this single accessor once the live response is seen.
  const envelopeHex: string | undefined =
    data?.solanaSignedMessage ??
    data?.[0]?.solana?.encoding?.hex ??
    data?.evm?.data;

  if (!envelopeHex) {
    // Bounded diagnostic only (do not echo an unbounded third-party blob to the
    // browser); the exact accessor is VERIFY-AGAINST-LIVE.
    return NextResponse.json(
      { error: "lazer_no_solana_message", raw: JSON.stringify(data).slice(0, 500) },
      { status: 502 },
    );
  }

  return NextResponse.json({ envelopeHex });
}
