import { fetchUser } from "./user";

export function nameOf(id: number): string {
  return fetchUser(id)?.name ?? "?";
}
