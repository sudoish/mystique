import { fetchUser } from "./user";

export function exists(id: number): boolean {
  return fetchUser(id) !== undefined;
}
