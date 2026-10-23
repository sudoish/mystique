import { fetchJson } from "../lib/http";
import { withRetry } from "../lib/retry";

export interface User {
  id: string;
  name: string;
}

export function loadUser(id: string): Promise<User> {
  return withRetry(() => fetchJson<User>(`/api/users/${id}`), 3);
}
