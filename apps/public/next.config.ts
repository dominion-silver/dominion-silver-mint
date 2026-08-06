import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // CODEX P3-01: pin the file-tracing root to this app so Next does not
  // warn/guess a workspace root from the multiple lockfiles in the repo
  // (apps/public + apps/admin each have their own). Deterministic builds.
  outputFileTracingRoot: path.join(__dirname),
  // The comment here described a jito-ts workaround for @pythnetwork/pyth-solana-receiver, a dependency
  // removed on 2026-08-06 with the retired Core oracle path (audit P-06). The `fs: false` fallback below
  // is unrelated and still needed by the wallet adapters, so only the explanation was stale.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
  // Allow npm packages with mixed CJS/ESM to work in Next.
  transpilePackages: [],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // wallet adapters need unsafe-eval; tighten post-Phase-1
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              // FE-C4 + M14: tighten wss: from ANY-host to specific RPC providers
              // and Hermes. Wildcards on the *.helius/*.triton subdomain trees
              // since both rotate subdomains for region/sharding.
              [
                "connect-src 'self'",
                "https://*.helius.xyz wss://*.helius.xyz",
                "https://*.helius-rpc.com wss://*.helius-rpc.com",
                "https://*.triton.one wss://*.triton.one",
                "https://api.mainnet-beta.solana.com wss://api.mainnet-beta.solana.com",
                "https://api.devnet.solana.com wss://api.devnet.solana.com",
                "https://api.testnet.solana.com wss://api.testnet.solana.com",
                // REVIEW-OF-FIXES P2: `https://hermes.pyth.network` was allowlisted here for the
                // retired Pyth Core path. Nothing calls it: the price comes from the same-origin
                // /api/lazer proxy, and the Hermes client was removed from package.json. An unnecessary
                // connect-src entry is a standing permission for an upstream we no longer trust or use.
              ].join(" "),
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
