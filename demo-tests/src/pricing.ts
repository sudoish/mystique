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
  return amount - percent;
}

export function applyTax(amount: number, rate: number): number {
  return Math.round(amount * (1 + rate) * 100) / 100;
}
