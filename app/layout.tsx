import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Gig Workers Universe Internal Dashboard",
  // Browser tab icon.
  //
  // The reliable route in the App Router is a file named app/icon.png - Next
  // detects it by convention and emits the <link> tags itself. A file in
  // public/ only works if the name and extension match exactly, which is the
  // usual reason a favicon silently fails to appear.
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png" },
      { url: "/favicon.ico" },
    ],
    apple: "/icon.png",
  },
  description: "Internal operations dashboard",
};

// Force dynamic rendering for every route under this layout.
//
// Without it, app/page.tsx ('use client', no data fetching on the server) is
// prerendered to static HTML and served straight from the CDN. Static assets
// bypass the SSR compute entirely, so proxy.ts never runs for '/' and a
// signed-out visitor still receives the full dashboard shell. Its API calls
// then 401, which looks like a broken page rather than a login redirect.
//
// This is defence in depth alongside the client-side gate in page.tsx: the
// gate handles it if this is ever removed, and this handles it before any
// HTML reaches an unauthenticated browser.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}