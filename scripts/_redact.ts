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

/**
 * Describe an endpoint that could not be parsed, without echoing it.
 *
 * `classifyCluster` used to put the raw value in its error via JSON.stringify, on the reasonable
 * assumption that an unparseable string cannot be a working endpoint. It can still CONTAIN a working
 * credential: one typo in the scheme, `htp://mainnet.helius-rpc.com/?api-key=<real key>`, fails to parse
 * and carries the live key into the error text. So the diagnostic keeps only what helps find a typo, the
 * scheme and host shape, and drops everything from the first `?` or the path onward.
 */
export function describeUnparseable(rpc: string): string {
  const head = rpc.split("?")[0].split("#")[0];
  const parts = head.split("/");
  // scheme + "" + host, when the shape is scheme://host; otherwise just the leading fragment.
  const shape = parts.length >= 3 ? `${parts[0]}//${parts[2]}` : parts[0];
  return `${JSON.stringify(shape.slice(0, 60))} (${rpc.length} chars, remainder withheld: it may carry a key)`;
}
