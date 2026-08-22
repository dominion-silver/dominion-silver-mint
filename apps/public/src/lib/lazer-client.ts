// Client glue: fetch the signed Lazer envelope from the same-origin proxy
// (/api/lazer, which holds the API key server-side). The ed25519 + dominion
// assembly (lazer-assembly.ts) is done by the caller AFTER it builds the
// dominion instruction (the offsets must reference that ix's serialized data).
// Only the fetch is key-gated (the proxy returns 503 until Pyth Starter
// key is provisioned).

/** Thrown when the Lazer proxy has no API key yet (HTTP 503). */
export class LazerNotConfiguredError extends Error {
  constructor() {
    super("Pyth Lazer is not configured yet (no API key).");
    this.name = "LazerNotConfiguredError";
  }
}

// There was a `LazerPriceAlreadyClaimedError` here, for a 409 the proxy no longer sends.
// The proxy briefly REFUSED a contended print; a showed that turned an unauthenticated
// endpoint into a free denial of the whole mint and redeem UI, so contention is now advisory and every
// caller is served. `contended` on the response is the signal, and losing a race costs one Lazer verify
// fee rather than costing everyone the product. See the note on `claimFresh` in api/lazer/route.ts.

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
  /**
   * CLAIM a print for submission. REQUIRED on the submit path: the program demands a STRICTLY increasing
   * feed timestamp, so one envelope prices exactly one operation, and an envelope shared with another
   * signer means the second transaction is refused after the verify fee is paid.
   * this used to mean only "skip the proxy cache", which was not the same guarantee. The
   * proxy now also marks the response `contended` when another submitter was handed the same print
   * first. It never refuses: see the note above. The price banner leaves this false.
   */
  fresh = false,
): Promise<{ envelope: Uint8Array; priceUsd: number | null; contended: boolean }> {
  const resp = await fetch("/api/lazer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(feedId != null ? { feedId } : {}), ...(fresh ? { fresh: true } : {}) }),
  });
  if (resp.status === 503) throw new LazerNotConfiguredError();
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Lazer proxy ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const { envelopeBase64, price, contended } = (await resp.json()) as {
    envelopeBase64: string;
    price: { priceUsd: number } | null;
    contended?: boolean;
  };
  // `contended === true` means another submitter was handed this exact print first, so this transaction
  // is racing and the loser is refused LazerReplayed after paying the verify fee. Absent on the banner
  // path, where it is meaningless; defaults to false so a caller that ignores it behaves as before.
  return {
    envelope: base64ToBytes(envelopeBase64),
    priceUsd: price?.priceUsd ?? null,
    contended: contended === true,
  };
}
