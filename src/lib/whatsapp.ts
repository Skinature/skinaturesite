import { codDue } from '@/lib/domain'
import type { Order } from '@/lib/domain'
import { formatPaise } from '@/lib/format'

/* ────────────────────────────────────────────────────────────────────────────
 * 1. MANUAL click-to-chat (admin panel button) — no API, admin taps send.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Builds the pre-filled WhatsApp click-to-chat message for an order
 * (docs/DECISIONS.md §6: click-to-chat carries text only; the PDF invoice
 * travels by email).
 */
export function buildOrderWhatsAppUrl(order: Order): string {
  const firstName = order.customer.name.split(' ')[0]
  const itemLines = order.items
    .map((i) => `• ${i.name} × ${i.qty}`)
    .join('\n')

  const text =
    `Hello ${firstName}! 🌿\n\n` +
    `Thank you for shopping with Skinature. Here is a summary of your order ${order.orderNo}:\n\n` +
    `${itemLines}\n\n` +
    `Subtotal: ${formatPaise(order.subtotalPaise)}\n` +
    `Shipping: ${formatPaise(order.shippingPaise)}\n` +
    (order.codFeePaise > 0 ? `COD charge: ${formatPaise(order.codFeePaise)}\n` : '') +
    `Total: ${formatPaise(order.totalPaise)}\n\n` +
    (codDue(order)
      ? `This is a Cash on Delivery order. Please keep ${formatPaise(order.totalPaise)} ready to pay when it arrives.\n\n`
      : '') +
    `Your invoice has been sent to ${order.customer.email}.\n\n` +
    `Nurtured by Nature,\nTeam Skinature`

  return `https://wa.me/91${order.customer.phone}?text=${encodeURIComponent(text)}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. AUTOMATIC order notification — Meta WhatsApp Cloud API, used DIRECTLY with
 *    no BSP middleman (client explicitly rejected AiSensy/Interakt/WATI).
 *    Meta charges no monthly fee; utility messages cost ~Rs 0.115 + GST each.
 *
 *    Gated behind WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN: when either
 *    is missing every call is a graceful no-op, so a paid order NEVER fails
 *    because WhatsApp is unconfigured (same contract as the email pipeline).
 *
 *    Meta-side setup (once): Meta Business account + a dedicated number NOT
 *    active on the WhatsApp app -> create the WhatsApp app -> Phone Number ID +
 *    permanent access token -> submit the template below for approval (~1-2 days).
 * ──────────────────────────────────────────────────────────────────────────── */

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN
/** Approved template name in Meta Business Manager. */
const TEMPLATE = process.env.WHATSAPP_TEMPLATE_NAME || 'order_confirmation'
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en'
/** Same Graph version as the Conversions API (src/lib/meta-capi.ts). */
const GRAPH_VERSION = 'v26.0'
const TIMEOUT_MS = 15000
/** Keeps the items line well inside Meta's 1024-character template body limit. */
const MAX_ITEMS_CHARS = 400

export function whatsappEnabled(): boolean {
  return Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN)
}

/**
 * Indian mobiles are stored as 10 digits; WhatsApp needs full international
 * format with no '+' or separators (e.g. 919885421522).
 */
export function toWhatsAppNumber(phone: string): string | null {
  const digits = (phone || '').replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  return null
}

export type WhatsAppResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string }

/** Meta rejects template parameters containing newlines, tabs or 4+ spaces in a row. */
function cleanParam(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The ordered items on one line, since a template parameter cannot hold line
 * breaks: "Root Revival Hair Oil (x1), Bridal Kit (x2)". A very large order is
 * cut short with "and N more" rather than failing the send.
 */
export function formatItemsLine(items: Order['items']): string {
  const parts = items.map((i) => `${cleanParam(i.name)} (x${i.qty})`)
  let line = ''
  for (let n = 0; n < parts.length; n++) {
    const next = line ? `${line}, ${parts[n]}` : parts[n]
    if (next.length > MAX_ITEMS_CHARS && line) {
      return `${line} and ${parts.length - n} more`
    }
    line = next
  }
  return line
}

/** The parts of a Graph response we read: media upload id, sent message id, error. */
type GraphData = { id?: string; messages?: { id?: string }[]; error?: { message?: string } }

async function callGraph(
  path: string,
  body: BodyInit,
  json: boolean
): Promise<{ ok: true; data: GraphData } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data: GraphData = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, reason: data.error?.message ?? `HTTP ${res.status}` }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/** Uploads the invoice PDF to Meta and returns its media id for the template header. */
async function uploadInvoice(
  pdf: Buffer,
  filename: string
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', 'application/pdf')
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename)
  const res = await callGraph('media', form, false)
  if (!res.ok) return res
  const id = res.data.id
  return id ? { ok: true, id } : { ok: false, reason: 'no media id returned' }
}

/**
 * Sends the order-confirmation template, with the PDF invoice attached, to the
 * phone number the customer gave at checkout.
 *
 * The template must be registered in Meta (category UTILITY, language `en`) as:
 *   Header:   Document (the invoice PDF)
 *   Body:     Hi {{1}}, your Skinature order {{2}} has been placed successfully! 🌿
 *
 *             Items ordered: {{3}}
 *             Order total: {{4}}
 *
 *             Your invoice is attached above. Thank you for choosing Skinature.
 *   Footer:   Nurtured by Nature
 * with {{1}} first name, {{2}} order number, {{3}} items line, {{4}} order total.
 * Change the copy in Meta and these parameters must change with it.
 */
export async function sendOrderWhatsApp(order: Order, pdf: Buffer): Promise<WhatsAppResult> {
  if (!whatsappEnabled()) return { sent: false, reason: 'not-configured' }

  const to = toWhatsAppNumber(order.customer.phone)
  if (!to) return { sent: false, reason: `invalid phone: ${order.customer.phone}` }

  // Same file name as the email attachment (src/lib/email/send.ts).
  const filename = `Skinature-${order.invoiceNo ?? order.orderNo}.pdf`
  const media = await uploadInvoice(pdf, filename)
  if (!media.ok) return { sent: false, reason: `invoice upload failed: ${media.reason}` }

  const firstName = cleanParam(order.customer.name).split(' ')[0] || 'there'
  const res = await callGraph(
    'messages',
    JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: TEMPLATE,
        language: { code: TEMPLATE_LANG },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'document', document: { id: media.id, filename } }],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: firstName },
              { type: 'text', text: order.orderNo },
              { type: 'text', text: formatItemsLine(order.items) },
              { type: 'text', text: formatPaise(order.totalPaise) },
            ],
          },
        ],
      },
    }),
    true
  )
  if (!res.ok) return { sent: false, reason: res.reason }
  return { sent: true, messageId: res.data.messages?.[0]?.id ?? 'unknown' }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. AUTO-REPLY — nobody reads this number, so a customer who replies to an
 *    order message gets pointed to the real support channels. Sent from the
 *    webhook (src/app/api/webhooks/whatsapp/route.ts). It is a reply inside the
 *    24-hour window the customer just opened, so Meta does not charge for it.
 * ──────────────────────────────────────────────────────────────────────────── */

export const AUTO_REPLY_TEXT =
  'Thank you for your message! 🌿 This WhatsApp number only sends order updates, ' +
  'so replies here are not read.\n\n' +
  'For any help, email us at official.skinature@gmail.com or message us on ' +
  'Instagram @official.skinature.\n\n' +
  'Team Skinature'

/** `to` is the sender id from the webhook, already in WhatsApp's 91XXXXXXXXXX form. */
export async function sendAutoReply(to: string): Promise<WhatsAppResult> {
  if (!whatsappEnabled()) return { sent: false, reason: 'not-configured' }
  const res = await callGraph(
    'messages',
    JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: AUTO_REPLY_TEXT, preview_url: false },
    }),
    true
  )
  if (!res.ok) return { sent: false, reason: res.reason }
  return { sent: true, messageId: res.data.messages?.[0]?.id ?? 'unknown' }
}
