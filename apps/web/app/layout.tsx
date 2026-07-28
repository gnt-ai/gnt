import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// The site's actual body font (see globals.css's --font-mono) -- the
// OpenCode reference doc's own documented substitute for their paid,
// unlicensed-here Berkeley Mono. Self-hosted at build time, not a runtime
// Google Fonts request.
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://gntai.dev"),
  title: "gnt.ai",
  description: "The brain for AI companies. In your terminal.",
  openGraph: {
    type: "website",
    title: "gnt.ai",
    description: "The brain for AI companies. In your terminal.",
  },
  twitter: {
    card: "summary_large_image",
    title: "gnt.ai",
    description: "The brain for AI companies. In your terminal.",
  },
  verification: {
    google: "X9AdxjrlMn9JAJxcPMEBd9Dn3WoZIkBI3DKfBaOJtWc",
  },
};

// Sets data-theme on <html> before first paint -- a stored choice wins,
// otherwise falls back to the OS preference, defaulting to light only when
// neither says dark. Runs as a blocking inline script (not a deferred one)
// because it has to finish before the page paints; a regular script tag
// would flash the wrong theme for a frame. suppressHydrationWarning on
// <html> below is required because of this -- React's server-rendered
// markup never has the attribute this script adds client-side.
const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('gnt-theme');var t=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`h-full antialiased ${ibmPlexMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
