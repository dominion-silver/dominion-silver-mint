// Server-side Pyth Lazer proxy. Holds the Pyth Starter API key (PYTH_LAZER_API_
// KEY, server-only env var) so it is NEVER shipped to the browser, fetches the
// latest SOLANA-targeted signed price message for the requested feed, and
// returns the raw envelope (hex) to the client, which assembles the ed25519 +
// dominion instructions (see src/lib/lazer-assembly.ts).
//
// STATUS: the request + response mapping is VERIFIED against the live API
// (2026-06-10): the ed25519-signed envelope is base64 at `solana.data`. Until
// PYTH_LAZER_API_KEY is set this returns 503 so the client can detect "Lazer
// not configured yet". NOTE: the key must have feed-group access to SILV (feed
// 3304 needs the `pyth-indices` group); a key without it gets 403 from Lazer.
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

  // Request shape per the Pyth Lazer latest_price API (verified live 2026-06-10).
  // The dominion parser needs price + exponent + publisherCount + confidence +
  // feedUpdateTimestamp on the SOLANA chain at the fixed_rate@1000ms channel.
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
      { error: "lazer_unreachable", message: String(e).slice(0, 500) },
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
  // The live response carries the ed25519-signed SolanaMessage envelope base64-
  // encoded at solana.data (solana.encoding === "base64"). The client decodes
  // it to the dominion ix's message_data arg (see lazer-client.ts).
  const solana = data?.solana;
  if (
    !solana ||
    solana.encoding !== "base64" ||
    typeof solana.data !== "string" ||
    solana.data.length === 0
  ) {
    // Bounded diagnostic only (never echo an unbounded third-party blob).
    return NextResponse.json(
      { error: "lazer_no_solana_message", raw: JSON.stringify(data).slice(0, 500) },
      { status: 502 },
    );
  }

  return NextResponse.json({ envelopeBase64: solana.data });
}
