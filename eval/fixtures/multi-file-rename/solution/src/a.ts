import { fetchUser } from "./user";

export function greet(id: number): string {
  const u = fetchUser(id);
  return u ? `Hello, ${u.name}` : "Unknown";
}
