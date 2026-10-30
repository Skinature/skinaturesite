import { getSupabaseService } from '@/lib/supabase/server'
import { emailEnabled, sendOrderEmails } from '@/lib/email/send'
import { whatsappEnabled, sendOrderWhatsApp } from '@/lib/whatsapp'
import { SITE_URL } from '@/lib/data'
import { renderInvoiceBuffer } from '@/lib/pdf/render'
import { metaCapiEnabled, sendPurchaseEvent } from '@/lib/meta-capi'
import type { BrowserContext } from '@/lib/meta-capi'
import { rowToOrder, rowToSettings, ORDER_SELECT } from '@/lib/db/mappers'
import type { OrderRow, SettingsRow } from '@/lib/db/mappers'

/**
 * Marks a pending order paid and runs every post-payment side effect exactly once:
 * the atomic status transition, stock decrement, 21-day review invites, the
 * confirmation email + PDF invoice, and the Meta Conversions API Purchase. Shared by the mock confirm route, the Razorpay
 * signature-verify route, and the Razorpay webhook so all three land identical state.
 *
 * Idempotent: the paid transition is guarded by `status = 'pending'`, so whichever
 * caller wins runs the side effects and any later caller (a webhook racing the
 * browser verify, a retry) returns the same snapshot with `alreadyPaid: true` and
 * touches nothing. The invoice number is derived from the order number, so every
 * caller computes the same value.
 */

const REVIEW_INVITE_DELAY_DAYS = 21

export interface OrderSnapshot {
  /** Business order number, e.g. "SKN-1101" (used by the success page + as `order.id`). */
  id: string
  createdAt: string
  customer: { name: string; email: string; phone: string }
  address: { line1: string; line2?: string; city: string; state: string; pincode: string }
  items: { productId: string; name: string; image: string; qty: number; unitPricePaise: number }[]
  subtotalPaise: number
  shippingPaise: number
  totalPaise: number
  invoiceNo: string
}

export type FinalizeResult =
  | { ok: true; alreadyPaid: boolean; order: OrderSnapshot }
  | { ok: false; status: number; error: string }

type ItemRow = {
  product_id: string | null
  name_snapshot: string
  qty: number
  unit_price_paise: number
}
type CustomerJoin = { email: string; full_name: string; phone: string } | null

export async function finalizePaidOrder(params: {
  orderId: string
  provider: 'mock' | 'razorpay'
  paymentId?: string | null
  signature?: string | null
  /** The customer's browser details, for Meta CAPI matching. Absent on webhooks. */
  browser?: BrowserContext
}): Promise<FinalizeResult> {
  const { orderId, provider, paymentId, signature, browser } = params
  const db = getSupabaseService()

  const { data: order, error: orderError } = await db
    .from('orders')
    .select(
      'id, order_no, customer_id, status, subtotal_paise, shipping_paise, total_paise, ship_name, ship_line1, ship_line2, ship_city, ship_state, ship_pincode, created_at, customers ( email, full_name, phone ), order_items ( product_id, name_snapshot, qty, unit_price_paise )'
    )
    .eq('id', orderId)
    .maybeSingle()

  if (orderError || !order) return { ok: false, status: 404, error: 'Order not found.' }

  const invoiceNo = `INV-2026-${order.order_no.replace('SKN-', '')}`
  const items = (order.order_items ?? []) as ItemRow[]
  const customer = order.customers as unknown as CustomerJoin

  // Product images for the confirmation snapshot (also gives us stock for the decrement).
  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))] as string[]
  const { data: productRows } = await db
    .from('products')
    .select('id, stock, image')
    .in('id', productIds)
  const productInfo = new Map((productRows ?? []).map((p) => [p.id, p]))

  const snapshot: OrderSnapshot = {
    id: order.order_no,
    createdAt: order.created_at,
    customer: {
      name: customer?.full_name ?? order.ship_name,
      email: customer?.email ?? '',
      phone: customer?.phone ?? '',
    },
    address: {
      line1: order.ship_line1,
      line2: order.ship_line2 ?? undefined,
      city: order.ship_city,
      state: order.ship_state,
      pincode: order.ship_pincode,
    },
    items: items.map((it) => ({
      productId: it.product_id ?? '',
      name: it.name_snapshot,
      image: (it.product_id && productInfo.get(it.product_id)?.image) || '',
      qty: it.qty,
      unitPricePaise: it.unit_price_paise,
    })),
    subtotalPaise: order.subtotal_paise,
    shippingPaise: order.shipping_paise,
    totalPaise: order.total_paise,
    invoiceNo,
  }

  // Already finalized (a webhook after browser verify, a retry, etc.) → no side effects.
  if (order.status !== 'pending') {
    if (order.status === 'cancelled') {
      return { ok: false, status: 409, error: 'Order is not awaiting payment.' }
    }
    return { ok: true, alreadyPaid: true, order: snapshot }
  }

  // ── atomic paid transition (only one caller wins the pending → paid flip) ──
  const resolvedPaymentId =
    paymentId ?? (provider === 'mock' ? `pay_mock_${order.order_no.replace('SKN-', '')}` : null)

  const { data: transitioned, error: updateError } = await db
    .from('orders')
    .update({
      status: 'paid',
      payment_provider: provider,
      payment_id: resolvedPaymentId,
      razorpay_signature: signature ?? null,
      invoice_no: invoiceNo,
    })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select('id')

  if (updateError) return { ok: false, status: 500, error: 'Could not update order.' }

  // Lost the race: another caller already finalized. Return the same snapshot, no side effects.
  if (!transitioned || transitioned.length === 0) {
    return { ok: true, alreadyPaid: true, order: snapshot }
  }

  // ── decrement stock ──
  for (const item of items) {
    if (!item.product_id) continue
    const info = productInfo.get(item.product_id)
    if (info) {
      await db
        .from('products')
        .update({ stock: Math.max(0, info.stock - item.qty) })
        .eq('id', item.product_id)
    }
  }

  // ── review invites (auto-sent by scheduler 21 days after order, per DECISIONS §6.7) ──
  if (productIds.length > 0) {
    const sendAfter = new Date(Date.now() + REVIEW_INVITE_DELAY_DAYS * 24 * 60 * 60 * 1000)
    await db.from('review_invites').insert(
      productIds.map((productId) => ({
        order_id: order.id,
        product_id: productId,
        send_after: sendAfter.toISOString(),
      }))
    )
  }

  // ── Meta Conversions API: the server copy of Purchase, deduped on the order no. ──
  // Started now and awaited at the end so it runs alongside the slower email.
  // sendMetaPurchase never throws; a failure is only logged.
  const capi = sendMetaPurchase(order.id, order.customer_id, snapshot, browser)

  // ── customer notifications: email + PDF invoice, and the WhatsApp message ──
  // Both are gated and both are wrapped: a notification failure must NEVER fail a
  // paid order (the money is already taken and the DB is already consistent).
  if (emailEnabled() || whatsappEnabled()) {
    try {
      const [{ data: fullOrder }, { data: settingsRow }] = await Promise.all([
        db.from('orders').select(ORDER_SELECT).eq('id', order.id).single(),
        db.from('site_settings').select('*').single(),
      ])
      if (fullOrder && settingsRow) {
        const domainOrder = rowToOrder(fullOrder as unknown as OrderRow)
        const settings = rowToSettings(settingsRow as SettingsRow)

        if (emailEnabled()) {
          try {
            const pdf = await renderInvoiceBuffer(domainOrder, settings)
            await sendOrderEmails(domainOrder, settings, pdf)
          } catch (err) {
            console.error('[finalize] order email failed:', err)
          }
        }

        if (whatsappEnabled()) {
          try {
            const invoiceUrl = `${SITE_URL}/checkout/success?order=${domainOrder.orderNo}`
            const res = await sendOrderWhatsApp(domainOrder, invoiceUrl)
            if (!res.sent) console.error('[finalize] whatsapp not sent:', res.reason)
          } catch (err) {
            console.error('[finalize] whatsapp failed:', err)
          }
        }
      }
    } catch (err) {
      console.error('[finalize] notifications failed:', err)
    }
  }

  await capi

  return { ok: true, alreadyPaid: false, order: snapshot }
}

/**
 * Sends the Conversions API Purchase using the browser details saved at checkout,
 * since the Razorpay webhook usually gets here first and has none of its own, then
 * clears them so customer IPs are not kept longer than needed. The separate read
 * keeps this column out of the query a paid order depends on.
 */
export async function sendMetaPurchase(
  orderId: string,
  customerId: string,
  snapshot: OrderSnapshot,
  browser?: BrowserContext
): Promise<void> {
  try {
    const db = getSupabaseService()
    if (metaCapiEnabled()) {
      const { data } = await db
        .from('orders')
        .select('browser_context')
        .eq('id', orderId)
        .maybeSingle()
      const res = await sendPurchaseEvent(
        {
          orderNo: snapshot.id,
          customerId,
          customer: snapshot.customer,
          address: snapshot.address,
          items: snapshot.items,
          totalPaise: snapshot.totalPaise,
        },
        browser ?? (data?.browser_context as BrowserContext | null) ?? undefined
      )
      if (res.sent) console.log(`[finalize] meta capi purchase sent ${snapshot.id}`)
      else console.error(`[finalize] meta capi purchase not sent ${snapshot.id}:`, res.reason)
    }
    await db.from('orders').update({ browser_context: null }).eq('id', orderId)
  } catch (err) {
    console.error(`[finalize] meta capi purchase failed ${snapshot.id}:`, err)
  }
}
