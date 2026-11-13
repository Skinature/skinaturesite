/** Domain types shared by the storefront, admin, and API routes. */

/**
 * 'cod' = a Cash on Delivery order that is confirmed but not dispatched yet.
 * Prepaid orders never use it.
 */
export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'cod'

export type PaymentMethod = 'prepaid' | 'cod'

export interface OrderItem {
  productId: string | null
  name: string
  qty: number
  unitPricePaise: number
  lineTotalPaise: number
}

export interface Order {
  /** Database uuid. */
  id: string
  /** Human/business identifier, e.g. "SKN-1101". Used in URLs and displays. */
  orderNo: string
  createdAt: string
  customer: { name: string; email: string; phone: string }
  address: {
    line1: string
    line2?: string
    city: string
    state: string
    pincode: string
  }
  items: OrderItem[]
  subtotalPaise: number
  shippingPaise: number
  /** Includes codFeePaise when the order is Cash on Delivery. */
  totalPaise: number
  status: OrderStatus
  paymentMethod: PaymentMethod
  /** Extra charged for Cash on Delivery; 0 on prepaid orders. */
  codFeePaise: number
  /** When the admin recorded the COD cash as received; null until then. */
  codPaidAt: string | null
  paymentId: string | null
  invoiceNo: string | null
}

/** True while a Cash on Delivery order's money has not reached the business yet. */
export function codDue(order: Pick<Order, 'paymentMethod' | 'codPaidAt' | 'status'>): boolean {
  return order.paymentMethod === 'cod' && !order.codPaidAt && order.status !== 'cancelled'
}

export interface CustomerSummary {
  name: string
  email: string
  phone: string
  city: string
  state: string
  ordersCount: number
  totalSpendPaise: number
  firstOrderAt: string
  lastOrderAt: string
}

export type ReviewStatus = 'pending' | 'approved' | 'hidden'

export interface Review {
  id: string
  productId: string
  author: string
  rating: number
  body: string
  createdAt: string
  verified: boolean
  status: ReviewStatus
}

export interface ReviewInvite {
  id: string
  orderId: string
  productId: string
  productName: string
  token: string
  sendAfter: string
  sentAt: string | null
  usedAt: string | null
}

export interface StoreSettings {
  shippingTelanganaPaise: number
  shippingRestPaise: number
  businessName: string
  businessAddress: string
  gstin: string
  notifyEmail: string
}
