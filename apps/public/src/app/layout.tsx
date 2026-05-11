import "./globals.css";
import type { Metadata, Viewport } from "next";
import { WalletContextProvider } from "@/components/WalletProvider";
import { Toaster } from "@/components/Toaster";

export const metadata: Metadata = {
  title: "Dominion Silver",
  description: "Tokenized physical silver. 1 SILV = 1 troy ounce LBMA silver.",
};

// FE-L14: viewport + theme color so mobile browsers don't render desktop-zoomed.
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletContextProvider>
          {children}
          <Toaster />
        </WalletContextProvider>
      </body>
    </html>
  );
}
