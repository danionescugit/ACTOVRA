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
  title: "ACTOVRA — Where AI Decisions Become Controlled Actions",
  description: "Controlled execution for AI-driven commerce. Where AI decisions become controlled actions — AI needs a mandate, not a blank check.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        {/* Next.js 16 Client Bootstrap Guard: Ensures document.currentScript is never null during async chunk execution */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                if (typeof document !== 'undefined') {
                  try {
                    var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'currentScript') ||
                               Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'currentScript');
                    Object.defineProperty(document, 'currentScript', {
                      get: function() {
                        var real = desc && desc.get ? desc.get.call(document) : null;
                        if (real) return real;
                        var scripts = document.querySelectorAll('script[src*="/_next/"]');
                        if (scripts.length > 0) return scripts[scripts.length - 1];
                        var allScripts = document.getElementsByTagName('script');
                        return allScripts.length > 0 ? allScripts[allScripts.length - 1] : null;
                      },
                      configurable: true
                    });
                  } catch (e) {}
                }
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
