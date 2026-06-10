import { defineConfig } from "vitest/config";

// Minimal unit-test setup. The suite is pure (offline ix encode/decode against
// the bundled IDL via the real @coral-xyz/anchor coder); no network, no DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
