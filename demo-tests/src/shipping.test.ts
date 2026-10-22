import { shippingCost, orderTotal, freeShippingRemaining } from "./shipping";

describe("shippingCost", () => {
  it("is free for an empty cart", () => {
    expect(shippingCost([])).toBe(0);
  });

  it("charges a flat 9.99 for small orders", () => {
    const small = [{ sku: "MUG-01", unitPrice: 15, quantity: 2 }];
    expect(shippingCost(small)).toBe(9.99);
  });

  it("is free when the subtotal reaches 100", () => {
    const big = [{ sku: "KB-01", unitPrice: 50, quantity: 2 }];
    expect(shippingCost(big)).toBe(0);
  });
});

describe("orderTotal", () => {
  it("adds shipping and tax to a small order subtotal", () => {
    const small = [{ sku: "MUG-01", unitPrice: 15, quantity: 2 }];
    // subtotal 30, +9.99 shipping = 39.99, +10% tax = 43.99
    expect(orderTotal(small, 0.1)).toBe(43.99);
  });

  it("applies the bulk discount before tax and ships free over the threshold", () => {
    const bulk = [{ sku: "PEN-01", unitPrice: 20, quantity: 10 }];
    // subtotal 200, 5% bulk discount = 190, free shipping, +10% tax = 209
    expect(orderTotal(bulk, 0.1)).toBe(209);
  });
});

describe("freeShippingRemaining", () => {
  it("returns the amount still needed to reach free shipping", () => {
    const items = [{ sku: "MUG-01", unitPrice: 15, quantity: 2 }];
    // subtotal 30, threshold 100 => 70 remaining
    expect(freeShippingRemaining(items)).toBe(70);
  });

  it("returns 0 once the subtotal meets the threshold", () => {
    const items = [{ sku: "KB-01", unitPrice: 50, quantity: 2 }];
    expect(freeShippingRemaining(items)).toBe(0);
  });

  it("is the full threshold for an empty cart", () => {
    expect(freeShippingRemaining([])).toBe(100);
  });
});
