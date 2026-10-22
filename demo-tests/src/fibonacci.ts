/** Returns the nth Fibonacci number (0-indexed): 0, 1, 1, 2, 3, 5, ... */
export function fibonacci(n: number): number {
  if (n < 0) throw new RangeError("n must be non-negative");
  let [prev, curr] = [0, 1];
  for (let i = 0; i < n; i++) {
    [prev, curr] = [curr, prev + curr];
  }
  return prev;
}
