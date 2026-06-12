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
 * arg; see `lazerMessageData` / `assembleLazerTx` in lazer-assembly.ts). Throws
 * `LazerNotConfiguredError` while the proxy has no key.
 */
export async function fetchLazerEnvelope(feedId?: number): Promise<Uint8Array> {
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
  const { envelopeBase64 } = (await resp.json()) as { envelopeBase64: string };
  return base64ToBytes(envelopeBase64);
}
