import { cartTotal, fmt, type Item } from "./cart";

const items: Item[] = [
  { name: "keyboard", price: 120, qty: 1 },
  { name: "keycaps", price: 35, qty: 2 },
  { name: "cable", price: 12.5, qty: 3 },
];

const total = cartTotal(items);
console.log("Items:", items.length);
console.log("Total:", fmt(total));
