import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { BRAND } from "@/config/brand";
import { Providers } from "@/components/providers";
import { themeInitScript } from "@/lib/client/theme";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: `${BRAND.name} — GST compliance workspace for CA firms`, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: "#0f3d56" }, { media: "(prefers-color-scheme: dark)", color: "#07131a" }] };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
      <body className="min-h-full">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
