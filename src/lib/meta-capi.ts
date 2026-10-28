import crypto from 'node:crypto'
import { SITE_URL } from '@/lib/data'

/* ────────────────────────────────────────────────────────────────────────────
 * Meta Conversions API (CAPI): the server-side copy of the Purchase event.
 *
 * The browser pixel (src/lib/analytics.ts) already sends Purchase from the
 * success page, but ad blockers, iOS tracking limits and customers who close
 * the tab before the success page loads all lose it. This sends the same
 * Purchase from OUR server the moment an order is marked paid, so Meta still
 * sees the sale.
 *
 * Deduplication: both copies carry event_name "Purchase" and the same event id,
 * the order number (SKN-1234). The browser passes it as `eventID`, we pass it
 * as `event_id`, and Meta keeps one and drops the other. Change one side and
 * revenue in Ads Manager doubles.
 *
 * Gated behind META_CAPI_ACCESS_TOKEN + NEXT_PUBLIC_META_PIXEL_ID: when either
 * is missing every call is a graceful no-op. Like email and WhatsApp, a CAPI
 * failure must NEVER fail a paid order, so nothing here throws.
 *
 * The token is a system-user token created in Events Manager for this dataset
 * only (send events, nothing else). It is a SECRET: Vercel env only, never in
 * the repo, never in the browser (no NEXT_PUBLIC_ prefix).
 * ──────────────────────────────────────────────────────────────────────────── */

const ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN
/** Same dataset as the browser pixel, so both copies land in one place. */
const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID
/**
 * Events Manager -> dataset -> Test events -> "test_event_code". While set,
 * events show ONLY in that Test events tab and do not count for ads. Use it
 * for verification, then REMOVE it, or live purchases stop being counted.
 */
const TEST_EVENT_CODE = process.env.META_CAPI_TEST_EVENT_CODE
const GRAPH_VERSION = 'v26.0'
const TIMEOUT_MS = 5000

export function metaCapiEnabled(): boolean {
  return Boolean(ACCESS_TOKEN && PIXEL_ID)
}

/** What only the customer's browser knows, captured on the verify request. */
export interface BrowserContext {
  ip?: string | null
  userAgent?: string | null
  /** `_fbp` cookie: Meta's browser id, set by the pixel. */
  fbp?: string | null
  /** `_fbc` cookie: the ad click id, set when the visitor arrived from an ad. */
  fbc?: string | null
  /** Page the purchase happened on. */
  sourceUrl?: string | null
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * Pulls the browser context off an incoming request. Only meaningful for a
 * request the CUSTOMER'S browser made (the Razorpay verify call); a Razorpay
 * webhook would report Razorpay's server instead, so the webhook passes none.
 */
export function browserContextFrom(request: Request): BrowserContext {
  const h = request.headers
  // Vercel puts the real client first in x-forwarded-for.
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null
  const cookie = h.get('cookie')
  const referer = h.get('referer')
  return {
    ip,
    userAgent: h.get('user-agent'),
    fbp: readCookie(cookie, '_fbp'),
    fbc: readCookie(cookie, '_fbc'),
    sourceUrl: referer && /^https?:\/\//.test(referer) ? referer : null,
  }
}

/** SHA-256 hex of an already-normalised value, as Meta requires for PII. */
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** Meta's normalisation for names/city/state: lowercase, letters and digits only. */
function compact(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Indian mobiles are stored as 10 digits; Meta wants the country code, digits only. */
function toE164Digits(phone: string): string | null {
  const digits = (phone || '').replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 12 && digits.startsWith('91')) return digits
  return null
}

export interface CapiPurchase {
  orderNo: string
  customerId?: string | null
  customer: { name: string; email: string; phone: string }
  address: { city: string; state: string; pincode: string }
  items: { productId: string; qty: number; unitPricePaise: number }[]
  totalPaise: number
}

export type CapiResult =
  | { sent: true; eventsReceived: number; fbtraceId: string }
  | { sent: false; reason: string }

export function buildPurchaseEvent(purchase: CapiPurchase, browser: BrowserContext = {}) {
  const nameParts = purchase.customer.name.trim().split(/\s+/).map(compact).filter(Boolean)
  const phone = toE164Digits(purchase.customer.phone)
  const email = purchase.customer.email.trim().toLowerCase()

  // Every customer-identifying field is hashed. ip, user agent, fbp and fbc
  // must NOT be hashed: Meta matches them as-is.
  const userData: Record<string, unknown> = {
    country: [sha256('in')],
  }
  if (email) userData.em = [sha256(email)]
  if (phone) userData.ph = [sha256(phone)]
  if (nameParts[0]) userData.fn = [sha256(nameParts[0])]
  if (nameParts.length > 1) userData.ln = [sha256(nameParts[nameParts.length - 1])]
  if (purchase.address.city) userData.ct = [sha256(compact(purchase.address.city))]
  if (purchase.address.state) userData.st = [sha256(compact(purchase.address.state))]
  if (purchase.address.pincode) userData.zp = [sha256(purchase.address.pincode.replace(/\s/g, ''))]
  if (purchase.customerId) userData.external_id = [sha256(purchase.customerId)]
  if (browser.ip) userData.client_ip_address = browser.ip
  if (browser.userAgent) userData.client_user_agent = browser.userAgent
  if (browser.fbp) userData.fbp = browser.fbp
  if (browser.fbc) userData.fbc = browser.fbc

  return {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    // MUST equal the browser's eventID (trackPurchase in analytics.ts) for dedup.
    event_id: purchase.orderNo,
    action_source: 'website',
    event_source_url: browser.sourceUrl || `${SITE_URL}/checkout`,
    user_data: userData,
    custom_data: {
      currency: 'INR',
      // Rupees, not paise, matching the browser event (see toRupees in analytics.ts).
      value: Math.round(purchase.totalPaise) / 100,
      order_id: purchase.orderNo,
      content_type: 'product',
      content_ids: purchase.items.map((i) => i.productId),
      contents: purchase.items.map((i) => ({
        id: i.productId,
        quantity: i.qty,
        item_price: Math.round(i.unitPricePaise) / 100,
      })),
      num_items: purchase.items.reduce((n, i) => n + i.qty, 0),
    },
  }
}

export async function sendPurchaseEvent(
  purchase: CapiPurchase,
  browser: BrowserContext = {}
): Promise<CapiResult> {
  if (!metaCapiEnabled()) return { sent: false, reason: 'not configured' }
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Token in the body, not the URL, so it never lands in request logs.
      body: JSON.stringify({
        data: [buildPurchaseEvent(purchase, browser)],
        access_token: ACCESS_TOKEN,
        ...(TEST_EVENT_CODE ? { test_event_code: TEST_EVENT_CODE } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { sent: false, reason: data?.error?.message ?? `HTTP ${res.status}` }
    }
    return {
      sent: true,
      eventsReceived: data?.events_received ?? 0,
      fbtraceId: data?.fbtrace_id ?? 'unknown',
    }
  } catch (err) {
    return { sent: false, reason: (err as Error).message }
  }
}
