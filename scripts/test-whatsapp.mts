/**
 * Verifies the WhatsApp Cloud API setup end to end.
 *
 *   npx tsx scripts/test-whatsapp.mts <10-digit mobile>
 *
 * 1. checks WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are set
 * 2. renders a REAL PDF invoice from a sample order
 * 3. uploads it and sends the order_confirmation template to that number
 *
 * Needs the template APPROVED in WhatsApp Manager first. Each run is one real,
 * billed utility message (about Rs 0.15). The sample order is in memory only and
 * never written to Supabase.
 */
import { config } from 'dotenv'
import type { Order, StoreSettings } from '../src/lib/domain'

// .env.local must be loaded BEFORE whatsapp.ts is evaluated: it reads process.env
// at module scope, so the modules are imported dynamically further down.
config({ path: '.env.local' })

const phone = process.argv[2]
if (!phone) {
  console.error('Usage: npx tsx scripts/test-whatsapp.mts <10-digit mobile>')
  process.exit(1)
}

const settings: StoreSettings = {
  shippingTelanganaPaise: 6000,
  shippingRestPaise: 10000,
  businessName: 'Nurtured by Nature Products',
  businessAddress:
    'Plot No. 509-J-III, Road No. 86, Near Lotus Pond, Jubilee Hills, Hyderabad - 500096, Telangana, India',
  gstin: '36AAZFN8373Q1ZU',
  notifyEmail: 'orders@skinature.org',
}

const order: Order = {
  id: 'test-order',
  orderNo: 'SKN-TEST',
  createdAt: new Date().toISOString(),
  customer: { name: 'Test Customer', email: 'test@example.com', phone },
  address: {
    line1: 'Plot 1, Test Street',
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: '500096',
  },
  items: [
    { productId: null, name: 'Root Revival Hair Oil', qty: 1, unitPricePaise: 59900, lineTotalPaise: 59900 },
    { productId: null, name: 'Brightening & Cleansing Mask', qty: 2, unitPricePaise: 49900, lineTotalPaise: 99800 },
  ],
  subtotalPaise: 159700,
  shippingPaise: 6000,
  totalPaise: 165700,
  status: 'paid',
  paymentMethod: 'prepaid',
  codFeePaise: 0,
  codPaidAt: null,
  paymentId: 'pay_test',
  invoiceNo: 'INV-2026-TEST',
}

async function main() {
  const { whatsappEnabled, sendOrderWhatsApp, toWhatsAppNumber } = await import('../src/lib/whatsapp')
  const { renderInvoiceBuffer } = await import('../src/lib/pdf/render')

  console.log('1) configured   :', whatsappEnabled() ? 'yes' : 'NO, set WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN in .env.local')
  if (!whatsappEnabled()) process.exit(1)
  console.log('   sending to   :', toWhatsAppNumber(phone) ?? `INVALID (${phone})`)

  const pdf = await renderInvoiceBuffer(order, settings)
  console.log('2) PDF invoice  :', `${pdf.length} bytes`)

  const res = await sendOrderWhatsApp(order, pdf)
  console.log('3) send         :', res.sent ? `sent, message id ${res.messageId}` : `FAILED, ${res.reason}`)
  if (!res.sent) process.exit(1)
  console.log('\nCheck that phone: the order message with the invoice PDF attached.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
