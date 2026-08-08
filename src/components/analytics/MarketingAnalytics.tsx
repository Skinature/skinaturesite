'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Script from 'next/script'
import {
  GA_MEASUREMENT_ID,
  ga4Enabled,
  initTrackers,
  metaPixelEnabled,
  trackPageView,
} from '@/lib/analytics'

/**
 * Loads the Meta Pixel + GA4 SDKs and reports a page view on every route
 * change.
 *
 * The route-change part is the whole reason this component exists. Meta's and
 * Google's copy-paste snippets assume a full page load per screen, so on the
 * App Router they fire exactly one PageView and then go silent as the customer
 * moves from the landing page to a product to the cart. Ad optimisation and
 * every funnel report would be built on that one event.
 *
 * `usePathname` is used deliberately in place of `useSearchParams`: reading
 * search params here would opt every page in the app out of static rendering.
 * Query strings are not meaningful navigation on this store.
 */
export default function MarketingAnalytics() {
  const pathname = usePathname()

  useEffect(() => {
    initTrackers()
    trackPageView(pathname)
  }, [pathname])

  return (
    <>
      {metaPixelEnabled() && (
        <Script
          id="meta-pixel-sdk"
          src="https://connect.facebook.net/en_US/fbevents.js"
          strategy="afterInteractive"
        />
      )}
      {ga4Enabled() && (
        <Script
          id="ga4-sdk"
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
      )}
      {metaPixelEnabled() && (
        // Fallback for visitors with JavaScript disabled. Meta expects it; it
        // costs one request and keeps the Events Manager setup check happy.
        <noscript>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            height="1"
            width="1"
            style={{ display: 'none' }}
            alt=""
            src={`https://www.facebook.com/tr?id=${process.env.NEXT_PUBLIC_META_PIXEL_ID}&ev=PageView&noscript=1`}
          />
        </noscript>
      )}
    </>
  )
}
