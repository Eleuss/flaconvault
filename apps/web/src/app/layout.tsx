import type { Metadata, Viewport } from "next";
import { Manrope, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });

export const metadata: Metadata = {
  title: { default: "FlaconVault", template: "%s · FlaconVault" },
  description: "Aus erster Hand versiegelt. Auf dem Zweitmarkt lesbar. NFC-Siegel, Indikatorkarte und Pass für hochwertige Parfümflakons.",
  manifest: "/manifest.webmanifest",
  applicationName: "FlaconVault",
  appleWebApp: { capable: true, title: "FlaconVault", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};
export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#fbfbf9" }, { media: "(prefers-color-scheme: dark)", color: "#121513" }],
  width: "device-width", initialScale: 1, viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de" className={`${manrope.variable} ${instrument.variable}`}>
      <body className="min-h-dvh flex flex-col font-sans text-[15px] leading-relaxed">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
