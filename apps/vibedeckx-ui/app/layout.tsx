import type { Metadata } from "next";
import localFont from "next/font/local";
import { ClientProviders } from "@/components/auth/client-providers";
import { ThemedToaster } from "@/components/auth/themed-toaster";
import { CHUNK_RECOVERY_SCRIPT } from "@/lib/chunk-recovery";
import "./globals.css";

// Fonts are bundled (latin subset, from @fontsource) instead of loaded via
// next/font/google: the Google variant downloads CSS at build time, and when
// Google serves `/l/font?kit=…&skey=…` URLs Turbopack fails the build
// ("next/font/google queries have exactly one entry"). See app/fonts/README.md.
const geistSans = localFont({
  src: "./fonts/geist-latin-wght-normal.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin-wght-normal.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
});

const instrumentSerif = localFont({
  src: [
    { path: "./fonts/instrument-serif-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-instrument-serif",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-jetbrains-mono",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: "Vibedeckx — Mission control for your coding agents",
  description:
    "Drive a fleet of coding agents in parallel. Named workspaces, live status at a glance, completion alerts, and cross-environment runs — from any device. Cloud-hosted or self-host.",
};

// Sync, blocking script that runs before hydration to apply the saved theme
// class on <html>. Without it React's first paint would be light-mode while
// the saved preference is dark, causing a one-frame flash.
const THEME_INIT_SCRIPT = `(() => {
  try {
    var stored = localStorage.getItem('vibedeckx-theme');
    var theme = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    var resolved = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    var root = document.documentElement;
    if (resolved === 'dark') root.classList.add('dark');
    root.style.colorScheme = resolved;
  } catch (e) {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Before any chunk loads, so a chunk that never arrives is still recoverable. */}
        <script dangerouslySetInnerHTML={{ __html: CHUNK_RECOVERY_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} antialiased`}
      >
        <ClientProviders>
          {children}
          <ThemedToaster />
        </ClientProviders>
      </body>
    </html>
  );
}
