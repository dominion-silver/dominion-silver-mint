import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, JetBrains_Mono, Jost } from "next/font/google";
import { WalletContextProvider } from "@/components/WalletProvider";
import { Toaster } from "@/components/Toaster";

// dominion.market's three faces, read out of its font stylesheet: Jost for UI and numbers,
// Cormorant Garamond for display, JetBrains Mono for addresses.
//
// LOADED THROUGH next/font ON PURPOSE. The site itself pulls these from fonts.googleapis.com;
// doing that here would need `font-src`/`style-src` opened in the CSP in next.config.ts, and the
// brief for this change was design only, nothing touching connections. next/font downloads and
// SELF-HOSTS the files at build time, so the browser makes no third-party request and the CSP is
// untouched.
const jost = Jost({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-jost",
  display: "swap",
});
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Dominion Silver",
  description: "Tokenized physical silver. 1 SILV = 1 troy ounce LBMA silver.",
};

// FE-L14: viewport + theme color so mobile browsers don't render desktop-zoomed.
export const viewport: Viewport = {
  themeColor: "#0b0c0e",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${jost.variable} ${cormorant.variable} ${jetbrainsMono.variable}`}
    >
      <body className="font-sans">
        <WalletContextProvider>
          {children}
          <Toaster />
        </WalletContextProvider>
      </body>
    </html>
  );
}
