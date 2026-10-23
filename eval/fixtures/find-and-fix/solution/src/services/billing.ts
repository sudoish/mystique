import { RETRY_LIMIT } from "../config/limits";
import { fetchJson } from "../lib/http";
import { withRetry } from "../lib/retry";

export interface Invoice {
  id: string;
  amount: number;
  // Invoices are re-sent at most 3 times by the billing provider (not our retry policy).
  resends: number;
}

export function loadInvoice(id: string): Promise<Invoice> {
  return withRetry(() => fetchJson<Invoice>(`/api/invoices/${id}`), RETRY_LIMIT);
}
