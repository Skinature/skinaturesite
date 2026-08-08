/**
 * Marketing analytics: Meta Pixel + Google Analytics 4.
 *
 * Both are gated on their env var being present, exactly like Razorpay, email
 * and WhatsApp elsewhere in this codebase: with no id configured every helper
 * here is a silent no-op, so nothing breaks locally or before the client hands
 * over their ids.
 *
 * Every event is sent to BOTH platforms in the one call, so a call site never
 * has to know which trackers exist. Meta and GA4 name the same events
 * differently (ViewContent vs view_item, Purchase vs purchase), so the mapping
 * lives here and nowhere else.
 *
 * ⚠️ Money: Meta and GA4 both expect a decimal currency amount, NOT paise.
 * Everything in this app stores paise, so every value crossing this boundary
 * goes through `toRupees()`. Sending paise would report 100x the real revenue
 * and wreck Hina's ROAS numbers.
 */

export const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID ?? ''
export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? ''

export const metaPixelEnabled = () => META_PIXEL_ID.length > 0
export const ga4Enabled = () => GA_MEASUREMENT_ID.length > 0

const CURRENCY = 'INR'

/** The Pixel stub Meta's own snippet installs: callable, plus a replay queue. */
type Fbq = {
  (...args: unknown[]): void
  queue?: unknown[]
  callMethod?: (...args: unknown[]) => void
  push?: unknown
  loaded?: boolean
  version?: string
}

declare global {
  interface Window {
    fbq?: Fbq
    /** fbevents.js looks for this to recognise OUR stub as the active pixel. */
    _fbq?: Fbq
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
  }
}

/** Paise to rupees, rounded to 2dp (Meta rejects long floats). */
function toRupees(paise: number): number {
  return Math.round(paise) / 100
}

let initialised = false

/**
 * Installs the fbq/gtag queueing stubs and runs init/config.
 *
 * Deliberately done from our own module rather than from an inline <Script>:
 * both SDKs replay whatever was queued before they finished downloading, but
 * only in the order it was queued. If the inline snippet raced our first
 * PageView we could queue [PageView, init] and Meta would drop the event. By
 * owning the queue we guarantee [init, PageView] every time, and the <Script>
 * tags are then only responsible for fetching the SDK.
 *
 * Safe to call repeatedly: it runs once per page load.
 */
export function initTrackers() {
  if (typeof window === 'undefined' || initialised) return
  initialised = true

  if (metaPixelEnabled() && !window.fbq) {
    const stub: Fbq = function (this: unknown, ...args: unknown[]) {
      if (stub.callMethod) stub.callMethod.apply(this, args)
      else stub.queue?.push(args)
    }
    stub.queue = []
    stub.push = stub
    stub.loaded = true
    stub.version = '2.0'
    window.fbq = stub
    // REQUIRED, do not remove. fbevents.js uses window._fbq to recognise the
    // stub that queued the pending calls as its own. Without it, it reports
    // "Multiple pixels with conflicting versions were detected on this page"
    // and SILENTLY SENDS NOTHING: the pixel initialises, the instance exists,
    // and not one event beacon leaves the browser. Missing it cost a live
    // deploy that looked perfectly healthy while collecting zero data.
    // Only reproducible against a REAL pixel id, because an unregistered test
    // id never loads a config and so never hits the conflict path.
    if (!window._fbq) window._fbq = stub
    stub('init', META_PIXEL_ID)
  }

  if (ga4Enabled() && !window.gtag) {
    window.dataLayer = window.dataLayer || []
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer?.push(args)
    }
    window.gtag('js', new Date())
    // page_view is sent manually on every route change instead, because the
    // App Router navigates client-side and the automatic one fires only once.
    window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false })
  }
}

function meta(event: string, params?: Record<string, unknown>, options?: Record<string, unknown>) {
  if (typeof window === 'undefined' || !metaPixelEnabled()) return
  // The Pixel snippet installs a queueing stub synchronously, so calls made
  // before fbevents.js finishes downloading are replayed, not lost.
  window.fbq?.('track', event, params, options)
}

function ga(event: string, params?: Record<string, unknown>) {
  if (typeof window === 'undefined' || !ga4Enabled()) return
  // gtag() pushes into dataLayer, which likewise queues pre-load calls.
  window.gtag?.('event', event, params)
}

export interface TrackedProduct {
  id: string
  name: string
  pricePaise: number
  category?: string
}

export interface TrackedItem extends TrackedProduct {
  qty: number
}

/** GA4 wants an `items` array on every commerce event. */
function gaItems(items: TrackedItem[]) {
  return items.map((i) => ({
    item_id: i.id,
    item_name: i.name,
    item_category: i.category,
    price: toRupees(i.pricePaise),
    quantity: i.qty,
  }))
}

export function trackPageView(path: string) {
  meta('PageView')
  ga('page_view', { page_path: path, page_location: window.location.href })
}

export function trackViewContent(product: TrackedProduct) {
  meta('ViewContent', {
    content_ids: [product.id],
    content_type: 'product',
    content_name: product.name,
    content_category: product.category,
    value: toRupees(product.pricePaise),
    currency: CURRENCY,
  })
  ga('view_item', {
    currency: CURRENCY,
    value: toRupees(product.pricePaise),
    items: gaItems([{ ...product, qty: 1 }]),
  })
}

export function trackAddToCart(product: TrackedProduct, qty: number) {
  const value = toRupees(product.pricePaise * qty)
  meta('AddToCart', {
    content_ids: [product.id],
    content_type: 'product',
    content_name: product.name,
    value,
    currency: CURRENCY,
  })
  ga('add_to_cart', {
    currency: CURRENCY,
    value,
    items: gaItems([{ ...product, qty }]),
  })
}

export function trackInitiateCheckout(items: TrackedItem[], subtotalPaise: number) {
  meta('InitiateCheckout', {
    content_ids: items.map((i) => i.id),
    content_type: 'product',
    num_items: items.reduce((n, i) => n + i.qty, 0),
    value: toRupees(subtotalPaise),
    currency: CURRENCY,
  })
  ga('begin_checkout', {
    currency: CURRENCY,
    value: toRupees(subtotalPaise),
    items: gaItems(items),
  })
}

/**
 * The event that actually matters: it is what Meta optimises ad delivery
 * against and what reports revenue/ROAS back to the ads dashboard.
 *
 * Fired once per order. `orderNo` is passed as Meta's `eventID` so that when
 * the Conversions API is added later (server-side, from finalizePaidOrder),
 * Meta collapses the browser and server copies of the same purchase into one
 * instead of double-counting revenue. GA4 dedupes on `transaction_id` the
 * same way.
 */
export function trackPurchase(orderNo: string, items: TrackedItem[], totalPaise: number) {
  const value = toRupees(totalPaise)
  meta(
    'Purchase',
    {
      content_ids: items.map((i) => i.id),
      content_type: 'product',
      num_items: items.reduce((n, i) => n + i.qty, 0),
      value,
      currency: CURRENCY,
    },
    { eventID: orderNo }
  )
  ga('purchase', {
    transaction_id: orderNo,
    currency: CURRENCY,
    value,
    items: gaItems(items),
  })
}

/**
 * Guards against sending a duplicate Purchase when the customer refreshes or
 * revisits the success page (the order sits in sessionStorage, so the page
 * renders again happily). Returns true only the first time for a given order.
 */
export function claimPurchaseTracking(orderNo: string): boolean {
  if (typeof window === 'undefined') return false
  const key = `skinature-tracked-purchase-${orderNo}`
  try {
    if (window.sessionStorage.getItem(key)) return false
    window.sessionStorage.setItem(key, '1')
    return true
  } catch {
    // Private mode / storage disabled: better to send once more than never.
    return true
  }
}
