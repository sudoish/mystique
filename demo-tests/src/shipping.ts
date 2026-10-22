import { subtotal, bulkDiscount, applyTax, type LineItem } from "./pricing";

const FLAT_RATE = 9.99;
const FREE_SHIPPING_THRESHOLD = 100;

export function shippingCost(items: LineItem[]): number {
  if (items.length === 0) return 0;
  if (subtotal(items) >= FREE_SHIPPING_THRESHOLD) return 0;
  return FLAT_RATE;
}

/** How much more a customer must spend to unlock free shipping (0 if already free). */
export function freeShippingRemaining(items: LineItem[]): number {
  return Math.max(0, FREE_SHIPPING_THRESHOLD - subtotal(items));
}

/** Grand total: bulk-discounted subtotal plus shipping, with tax applied. */
export function orderTotal(items: LineItem[], taxRate: number): number {
  const discounted = bulkDiscount(items);
  return applyTax(discounted + shippingCost(items), taxRate);
}
