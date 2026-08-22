import { defineConfig } from "vitest/config";

// Pure unit tests (Lazer ed25519 assembly with synthetic messages). No network,
// no DOM, no live Pyth service.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
