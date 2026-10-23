// Retry an async operation up to `attempts` times, rethrowing the last error.
export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
