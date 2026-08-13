import { defineConfig } from "vitest/config";

// Minimal unit-test setup. The suite is pure (offline ix encode/decode against
// the bundled IDL via the real @coral-xyz/anchor coder); no network, no DOM.
//
// ROUND 8 T8-06: `inventory-wallet-actions.test.ts` imports the ACTIONS catalog out of
// `components/AdminActions.tsx`, because the criterion is to traverse the descriptor the panel
// actually renders rather than a copy of it. The app's tsconfig sets `jsx: "preserve"` for Next, so
// esbuild would hand raw JSX to the parser and the import fails before a single test runs. Naming the
// transform here is what makes that import loadable; nothing in the suite renders a component.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
