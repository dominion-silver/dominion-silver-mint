import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // dominion.market palette
        bg: "#0a0a0a",
        card: "#111111",
        border: "#222222",
        accent: "#22c55e", // green-500
        accentDim: "#16a34a",
        danger: "#ef4444",
        warning: "#f59e0b",
        muted: "#94a3b8",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["SF Mono", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
