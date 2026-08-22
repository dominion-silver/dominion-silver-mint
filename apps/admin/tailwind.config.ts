import type { Config } from "tailwindcss";

const config: Config = {
  // RECURSIVE, and the `/**/` is load-bearing. I broke this while rewriting the file: to read the two
  // configs side by side I stripped comments with a regex, `/\*.*?\*/` under DOTALL, which ATE the
  // `/**/` in `./src/**/*` and left `./src*`. That glob matches files literally named `src<something>`
  // at the app root, so it matched nothing, Tailwind emitted "No utility classes were detected", and the
  // console rendered with globals.css only: the logo at its natural 500px and no layout at all.
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // THE SAME PALETTE apps/public CARRIES, and this file previously did not.
        // It held `bg: #0a0a0a`, `accent: #22c55e` (green-500) under the comment "dominion.market
        // palette". That was true when written and became false when the site was rebranded: darker
        // ground, a display serif, and a periwinkle accent instead of green. apps/public was updated
        // on 2026-08-11 from getComputedStyle against the live DOM; this console was not, so the two
        // halves of the same product looked like two products, and the console looked like the older
        // one. Values copied from apps/public/tailwind.config.ts rather than re-measured, so there is
        // one source and drift shows up as a diff between two files instead of a mismatch on screen.
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
        // UNCHANGED, and deliberately so. These are SEMANTIC, not brand: this console's whole job is
        // showing an operator when something is wrong, and `REDEMPTIONS DISABLED` in periwinkle would
        // be indistinguishable from ordinary copy. The brand has no failure colour, so these stay.
        danger: "#ef4444",
        warning: "#f59e0b",
      },
      fontFamily: {
        // Jost for everything read and every number, which is what the site does: its live price is
        // Jost 700, not the serif. This console had no webfont at all and fell back to the system
        // stack, which is the single biggest reason it did not look like the same product.
        sans: ["var(--font-jost)", "system-ui", "sans-serif"],
        // Cormorant Garamond, the display face, reserved for the wordmark. At 13px with the brand
        // tracking it stops being readable, and this console is almost entirely small labels over
        // numbers, so it earns its keep in exactly one place.
        display: ["var(--font-cormorant)", "Georgia", "serif"],
        // JetBrains Mono for addresses, signatures and tabular figures.
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
