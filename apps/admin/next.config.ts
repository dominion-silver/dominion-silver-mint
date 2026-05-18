import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
              // Mirror apps/public: the admin app reads devnet on-chain state
              // via api.devnet.solana.com. Omitting it here was the root cause
              // of "Failed to load dashboard: TypeError: Failed to fetch" -
              // the browser CSP blocked the RPC call before it was sent.
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
