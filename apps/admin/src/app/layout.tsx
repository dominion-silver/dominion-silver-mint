import "./globals.css";
import type { Metadata } from "next";
import { Cormorant_Garamond, JetBrains_Mono, Jost } from "next/font/google";
import { WalletContextProvider } from "@/components/WalletProvider";

// THE THREE FACES apps/public LOADS, and this file loaded none of them. The console fell back to the
// system stack, which is why it read as a different product from the app it administers rather than
// merely as a different section of it. Same three faces, same variable names, so a component copied
// between the two apps behaves identically.
// THROUGH next/font, not a stylesheet link. The marketing site pulls these from
// fonts.googleapis.com; doing that here would need `font-src` and `style-src` opened in the CSP, and
// a design change has no business touching what the console is allowed to connect to. next/font
// downloads them at build time and serves them from our own origin.
const jost = Jost({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jost",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-cormorant",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Dominion Silver - Admin",
  description: "Administrative console for Dominion Silver protocol. Squads-gated.",
  // Keep. An operator console has no reason to be indexed.
  robots: "noindex, nofollow",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${jost.variable} ${cormorant.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans">
        <WalletContextProvider>{children}</WalletContextProvider>
      </body>
    </html>
  );
}
