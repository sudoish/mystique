import { getUser } from "./user";

export function greet(id: number): string {
  const u = getUser(id);
  return u ? `Hello, ${u.name}` : "Unknown";
}
