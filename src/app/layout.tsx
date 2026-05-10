import type { Metadata } from "next";
import "./globals.css";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/themes";

export const metadata: Metadata = {
  title: "Studio",
  description: "Real-time audio mixer / AU plugin host",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The bootstrap script runs before React hydrates so the saved theme is
    // applied to <html data-theme="..."> on the first paint. Without it the
    // app would briefly flash the default theme before the client store mounts
    // and reapplies the user's choice.
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="h-full bg-background text-foreground">{children}</body>
    </html>
  );
}
