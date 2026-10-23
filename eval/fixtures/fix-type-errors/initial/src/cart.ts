export interface Item {
  name: string;
  price: number;
  qty: number;
}

export function calc(items: Item[]): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.qty;
  }
  return total;
}

export function fmt(amount: number): string {
  return "$" + amount.toFixed(2);
}
