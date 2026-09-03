import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Lato, Pinyon_Script } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import SmoothScroll from "@/components/layout/SmoothScroll";
import CartHydration from "@/components/cart/CartHydration";
import MarketingAnalytics from "@/components/analytics/MarketingAnalytics";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { SITE_NAME, SITE_TAGLINE, SITE_DESCRIPTION, SITE_URL } from "@/lib/data";
import { GA_MEASUREMENT_ID, ga4Enabled } from "@/lib/analytics";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-serif",
  display: "swap",
});

const lato = Lato({
  subsets: ["latin"],
  weight: ["100", "300", "400", "700", "900"],
  variable: "--font-sans",
  display: "swap",
});

const pinyon = Pinyon_Script({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-cursive",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1A3C34",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} | ${SITE_TAGLINE} | Premium Natural Skincare`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "natural skincare",
    "botanical skincare",
    "organic skincare",
    "Skinature",
    "premium skincare",
    "chemical free skincare",
    "cruelty free skincare",
    "lab tested skincare",
    "clean beauty",
    "plant-based skincare",
    "conscious beauty",
    "nurtured by nature",
    "Indian skincare brand",
    "gender neutral skincare",
    "safe for kids skincare",
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} | ${SITE_TAGLINE} | Premium Natural Skincare`,
    description: SITE_DESCRIPTION,
    // 1200x630 is the ratio WhatsApp / Instagram DMs / Twitter / LinkedIn expect.
    // The old square logo.png was cropped or letterboxed in every link preview.
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: `${SITE_NAME}, ${SITE_TAGLINE} — clean botanical skincare and haircare`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} | ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: ["/og-image.png"],
  },
  icons: {
    icon: "/favicon.png",
  },
  alternates: {
    canonical: SITE_URL,
  },
  verification: {
    other: {
      "facebook-domain-verification": "7nvnvkh7hbmm1f8hlgl9ex01pnq34a",
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${cormorant.variable} ${lato.variable} ${pinyon.variable}`}>
      <head>
        {ga4Enabled() && (
          <>
            {/* Establish Google's queue before React hydrates. The previous
                effect-only bootstrap could load gtag.js without ever creating
                dataLayer/gtag, leaving GA4 at zero events. */}
            <Script
              id="ga4-bootstrap"
              strategy="beforeInteractive"
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};window.gtag('js',new Date());window.gtag('config',${JSON.stringify(GA_MEASUREMENT_ID)},{send_page_view:false});`,
              }}
            />
            <Script
              id="ga4-sdk"
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
              strategy="beforeInteractive"
            />
          </>
        )}
      </head>
      <body className="antialiased bg-cream text-forest-900 font-sans selection:bg-forest-100 selection:text-forest-900">
        <CartHydration />
        <SmoothScroll>
          {children}
        </SmoothScroll>
        {/* Meta Pixel + GA4 (each no-ops without its id); Vercel visitor stats
            and Core Web Vitals. */}
        <MarketingAnalytics />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
