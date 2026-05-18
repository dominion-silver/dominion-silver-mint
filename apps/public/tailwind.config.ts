import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Exact dominion.market/why-silv palette (measured from the DOM).
        bg: "#1a1a1a", // body background
        card: "#292929", // card / panel
        border: "#3b3b3b", // card border (used at /50 for the soft look)
        accent: "#4ade80", // green-400 (price, CTA, positive)
        accentDim: "#22c55e", // green-500 (hover/pressed)
        danger: "#ef4444",
        warning: "#f59e0b",
        muted: "#b0b0b0", // body / secondary text (neutral grey)
      },
      fontFamily: {
        // Inter = body; Space Grotesk = display + tabular numbers.
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-space-grotesk)", "system-ui", "sans-serif"],
        mono: ["var(--font-space-grotesk)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
