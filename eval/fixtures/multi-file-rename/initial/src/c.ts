import { getUser } from "./user";

export function exists(id: number): boolean {
  return getUser(id) !== undefined;
}
