import { fibonacci } from "./fibonacci";

describe("fibonacci", () => {
  it("returns 0 for n = 0", () => {
    expect(fibonacci(0)).toBe(0);
  });

  it("returns 1 for n = 1", () => {
    expect(fibonacci(1)).toBe(1);
  });

  it("returns the sum of the two previous terms", () => {
    expect(fibonacci(2)).toBe(1);
    expect(fibonacci(5)).toBe(5);
    expect(fibonacci(10)).toBe(55);
  });

  it("throws on negative input", () => {
    expect(() => fibonacci(-1)).toThrow();
  });
});
