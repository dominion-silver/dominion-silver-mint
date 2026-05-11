import "./globals.css";
import type { Metadata } from "next";
import { WalletContextProvider } from "@/components/WalletProvider";

export const metadata: Metadata = {
  title: "Dominion Silver - Admin",
  description: "Administrative console for Dominion Silver protocol. Squads-gated.",
  robots: "noindex, nofollow",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletContextProvider>{children}</WalletContextProvider>
      </body>
    </html>
  );
}
