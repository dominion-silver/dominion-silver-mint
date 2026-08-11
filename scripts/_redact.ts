/**
 * Strip provider credentials out of an RPC endpoint before printing it.
 *
 * ITS OWN MODULE, and the reason is a measured mistake rather than tidiness. It lived in
 * redeem-monitor.ts, and that file runs `main()` at import time: the first script to import the helper
 * silently executed a whole monitor run, polluting its own output with a redemption report and spending
 * RPC calls nobody asked for. A pure function used by more than one caller does not belong inside a
 * script with side effects.
 *
 * WHY IT MATTERS AT ALL. Anything that prints an endpoint is a publication channel: a webhook posts to a
 * third party, and a GitHub Actions run on a public repository puts stdout in a world-readable log.
 * `DOMINION_RPC` for a paid provider carries the API key in its query string, so printing the raw
 * endpoint publishes the key.
 */
export function redactRpc(rpc: string): string {
  try {
    const u = new URL(rpc);
    // Drop the whole query string rather than allow-listing parameter names: the next provider's
    // `?token=` would walk straight through an allow-list.
    const hadSecret = [...u.searchParams.keys()].length > 0;
    u.search = "";
    // A key can also sit in the path, e.g. providers that use /<uuid>.
    const pathHidden = u.pathname.split("/").filter(Boolean).length > 0;
    u.pathname = "/";
    return u.origin + (hadSecret || pathHidden ? " (credentials redacted)" : "");
  } catch {
    // Unparseable: say nothing about it rather than echo a string that might be a secret.
    return "(unparseable endpoint, redacted)";
  }
}
