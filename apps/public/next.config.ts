import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // CODEX P3-01: pin the file-tracing root to this app so Next does not
  // warn/guess a workspace root from the multiple lockfiles in the repo
  // (apps/public + apps/admin each have their own). Deterministic builds.
  outputFileTracingRoot: path.join(__dirname),
  // Workaround: jito-ts (transitively pulled by @pythnetwork/pyth-solana-receiver)
  // has a stale rpc-websockets import path that breaks Next.js webpack 5.
  // We don't actually use jito here; mark these as externals so they don't
  // get bundled. Pyth posting falls back to Hermes-only path.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
  // Allow npm packages with mixed CJS/ESM to work in Next.
  transpilePackages: ["@pythnetwork/pyth-solana-receiver"],
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
                "https://hermes.pyth.network",
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
