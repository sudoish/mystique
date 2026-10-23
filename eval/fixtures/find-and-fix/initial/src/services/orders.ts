import { RETRY_LIMIT } from "../config/limits";
import { fetchJson } from "../lib/http";
import { withRetry } from "../lib/retry";

export interface Order {
  id: string;
  total: number;
}

export function loadOrder(id: string): Promise<Order> {
  return withRetry(() => fetchJson<Order>(`/api/orders/${id}`), RETRY_LIMIT);
}

export function listOrders(userId: string): Promise<Order[]> {
  return withRetry(() => fetchJson<Order[]>(`/api/users/${userId}/orders`), 3);
}
