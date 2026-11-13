import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import { FleetAppearance } from "@/components/fleet-appearance";
import { FleetAnalytics } from "@/components/fleet-analytics";
import { initialThemeScript } from "@/lib/initial-theme";
import packageManifest from "../../package.json";
import "./globals.css";
import "@machdoch/product-ui/styles.css";
import "./fleet-shell.css";
import "./cloud/cloud.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "machdoch.cloud",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-accent="sky"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: initialThemeScript }} />
      </head>
      <body className={`${geistMono.variable} font-sans antialiased`}>
        <FleetAppearance />
        <FleetAnalytics version={packageManifest.version} />
        {children}
      </body>
    </html>
  );
}
