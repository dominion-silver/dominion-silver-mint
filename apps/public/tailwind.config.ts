import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // dominion.market, measured out of the live DOM on 2026-08-11 with getComputedStyle
        // rather than eyeballed from a screenshot.
        // THIS REPLACES AN OLDER PALETTE THAT CLAIMED THE SAME PROVENANCE. The previous values
        // (#1a1a1a body, #4ade80 green accent) carried the comment "Exact dominion.market/why-silv
        // palette (measured from the DOM)" and were correct when written. The site has since been
        // rebranded: darker ground, a serif display face, and a periwinkle accent instead of green.
        bg: "#0B0C0E", // body background            rgb(11,12,14)
        card: "#15161A", // panels and pills          hsl(228 11% 9%)
        border: "#232427", // hairlines               rgb(35,36,39)
        fg: "#F4F5F7", // headings                    rgb(244,245,247)
        accent: "#8BADDA", // price, CTA, links       hsl(214 52% 70%)
        accentDim: "#6E93C4", // hover / pressed, and the gradient's darkest stop
        accentLift: "#C9DAF3", // the gradient's lightest stop
        silver: "#8C8C8C", // the brand's neutral     hsl(0 0% 55%)
        muted: "#C7CBD2", // body / secondary text    rgb(199,203,210)
        subtle: "#6E727B", // hints, captions         rgb(110,114,123)
        // Kept deliberately: these are SEMANTIC, not brand. The site defines no error or warning
        // colour, and turning a failure notice periwinkle would remove the only signal that
        // distinguishes it from ordinary copy.
        danger: "#ef4444",
        warning: "#f59e0b",
      },
      fontFamily: {
        // Jost for everything the user reads and every number, which is what the site does: its
        // live price is Jost 700, not the serif.
        sans: ["var(--font-jost)", "system-ui", "sans-serif"],
        // Cormorant Garamond is the display face. Reserved for the brand wordmark and the page
        // title: at 13px with the site's tracking it becomes hard to read, and a dapp is mostly
        // small labels.
        display: ["var(--font-cormorant)", "Georgia", "serif"],
        // JetBrains Mono, which the site also loads, for addresses and signatures.
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
      },
      letterSpacing: {
        // The site's display tracking: 15.36px at a 64px h1 is 0.24em.
        brand: "0.24em",
      },
      backgroundImage: {
        // The "Buy SILV" button, stop for stop.
        cta: "linear-gradient(#C9DAF3 0%, #8BADDA 50%, #6E93C4 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
