import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { FleetAppearance } from "@/components/fleet-appearance";
import "./globals.css";
import "@machdoch/product-ui/styles.css";
import "./fleet-shell.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fleet Manager",
  description: "Machdoch Fleet Manager",
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
    <html lang="en" data-theme="dark" data-accent="sky">
      <body
        className={`${geist.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <FleetAppearance />
        {children}
      </body>
    </html>
  );
}
