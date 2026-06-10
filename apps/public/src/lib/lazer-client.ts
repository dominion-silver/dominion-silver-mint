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

/** Decode a hex string (optional 0x prefix) to bytes. Pure + testable. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
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
  const { envelopeHex } = (await resp.json()) as { envelopeHex: string };
  return hexToBytes(envelopeHex);
}
