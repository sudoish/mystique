import { getUser } from "./user";

export function nameOf(id: number): string {
  return getUser(id)?.name ?? "?";
}
