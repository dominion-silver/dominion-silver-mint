// Client glue: fetch the signed Lazer envelope from the same-origin proxy
// (/api/lazer, which holds the API key server-side). The ed25519 + dominion
// assembly (lazer-assembly.ts) is done by the caller AFTER it builds the
// dominion instruction (the offsets must reference that ix's serialized data).
// Only the fetch is key-gated (the proxy returns 503 until Mark's Pyth Starter
// key is provisioned).

/** Thrown when the Lazer proxy has no API key yet (HTTP 503). */
export class LazerNotConfiguredError extends Error {
  constructor() {
    super("Pyth Lazer is not configured yet (no API key).");
    this.name = "LazerNotConfiguredError";
  }
}

/** Decode a base64 string to bytes (browser-safe via atob). Pure + testable. */
export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length === 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
    throw new Error("invalid base64");
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Fetch the latest signed Lazer envelope for `feedId` via the same-origin proxy.
 * Returns the raw SolanaMessage envelope bytes (the dominion ix's `message_data`
 * arg) AND the parsed `priceUsd` FROM THE SAME Lazer response - so the caller can
 * compute `min_out` off the EXACT price the contract will price this mint/redeem
 * at (the envelope's price), not a stale polled quote. That alignment is what
 * prevents the SlippageExceeded revert when the feed moves between the price poll
 * and the mint. Throws `LazerNotConfiguredError` while the proxy has no key.
 */
export async function fetchLazerEnvelope(
  feedId?: number,
): Promise<{ envelope: Uint8Array; priceUsd: number | null }> {
  const resp = await fetch("/api/lazer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(feedId != null ? { feedId } : {}),
  });
  if (resp.status === 503) throw new LazerNotConfiguredError();
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Lazer proxy ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const { envelopeBase64, price } = (await resp.json()) as {
    envelopeBase64: string;
    price: { priceUsd: number } | null;
  };
  return { envelope: base64ToBytes(envelopeBase64), priceUsd: price?.priceUsd ?? null };
}
