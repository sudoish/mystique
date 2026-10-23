import { RETRY_LIMIT } from "../config/limits";
import { fetchJson } from "../lib/http";
import { withRetry } from "../lib/retry";

const pageSize = 3;

export function search(query: string): Promise<string[]> {
  const url = `/api/search?q=${encodeURIComponent(query)}&limit=${pageSize}`;
  return withRetry(() => fetchJson<string[]>(url), RETRY_LIMIT);
}
