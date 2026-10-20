import { applyDiscount, applyTax, subtotal, type LineItem } from "./pricing";

const cart: LineItem[] = [
  { sku: "KB-01", unitPrice: 120, quantity: 1 },
  { sku: "CAP-02", unitPrice: 35, quantity: 2 },
];

describe("subtotal", () => {
  it("sums unit price times quantity", () => {
    expect(subtotal(cart)).toBe(190);
  });

  it("is zero for an empty cart", () => {
    expect(subtotal([])).toBe(0);
  });
});

describe("applyDiscount", () => {
  it("takes a percentage off the amount", () => {
    expect(applyDiscount(200, 10)).toBe(180);
  });
});

describe("applyTax", () => {
  it("adds tax and rounds to cents", () => {
    expect(applyTax(100, 0.0725)).toBe(107.25);
  });
});
