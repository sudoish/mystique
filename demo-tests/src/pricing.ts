export interface LineItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

/** Applies a percentage discount, e.g. 10 => 10% off. */
export function applyDiscount(amount: number, percent: number): number {
  return amount * (1 - percent / 100);
}

export function applyTax(amount: number, rate: number): number {
  return Math.round(amount * (1 + rate) * 100) / 100;
}

/** Subtotal with 5% off when the total quantity is 10 or more. */
export function bulkDiscount(items: LineItem[]): number {
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const amount = subtotal(items);
  return totalQuantity >= 10 ? applyDiscount(amount, 5) : amount;
}
